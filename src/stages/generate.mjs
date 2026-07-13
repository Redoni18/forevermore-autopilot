/**
 * @file `generate` stage. Fills copy (caption/hashtags/overlays) for the slot
 * date's planned candidates via the injected BrainDriver (fixture by default).
 * Transitions planned → drafting → drafted. Also completes items left in
 * `drafting` by a prior crash or a `regen`/QA bounce. Idempotent + resumable.
 */

import { loadIdeas } from '../plan/ideas.mjs';
import { isoDatePart } from '../util/time.mjs';
import { transitionItem } from '../state/machine.mjs';
import { describeSources } from '../brain/assemble.mjs';

/** id → idea payload. */
function indexIdeas(ideas) {
  const m = {};
  for (const i of ideas) m[i.id] = i;
  return m;
}

/**
 * Build a copywriter StageRequest understood by BOTH the built-in fixture and
 * AP-301's drivers (PRD §8.2). The fixture reads `item`/`idea`; AP-301 reads
 * `schema` (to select+validate the copywriter schema) and `inputs`
 * (idea/formatSpec/variant — variant makes the 3 candidates distinct).
 * @param {import('../types.mjs').ContentItem} item @param {Object|null} idea
 * @param {import('../brain/schema.mjs').PlaybookRule[]} [playbookRules] Active
 *   learned rules (weight-desc) — assemble.mjs renders them so the brain obeys
 *   and cites them; the copywriter cites their ids in rationale (AP-831).
 */
function copywriterRequest(item, idea, playbookRules = []) {
  const tail = Number(String(item.id).split('_').pop());
  const variant = Number.isFinite(tail) && tail > 0 ? tail - 1 : 0;
  // Owner feedback from a changes_requested decision (review station embeds
  // it on the item; cmdRegen stores regen_note) is injected as
  // `inputs.feedback` — assemble.mjs renders it as a "Feedback to address"
  // block, so the re-draft actually responds to the human note (AP-815 fix).
  const feedback = [];
  if (item.feedback && item.feedback.note) feedback.push(item.feedback.note);
  if (item.feedback && Array.isArray(item.feedback.reason_tags) && item.feedback.reason_tags.length) {
    feedback.push(`owner reason tags: ${item.feedback.reason_tags.join(', ')}`);
  }
  if (item.regen_note) feedback.push(item.regen_note);
  return {
    stage: 'copywriter',
    schema: 'copywriter',
    item,
    idea,
    context: {},
    inputs: {
      idea,
      formatSpec: { platform: item.platform, format: item.format },
      variant,
      ...(playbookRules.length ? { playbookRules } : {}),
      ...(feedback.length ? { feedback } : {}),
    },
  };
}

/**
 * Rewrite `rationale.strategy.playbook_rules` from the model's cited IDS into the
 * self-contained `[{id, rule}]` contract shape, joining each id → rule text via
 * the active-rule index. Unknown ids (hallucinated citations) are dropped so the
 * stored log only carries rules that were genuinely in play. Idempotent: an entry
 * already shaped `{id, rule}` is kept as-is. Returns the rationale unchanged when
 * it isn't the expected shape.
 * @param {Object} rationale @param {Map<string,string>} ruleIndex id → rule text
 */
function joinRationaleRules(rationale, ruleIndex) {
  if (!rationale || typeof rationale !== 'object') return rationale;
  const strat = rationale.strategy;
  if (!strat || typeof strat !== 'object' || !Array.isArray(strat.playbook_rules)) return rationale;
  const cited = [];
  const seen = new Set();
  for (const entry of strat.playbook_rules) {
    const id = typeof entry === 'string' ? entry : entry && entry.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rule = ruleIndex.get(id);
    if (rule) cited.push({ id, rule });
    else if (entry && typeof entry === 'object' && entry.rule) cited.push({ id, rule: entry.rule });
    // else: an id we can't resolve → drop it (keep the stored log self-contained).
  }
  return { ...rationale, strategy: { ...strat, playbook_rules: cited } };
}

/**
 * Normalize per-call model usage from either driver envelope (AP-301's flat
 * `{tokensIn,…}` StageResult or the fixture's nested `meta`) so the generate run
 * can carry real provenance (model / tokens / cost / prompt_sha) for the API.
 * @param {Object} result
 */
function usageFrom(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.meta && typeof result.meta === 'object') {
    const m = result.meta;
    return {
      tokensIn: Number(m.tokens_in) || 0,
      tokensOut: Number(m.tokens_out) || 0,
      costUsd: Number(m.cost_usd) || 0,
      model: m.model ?? null,
      promptSha: m.prompt_sha ?? null,
    };
  }
  return {
    tokensIn: Number(result.tokensIn) || 0,
    tokensOut: Number(result.tokensOut) || 0,
    costUsd: Number(result.costUsd) || 0,
    model: result.model ?? null,
    promptSha: result.promptSha ?? null,
  };
}

