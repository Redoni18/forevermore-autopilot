/**
 * @file The content-pipeline state machine (PRD §6.1).
 *
 * An explicit transition table + guarded retry policy. The table is the single
 * source of truth for what is legal; `transitionItem()` enforces it, performs
 * the store CAS, and appends a runs record for the transition (PRD §6.1:
 * "Every transition writes a runs row").
 *
 *   planned → drafting → drafted → rendering → rendered ─┬→ pending_review
 *                                                         └→ qa_failed ─┬→ drafting (attempt+1, ≤3)
 *                                                                        └→ skipped
 *   pending_review ─┬→ approved → scheduled → publishing ─┬→ published → measured → archived
 *                   ├→ changes_requested ─┬→ drafting (regen, ≤2)
 *                   │                      └→ skipped
 *                   └→ skipped (rejected)  └→ publish_failed → publishing (retry ×3, backoff 2^n·5m)
 */

import { IllegalTransitionError } from '../types.mjs';
import { nowISO } from '../util/time.mjs';

/**
 * Allowed transitions: `TRANSITIONS[from]` is the set of legal `to` states.
 * @type {Record<string, string[]>}
 */
export const TRANSITIONS = {
  planned: ['drafting', 'skipped'],
  drafting: ['drafted', 'skipped'],
  drafted: ['rendering', 'skipped'],
  rendering: ['rendered', 'skipped'],
  rendered: ['pending_review', 'qa_failed'],
  qa_failed: ['drafting', 'skipped'],
  pending_review: ['approved', 'changes_requested', 'skipped'],
  changes_requested: ['drafting', 'skipped'],
  approved: ['scheduled', 'skipped'],
  scheduled: ['publishing', 'skipped'],
  publishing: ['published', 'publish_failed'],
  publish_failed: ['publishing', 'skipped'],
  published: ['measured'],
  measured: ['archived'],
  skipped: [],
  archived: [],
};

/** States with no outgoing transitions. */
export const TERMINAL = Object.freeze(
  Object.entries(TRANSITIONS)
    .filter(([, tos]) => tos.length === 0)
    .map(([s]) => s),
);

/** @param {string} from @param {string} to @returns {boolean} */
export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Throws {@link IllegalTransitionError} if `from → to` is not in the table. */
export function assertLegal(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/* --------------------------- retry / backoff policy --------------------------- */

/**
 * Publish retry backoff: delay for the n-th retry (1-based) = 2^n · base minutes.
 * With base=5 → 10m, 20m, 40m. (PRD §6.1 "retry ×3, backoff 2^n·5m".)
 * @param {number} n 1-based retry number @param {number} [baseMin]
 * @returns {number} milliseconds
 */
export function publishBackoffMs(n, baseMin = 5) {
  return Math.pow(2, n) * baseMin * 60000;
}

/**
 * Decide the transition OUT of `qa_failed`. Bounces back to drafting for
 * another attempt until `maxAttempts` is reached, then skips.
 * `item.attempt` is 1-based and counts draft/QA attempts.
 * @param {import('../types.mjs').ContentItem} item @param {number} maxAttempts
 * @returns {{to:'drafting'|'skipped', patch:Object}}
 */
export function qaFailNext(item, maxAttempts) {
  if ((item.attempt || 1) < maxAttempts) {
    return { to: 'drafting', patch: { attempt: (item.attempt || 1) + 1 } };
  }
  return { to: 'skipped', patch: { skip_reason: 'qa_attempts_exhausted' } };
}

/**
 * Decide the transition OUT of `changes_requested` (owner asked for a redo).
 * Regenerates in place up to `maxRegens`, then skips.
 * @param {import('../types.mjs').ContentItem} item @param {number} maxRegens
 * @returns {{to:'drafting'|'skipped', patch:Object}}
 */
export function regenNext(item, maxRegens) {
  const used = item.regen_count || 0;
  if (used < maxRegens) {
    return {
      to: 'drafting',
      patch: { regen_count: used + 1, attempt: (item.attempt || 1) + 1 },
    };
  }
  return { to: 'skipped', patch: { skip_reason: 'regen_exhausted' } };
}

/**
 * Decide what to do after a publish failure. Retries with exponential backoff
 * up to `maxRetries`, else signals an alert (item stays `publish_failed`).
 * @param {import('../types.mjs').ContentItem} item
 * @param {number} maxRetries
 * @param {number} baseMin
 * @param {Date} [now]
 * @returns {{to:'publishing'|null, patch:Object, alert:boolean}}
 */
export function publishFailNext(item, maxRetries, baseMin, now = new Date()) {
  const used = item.publish_attempts || 0;
  if (used < maxRetries) {
    const n = used + 1; // this retry's 1-based number
    const at = new Date(now.getTime() + publishBackoffMs(n, baseMin));
    return {
      to: 'publishing',
      patch: { publish_attempts: n, next_attempt_at: at.toISOString() },
      alert: false,
    };
  }
  return { to: null, patch: { publish_attempts: used, exhausted: true }, alert: true };
}

/* ------------------------------ transition driver ------------------------------ */

/**
 * Legally transition an item: assert the move is in the table, CAS it in the
 * store, and append a compact `transition` run referencing the driving stage run.
 *
 * @param {import('../types.mjs').Store} store
 * @param {Object} args
 * @param {import('../types.mjs').ContentItem} args.item  Current item (its `status` is the CAS `from`).
 * @param {string} args.to
 * @param {Object} [args.patch]
 * @param {string} [args.stage]     Driving stage name (for the transition run).
 * @param {string} [args.runId]     Parent (stage) run id.
 * @param {Date}   [args.now]
 * @returns {Promise<import('../types.mjs').ContentItem>} the updated item
 */
export async function transitionItem(store, { item, to, patch = {}, stage = 'transition', runId, now = new Date() }) {
  const from = item.status;
  assertLegal(from, to);
  const at = nowISO(now);
  let updated;
  try {
    updated = await store.transition(item.id, from, to, patch);
  } catch (err) {
    await store.appendRun({
      stage: `${stage}:transition`,
      status: 'failed',
      driver: 'deterministic',
      item_id: item.id,
      from,
      to,
      note: `${from}→${to}`,
      parent_run: runId,
      started_at: at,
      finished_at: nowISO(),
      error: String(err && err.message ? err.message : err),
    });
    throw err;
  }
  await store.appendRun({
    stage: `${stage}:transition`,
    status: 'ok',
    driver: 'deterministic',
    item_id: item.id,
    from,
    to,
    note: `${from}→${to}`,
    parent_run: runId,
    started_at: at,
    finished_at: nowISO(),
  });
  return updated;
}
