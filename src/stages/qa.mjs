/**
 * @file `qa` stage. Runs the injected lint fn (no-op passes by default; real
 * engine = AP-401) over the slot date's rendered candidates. Pass → pending_review.
 * Fail → qa_failed, then the retry policy bounces it back to drafting (attempt+1)
 * up to `qa_max_attempts`, else skipped. Idempotent (only acts on `rendered`).
 */

import { isoDatePart } from '../util/time.mjs';
import { transitionItem, qaFailNext } from '../state/machine.mjs';

/** @param {Object} ctx */
export async function qaStage(ctx) {
  const { config, store, date, dryRun, log, runId, lintFn } = ctx;
  if (!lintFn) throw new Error('qa: no lint fn injected');
  // lintFn receives (item, ctx) — the brand-lint bridge needs store/config
  // to build the dedupe corpus; simpler lint fns may ignore the second arg.

  const maxAttempts = config.retry.qa_max_attempts;
  const targets = (await store.listByStatus('rendered')).filter((i) => isoDatePart(i.slot_at) === date);

  let passed = 0;
  let failed = 0;
  const errors = [];
  for (const item of targets) {
    if (dryRun) {
      await log({ event: 'qa.dry_run', id: item.id });
      continue;
    }
    try {
      const result = await lintFn(item, ctx);
      const lint = result ? { passed: !!result.passed, violations: result.violations || [] } : null;
      const patch = { lint };
      if (result && result.dedupe) patch.dedupe = result.dedupe;
      if (lint && lint.passed) {
        await transitionItem(store, { item, to: 'pending_review', stage: 'qa', runId, patch });
        passed++;
        await log({ event: 'qa.pass', id: item.id });
      } else {
        let cur = await transitionItem(store, { item, to: 'qa_failed', stage: 'qa', runId, patch });
        const next = qaFailNext(cur, maxAttempts);
        cur = await transitionItem(store, { item: cur, to: next.to, stage: 'qa', runId, patch: next.patch });
        failed++;
        await log({
          event: 'qa.fail',
          id: item.id,
          next: next.to,
          attempt: cur.attempt,
          violations: (lint && lint.violations) || [],
        });
      }
    } catch (err) {
      errors.push(item.id);
      await log({ event: 'qa.error', id: item.id, error: String(err && err.message ? err.message : err) });
    }
  }

  await log({ event: 'qa.done', passed, failed, targets: targets.length, errors: errors.length });
  if (errors.length) throw new Error(`qa: ${errors.length} item(s) errored: ${errors.join(', ')}`);
  return { produced: passed };
}
