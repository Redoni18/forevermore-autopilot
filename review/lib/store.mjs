// Review-station data layer — now built on the SHARED Store abstraction
// (src/store), not its own file IO. The wave-1 isolation constraint (AP-501
// kept this independent while AP-103's Store was being built in parallel) is
// lifted at AP-812: file-mode AND postgres-mode reviews go through the exact
// same {@link import('../../src/types.mjs').Store} contract, so the station
// gets CAS transitions, the candidate-group auto-skip, and caption_diff for
// free against either backend.
//
// Assets are NOT the store's concern here — they stay on disk under
// outbox/<item-id>/assets and are streamed by app.mjs directly (range requests
// unchanged). This module only orchestrates the item/decision records.

export const VALID_DECISIONS = new Set(['approved', 'edited', 'changes_requested', 'rejected']);
export const REASON_REQUIRED_DECISIONS = new Set(['changes_requested', 'rejected']);

// decision (what the human clicked) -> status (PRD §6.1 state machine).
// 'edited' is a sub-type of approval that also replaces the caption; it still
// resolves to status 'approved' (there is no separate ap_status for it).
const STATUS_FOR_DECISION = {
  approved: 'approved',
  edited: 'approved',
  changes_requested: 'changes_requested',
  rejected: 'skipped',
};

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

// ------------------------------------------------------------- decide() tx
//
// The single decision transaction behind POST /api/decide. The store's
// transition() is the CAS: a re-fired or doubled request (or a race) lands on
// a status that is no longer 'pending_review' and gets a 409 instead of
// double-deciding — exactly the previous file-lock semantics, now backend-
// agnostic.

/**
 * @param {Object} args
 * @param {import('../../src/types.mjs').Store} args.store
 * @param {string} args.itemId
 * @param {string} args.decision
 * @param {string[]} [args.reasonTags]
 * @param {string|null} [args.note]
 * @param {string|null} [args.captionAfter]
 * @param {string} [args.via]
 */
export async function decide({
  store,
  itemId,
  decision,
  reasonTags = [],
  note = null,
  captionAfter = null,
  via = 'local-station',
}) {
  if (!isSafeId(itemId)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'itemId is missing or malformed.' };
  }
  if (!VALID_DECISIONS.has(decision)) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: `decision must be one of: ${[...VALID_DECISIONS].join(', ')}.`,
    };
  }

  const item = await store.getItem(itemId);
  if (!item) {
    return { ok: false, status: 404, error: 'not_found', message: `No item ${itemId} in outbox.` };
  }
  if (item.status !== 'pending_review') {
    return {
      ok: false,
      status: 409,
      error: 'not_pending_review',
      message: `Item ${itemId} is already "${item.status}" — it cannot be decided again.`,
    };
  }

  const decidedAt = new Date().toISOString();
  const before = item.caption ?? null;
  const captionChanged = decision === 'edited' && typeof captionAfter === 'string' && captionAfter !== before;
  const captionDiff = captionChanged ? { before, after: captionAfter } : null;
  const newStatus = STATUS_FOR_DECISION[decision];

  // Patch carried through the CAS. `feedback` is a file-mode-only annotation
  // (no DB column) — it persists in file mode and is harmlessly dropped in
  // postgres mode, where the same information lives in the approvals row.
  const patch = {};
  if (newStatus === 'approved') patch.chosen = true;
  if (captionChanged) patch.caption = captionAfter; // approved-with-edit replaces the canonical caption
  if (newStatus === 'changes_requested') {
    patch.feedback = { reason_tags: reasonTags, note: note ?? null, decided_at: decidedAt };
  }

  let updated;
  try {
    updated = await store.transition(itemId, 'pending_review', newStatus, patch);
  } catch (err) {
    if (err && err.code === 'CAS_CONFLICT') {
      return {
        ok: false,
        status: 409,
        error: 'not_pending_review',
        message: `Item ${itemId} is already "${err.actual}" — it cannot be decided again.`,
      };
    }
    throw err;
  }

  const decisionRecord = await store.appendApproval({
    content_item_id: itemId,
    decision,
    reason_tags: reasonTags,
    note: note ?? null,
    caption_diff: captionDiff,
    via,
    decided_at: decidedAt,
  });

  let autoSkipped = [];
  if (newStatus === 'approved' && updated.candidate_group) {
    autoSkipped = await autoSkipSiblings(store, updated.candidate_group, itemId, via);
  }

  return { ok: true, status: 200, item: updated, decision: decisionRecord, autoSkipped };
}

/**
 * When a candidate is approved, its still-pending siblings in the same
 * candidate_group are auto-skipped (only one post per slot). Best-effort: a
 * sibling decided concurrently (CAS conflict) is left alone.
 */
async function autoSkipSiblings(store, candidateGroup, chosenId, via) {
  const skipped = [];
  const pending = await store.listByStatus('pending_review');
  for (const sib of pending) {
    if (sib.id === chosenId) continue;
    if (sib.candidate_group !== candidateGroup) continue;
    try {
      await store.transition(sib.id, 'pending_review', 'skipped', {});
    } catch (err) {
      if (err && err.code === 'CAS_CONFLICT') continue; // decided independently — leave it
      throw err;
    }
    await store.appendApproval({
      content_item_id: sib.id,
      decision: 'rejected',
      reason_tags: ['candidate-not-chosen'],
      note: `Auto-skipped — sibling candidate ${chosenId} was approved for this slot.`,
      caption_diff: null,
      via,
      decided_at: new Date().toISOString(),
    });
    skipped.push(sib.id);
  }
  return skipped;
}

// --------------------------------------------------- grouped read for the UI

/**
 * Returns every item grouped by candidate_group, decided items annotated with
 * their latest decision record. Groups with at least one pending_review item
 * sort first (earliest slot first); fully-decided groups trail behind as
 * "recent" context, most-recently-touched first.
 * @param {Object} args @param {import('../../src/types.mjs').Store} args.store
 */
export async function listGroupedItems({ store }) {
  const items = await store.listItems();
  for (const item of items) {
    if (item.status !== 'pending_review') {
      const approvals = await store.listApprovals(item.id);
      if (approvals.length) item.decision = approvals[approvals.length - 1];
    }
  }

  const groupsByKey = new Map();
  for (const item of items) {
    const key = item.candidate_group || item.id;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        candidate_group: key,
        platform: item.platform,
        format: item.format,
        pillar: item.pillar,
        slot_at: item.slot_at,
        items: [],
      });
    }
    groupsByKey.get(key).items.push(item);
  }

  const groups = [...groupsByKey.values()];
  for (const group of groups) {
    group.items.sort((a, b) => a.id.localeCompare(b.id));
    group.pending_count = group.items.filter((i) => i.status === 'pending_review').length;
  }

  groups.sort((a, b) => {
    const aPending = a.pending_count > 0;
    const bPending = b.pending_count > 0;
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (aPending) return new Date(a.slot_at) - new Date(b.slot_at);
    const latest = (g) => Math.max(...g.items.map((i) => new Date(i.updated_at || i.created_at || 0).getTime()));
    return latest(b) - latest(a);
  });

  const pendingCount = items.filter((i) => i.status === 'pending_review').length;
  return { groups, pending_count: pendingCount };
}
