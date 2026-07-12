/**
 * @file `generate` stage. Fills copy (caption/hashtags/overlays) for the slot
 * date's planned candidates via the injected BrainDriver (fixture by default).
 * Transitions planned → drafting → drafted. Also completes items left in
 * `drafting` by a prior crash or a `regen`/QA bounce. Idempotent + resumable.
 */

import { loadIdeas } from '../plan/ideas.mjs';
import { isoDatePart } from '../util/time.mjs';
import { transitionItem } from '../state/machine.mjs';

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
 */
function copywriterRequest(item, idea) {
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
      ...(feedback.length ? { feedback } : {}),
    },
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
  const targets = (await store.listByStatus(['planned', 'drafting'])).filter(
    (i) => isoDatePart(i.slot_at) === date,
  );

  let drafted = 0;
  const errors = [];
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
      const result = await brain.complete(copywriterRequest(cur, idea));
      const data = copyFrom(result);
      const patch = {
        caption: data.caption ?? cur.caption,
        hashtags: data.hashtags ?? cur.hashtags,
        overlays: { ...(cur.overlays || {}), ...(data.overlays || {}) },
        produced_by: runId,
      };
      cur = await transitionItem(store, { item: cur, to: 'drafted', stage: 'generate', runId, patch });
      drafted++;
      await log({ event: 'generate.drafted', id: cur.id, idea: cur.idea_id, driver: brain.name });
    } catch (err) {
      errors.push(item.id);
      await log({ event: 'generate.error', id: item.id, error: String(err && err.message ? err.message : err) });
    }
  }

  await log({ event: 'generate.done', drafted, targets: targets.length, errors: errors.length });
  if (errors.length) throw new Error(`generate: ${errors.length} item(s) errored: ${errors.join(', ')}`);
  return { produced: drafted };
}