/** Normalize either envelope: AP-301 `{ ok, data:{…} }` or the flat fixture shape. */
function copyFrom(result) {
  if (result && result.ok === false) {
    throw new Error(`brain produced invalid output: ${result.error || 'schema-invalid'}`);
  }
  return result && typeof result.data === 'object' && result.data ? result.data : result || {};
}

/** @param {Object} ctx */
export async function generateStage(ctx) {
  const { config, store, date, dryRun, log, runId, brain } = ctx;
  if (!brain) throw new Error('generate: no brain driver injected');

  const ideaIndex = indexIdeas(loadIdeas(config.resolved.ideas));

  // Active playbook rules, loaded ONCE and injected into every candidate's
  // request (PRD §8.1 designed layer). `ruleIndex` joins a cited id → rule text
  // when persisting the copywriter's rationale (AP-831). Missing method / read
  // failure degrades gracefully to "no rules" — generation must never be blocked
  // by the learning layer.
  let playbookRules = [];
  try {
    if (typeof store.listPlaybookRules === 'function') {
      playbookRules = (await store.listPlaybookRules('active')) || [];
    }
  } catch (err) {
    await log({ event: 'generate.playbook_load_failed', error: String(err && err.message ? err.message : err) });
  }
  playbookRules.sort((a, b) => (b.weight ?? 5) - (a.weight ?? 5));
  const ruleIndex = new Map(playbookRules.filter((r) => r && r.id).map((r) => [r.id, r.rule]));
  if (playbookRules.length) {
    await log({ event: 'generate.playbook_rules', count: playbookRules.length, ids: [...ruleIndex.keys()] });
  }

  const targets = (await store.listByStatus(['planned', 'drafting'])).filter(
    (i) => isoDatePart(i.slot_at) === date,
  );

  let drafted = 0;
  const errors = [];
  // Aggregate model usage across this run's candidates so item.provenance
  // (joined from the producing run) carries real numbers (AP-831 / PRD §1.5).
  const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0, model: null, promptSha: null, any: false };
  for (const item of targets) {
    if (dryRun) {
      await log({ event: 'generate.dry_run', id: item.id, idea: item.idea_id });
      continue;
    }
    try {
      const idea = item.idea_id ? ideaIndex[item.idea_id] : null;
      let cur = item;
      if (cur.status === 'planned') {
        cur = await transitionItem(store, {
          item: cur,
          to: 'drafting',
          stage: 'generate',
          runId,
          patch: { produced_by: runId },
        });
      }
      const req = copywriterRequest(cur, idea, playbookRules);
      const result = await brain.complete(req);
      const data = copyFrom(result);
      const u = usageFrom(result);
      if (u) {
        usage.any = true;
        usage.tokensIn += u.tokensIn;
        usage.tokensOut += u.tokensOut;
        usage.costUsd += u.costUsd;
        usage.model = u.model ?? usage.model;
        usage.promptSha = u.promptSha ?? usage.promptSha;
      }
      const patch = {
        caption: data.caption ?? cur.caption,
        hashtags: data.hashtags ?? cur.hashtags,
        overlays: { ...(cur.overlays || {}), ...(data.overlays || {}) },
        produced_by: runId,
      };
      // The thinking log: cite-by-id → self-contained [{id, rule}], persisted on
      // the item. Only set when the brain supplied one (backward-compatible).
      if (data.rationale && typeof data.rationale === 'object') {
        patch.rationale = joinRationaleRules(data.rationale, ruleIndex);
      }
      // The source log (AP-833): what THIS draft pulled from — knowledge files,
      // the stage skill, injected rules, idea, feedback — merged over the
      // planner's `sources.plan` layer. Best-effort by contract: a source-log
      // failure must never block a draft.
      try {
        const generation = describeSources(req);
        generation.prompt_sha = u?.promptSha ?? null;
        patch.sources = { ...(cur.sources || {}), generation };
      } catch { /* sources are advisory — never fatal */ }
      cur = await transitionItem(store, { item: cur, to: 'drafted', stage: 'generate', runId, patch });
      drafted++;
      await log({
        event: 'generate.drafted',
        id: cur.id,
        idea: cur.idea_id,
        driver: brain.name,
        cited_rules: patch.rationale?.strategy?.playbook_rules?.map((r) => r.id) ?? [],
      });
    } catch (err) {
      errors.push(item.id);
      await log({ event: 'generate.error', id: item.id, error: String(err && err.message ? err.message : err) });
    }
  }

  // Stamp the run with aggregate provenance (best-effort; never fails the stage).
  if (usage.any || usage.model || usage.promptSha) {
    try {
      await store.updateRun(runId, {
        model: usage.model ?? undefined,
        prompt_sha: usage.promptSha ?? undefined,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        cost_usd: Number(usage.costUsd.toFixed(4)),
      });
    } catch (err) {
      await log({ event: 'generate.run_usage_failed', error: String(err && err.message ? err.message : err) });
    }
  }

  await log({ event: 'generate.done', drafted, targets: targets.length, errors: errors.length });
  if (errors.length) throw new Error(`generate: ${errors.length} item(s) errored: ${errors.join(', ')}`);
  return { produced: drafted };
}
