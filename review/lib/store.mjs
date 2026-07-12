// File-mode Store for the M0 local review station (PRD §5 ContentItem
// contract). Implemented directly against files — this intentionally does
// NOT import from autopilot/src (AP-103's Store abstraction is being built
// in parallel by a different ticket); the two must agree on the file-mode
// contract but are independent implementations until AP-801 integration.
//
// Layout convention (see server.mjs / README for the reasoning): given an
// `outboxDir`, its sibling `decisions/` directory holds the audit trail and
// a sibling `settings.json` holds kill-switch state — i.e. everything lives
// under one swappable "autopilot data root", so pointing --outbox at a
// fixture (or a temp dir in tests) never touches the real autopilot/ tree.
//
//   <root>/outbox/<item-id>/item.json
//   <root>/outbox/<item-id>/<item-id>.lock      (transient CAS lockfile)
//   <root>/outbox/<item-id>/assets/...
//   <root>/decisions/<item-id>-<timestamp>.json
//   <root>/settings.json
import { readFile, writeFile, rename, rm, readdir, open, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const VALID_DECISIONS = new Set(['approved', 'edited', 'changes_requested', 'rejected']);
export const REASON_REQUIRED_DECISIONS = new Set(['changes_requested', 'rejected']);

// decision (what the human clicked) -> status (PRD §6.1 state machine).
// 'edited' is a sub-type of approval that also replaces the caption; it
// still resolves to status 'approved' (there is no separate ap_status for it).
const STATUS_FOR_DECISION = {
  approved: 'approved',
  edited: 'approved',
  changes_requested: 'changes_requested',
  rejected: 'skipped',
};

const LOCK_STALE_MS = 15_000; // a lock older than this is assumed to be from a crashed request, not a live one
const LOCK_RETRY_ATTEMPTS = 5;
const LOCK_RETRY_DELAY_MS = 40;

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

function itemDirPath(outboxDir, itemId) {
  return join(outboxDir, itemId);
}
function itemJsonPath(outboxDir, itemId) {
  return join(itemDirPath(outboxDir, itemId), 'item.json');
}
function lockFilePath(outboxDir, itemId) {
  return join(itemDirPath(outboxDir, itemId), `${itemId}.lock`);
}
function tsForFilename(iso) {
  return iso.replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------- fs utils

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

async function acquireLockOnce(lp) {
  try {
    const handle = await open(lp, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
    await handle.close();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const st = await stat(lp);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lp, { force: true });
        const handle = await open(lp, 'wx');
        await handle.close();
        return true;
      }
    } catch {
      // lock vanished mid-check (another request released it) or stat raced — let the retry loop re-attempt cleanly
    }
    return false;
  }
}

async function acquireLockWithRetry(lp, attempts = LOCK_RETRY_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    if (await acquireLockOnce(lp)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }
  return false;
}

async function releaseLock(lp) {
  await rm(lp, { force: true });
}

// -------------------------------------------------------------- item reads

export async function listItemIds(outboxDir) {
  let entries;
  try {
    entries = await readdir(outboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await pathExists(itemJsonPath(outboxDir, entry.name))) ids.push(entry.name);
  }
  return ids.sort();
}

export async function readItem(outboxDir, itemId) {
  const raw = await readFile(itemJsonPath(outboxDir, itemId), 'utf8');
  return JSON.parse(raw);
}

async function tryReadItem(outboxDir, itemId) {
  try {
    return await readItem(outboxDir, itemId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- decisions

export async function writeDecisionRecord(decisionsDir, itemId, record) {
  await mkdir(decisionsDir, { recursive: true });
  const filename = `${itemId}-${tsForFilename(record.decided_at)}.json`;
  await writeJsonAtomic(join(decisionsDir, filename), record);
  return filename;
}

export async function readDecisionsForItem(decisionsDir, itemId) {
  let entries;
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return [];
  }
  const prefix = `${itemId}-`;
  const matches = entries.filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  const records = [];
  for (const f of matches) {
    try {
      records.push(JSON.parse(await readFile(join(decisionsDir, f), 'utf8')));
    } catch {
      // skip a partially-written or corrupt decision file rather than fail the whole read
    }
  }
  records.sort((a, b) => new Date(a.decided_at) - new Date(b.decided_at));
  return records;
}

export async function latestDecisionForItem(decisionsDir, itemId) {
  const records = await readDecisionsForItem(decisionsDir, itemId);
  return records.length ? records[records.length - 1] : null;
}

// ------------------------------------------------------------- decide() tx

/**
 * The single read-modify-write transaction behind POST /api/decide.
 * Guarded by an O_EXCL lockfile (CAS) + a `status === 'pending_review'`
 * check so a re-fired or doubled request 409s instead of double-deciding.
 */
export async function decide({
  outboxDir,
  decisionsDir,
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

  // Check existence *before* touching the lockfile: the item's directory may
  // not exist at all for a bad id, and O_EXCL-creating a lock inside a
  // missing directory throws ENOENT (not EEXIST) — that's a 404, not a lock
  // contention case.
  if (!(await pathExists(itemJsonPath(outboxDir, itemId)))) {
    return { ok: false, status: 404, error: 'not_found', message: `No item ${itemId} in outbox.` };
  }

  const lp = lockFilePath(outboxDir, itemId);
  const gotLock = await acquireLockWithRetry(lp);
  if (!gotLock) {
    return {
      ok: false,
      status: 409,
      error: 'locked',
      message: `Item ${itemId} is being decided by another request right now — try again.`,
    };
  }

  try {
    const item = await tryReadItem(outboxDir, itemId);
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
    item.status = newStatus;
    item.updated_at = decidedAt;
    if (captionChanged) item.caption = captionAfter; // approved-with-edit replaces the canonical caption
    if (newStatus === 'approved') item.chosen = true;
    if (newStatus === 'changes_requested') {
      item.feedback = { reason_tags: reasonTags, note: note ?? null, decided_at: decidedAt };
    }

    await writeJsonAtomic(itemJsonPath(outboxDir, itemId), item);

    const decisionRecord = {
      content_item_id: itemId,
      decision,
      reason_tags: reasonTags,
      note: note ?? null,
      caption_diff: captionDiff,
      via,
      decided_at: decidedAt,
    };
    await writeDecisionRecord(decisionsDir, itemId, decisionRecord);

    let autoSkipped = [];
    if (newStatus === 'approved' && item.candidate_group) {
      autoSkipped = await autoSkipSiblings(outboxDir, decisionsDir, item.candidate_group, itemId, decidedAt, via);
    }

    return { ok: true, status: 200, item, decision: decisionRecord, autoSkipped };
  } finally {
    await releaseLock(lp);
  }
}

async function autoSkipSiblings(outboxDir, decisionsDir, candidateGroup, chosenItemId, decidedAt, via) {
  const skipped = [];
  const allIds = await listItemIds(outboxDir);
  for (const siblingId of allIds) {
    if (siblingId === chosenItemId) continue;
    const siblingLock = lockFilePath(outboxDir, siblingId);
    const gotLock = await acquireLockWithRetry(siblingLock, 2);
    if (!gotLock) continue; // best-effort: a contended sibling shouldn't fail the primary approval
    try {
      const sibling = await tryReadItem(outboxDir, siblingId);
      if (!sibling) continue;
      if (sibling.candidate_group !== candidateGroup) continue;
      if (sibling.status !== 'pending_review') continue; // already decided independently — leave it alone

      sibling.status = 'skipped';
      sibling.updated_at = decidedAt;
      await writeJsonAtomic(itemJsonPath(outboxDir, siblingId), sibling);

      const record = {
        content_item_id: siblingId,
        decision: 'rejected',
        reason_tags: ['candidate-not-chosen'],
        note: `Auto-skipped — sibling candidate ${chosenItemId} was approved for this slot.`,
        caption_diff: null,
        via,
        decided_at: decidedAt,
      };
      await writeDecisionRecord(decisionsDir, siblingId, record);
      skipped.push(siblingId);
    } finally {
      await releaseLock(siblingLock);
    }
  }
  return skipped;
}

// --------------------------------------------------- grouped read for the UI

/**
 * Returns every item in the outbox grouped by candidate_group, decided items
 * annotated with their latest decision record. Groups with at least one
 * pending_review item sort first (earliest slot first); fully-decided groups
 * trail behind as "recent" context, most-recently-touched first.
 */
export async function listGroupedItems({ outboxDir, decisionsDir }) {
  const ids = await listItemIds(outboxDir);
  const items = [];
  for (const id of ids) {
    const item = await tryReadItem(outboxDir, id);
    if (!item) continue;
    if (item.status !== 'pending_review') {
      const latest = await latestDecisionForItem(decisionsDir, id);
      if (latest) item.decision = latest;
    }
    items.push(item);
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
