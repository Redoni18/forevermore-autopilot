/**
 * @file Shared contract assertions for the Telegram send-ledger + dailySpend
 * store methods, run identically against FileStore (store-ledger.test.mjs) and
 * PostgresStore (postgres-parity.test.mjs) so the two backends stay in lockstep.
 *
 * The caller creates any referenced content_item (PostgresStore's item_id is a
 * real FK) and owns cleanup; these helpers only exercise + assert behaviour.
 */

import { localToday, addDays } from '../../src/util/time.mjs';

/** Local-noon instant of a `YYYY-MM-DD` as a UTC-ISO string (unambiguously that
 *  local calendar day, whatever the process timezone). */
function localNoonISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
}

/**
 * The full ledger round-trip: claim / dedup / attempt-2 refire / mark-sent /
 * find-by-message / list-unsent. `itemId` must already exist in the store.
 * @param {import('node:assert/strict')} assert
 * @param {import('../../src/types.mjs').Store} store
 * @param {{itemId:string, keyPrefix:string, chatId:number}} opts
 */
export async function ledgerRoundTrips(assert, store, { itemId, keyPrefix, chatId }) {
  const keyA = `${keyPrefix}:card:pending_review:1`;
  const keyA2 = `${keyPrefix}:card:pending_review:2`;
  const keyB = `${keyPrefix}:summary:window`;

  // --- claim ---------------------------------------------------------------
  const c1 = await store.tgClaim({
    kind: 'card',
    dedup_key: keyA,
    item_id: itemId,
    item_status: 'pending_review',
    attempt: 1,
    chat_id: chatId,
    payload: { text: 'a card' },
  });
  assert.equal(c1.claimed, true, 'first claim wins');
  assert.equal(c1.record.dedup_key, keyA);
  assert.equal(c1.record.item_id, itemId, 'record carries the SLUG item id');
  assert.equal(c1.record.item_status, 'pending_review');
  assert.equal(c1.record.attempt, 1);
  assert.equal(c1.record.chat_id, chatId);
  assert.equal(c1.record.message_id, null, 'claimed = not yet sent');
  assert.equal(c1.record.sent_at, null);
  assert.ok(c1.record.created_at, 'created_at stamped');
  assert.deepEqual(c1.record.payload, { text: 'a card' }, 'payload round-trips');

  // --- dedup: same key → claimed:false + the existing (unsent) record ------
  const c1b = await store.tgClaim({ kind: 'card', dedup_key: keyA, item_id: itemId, chat_id: chatId });
  assert.equal(c1b.claimed, false, 'a second claim on the same key does not re-fire');
  assert.equal(c1b.record.dedup_key, keyA);
  assert.equal(c1b.record.message_id, null, 'still unsent');

  // --- attempt-2 refire: attempt is IN the key → distinct row claims fresh --
  const c2 = await store.tgClaim({
    kind: 'card',
    dedup_key: keyA2,
    item_id: itemId,
    item_status: 'pending_review',
    attempt: 2,
    chat_id: chatId,
  });
  assert.equal(c2.claimed, true, 'attempt-2 is a distinct dedup key → re-fires (DoD)');

  // --- mark-sent -----------------------------------------------------------
  const marked = await store.tgMarkSent(keyA, { message_id: 4242, sent_at: new Date().toISOString() });
  assert.equal(marked.message_id, 4242);
  assert.ok(marked.sent_at, 'sent_at recorded');
  assert.equal(marked.item_id, itemId, 'slug preserved through mark-sent');
  assert.equal(await store.tgMarkSent(`${keyPrefix}:unknown`, { message_id: 1 }), null, 'unknown key → null');

  // dedup after send now reflects the message_id (crash-safe idempotency).
  const c1c = await store.tgClaim({ kind: 'card', dedup_key: keyA, item_id: itemId, chat_id: chatId });
  assert.equal(c1c.claimed, false);
  assert.equal(c1c.record.message_id, 4242, 'existing record shows it was already sent');

  // --- find-by-message (reply-to-card) -------------------------------------
  const found = await store.tgFindByMessage(chatId, 4242);
  assert.ok(found, 'the sent message resolves');
  assert.equal(found.dedup_key, keyA);
  assert.equal(found.item_id, itemId, 'reply-to-card resolves back to the SLUG item id');
  assert.equal(await store.tgFindByMessage(chatId, 999999), null, 'unknown (chat,message) → null');

  // --- list-unsent (crash-safe resend queue) -------------------------------
  await store.tgClaim({ kind: 'summary', dedup_key: keyB, item_id: null, chat_id: chatId, payload: { n: 3 } });

  // A generous future `now` makes every just-claimed row count as "old".
  const unsent = await store.tgListUnsent({ olderThanMs: 0, now: Date.now() + 60_000 });
  const keys = unsent.map((r) => r.dedup_key);
  assert.ok(keys.includes(keyB), 'unsent summary is queued');
  assert.ok(keys.includes(keyA2), 'unsent attempt-2 card is queued');
  assert.ok(!keys.includes(keyA), 'the already-sent card is NOT in the unsent queue');
  const bRec = unsent.find((r) => r.dedup_key === keyB);
  assert.equal(bRec.item_id, null, 'an item-less event carries item_id null');
  for (let i = 1; i < unsent.length; i++) {
    assert.ok(unsent[i - 1].created_at <= unsent[i].created_at, 'unsent is sorted created_at asc');
  }

  // With a 10-minute floor against the real clock, freshly-claimed rows are not
  // yet eligible for a resend.
  const none = await store.tgListUnsent({ olderThanMs: 10 * 60 * 1000, now: Date.now() });
  const noneKeys = none.map((r) => r.dedup_key);
  assert.ok(!noneKeys.includes(keyB) && !noneKeys.includes(keyA2), 'fresh rows are not yet "old enough"');
}

/**
 * dailySpend: sums runs.cost_usd for a LOCAL calendar date. Delta-based so it
 * is hermetic against a live DB that already carries runs (PostgresStore).
 * Runs are tagged `driver` so the caller can sweep them.
 * @param {import('node:assert/strict')} assert
 * @param {import('../../src/types.mjs').Store} store
 * @param {{driver:string}} opts
 */
export async function dailySpendRoundTrips(assert, store, { driver }) {
  const today = localToday();
  const yesterday = addDays(today, -1);
  const far = addDays(today, -5);

  const baseToday = await store.dailySpend(today);
  const baseYesterday = await store.dailySpend(yesterday);
  const baseFar = await store.dailySpend(far);

  await store.appendRun({ stage: 'generate', driver, cost_usd: 0.5, started_at: localNoonISO(today) });
  await store.appendRun({ stage: 'generate', driver, cost_usd: 0.25, started_at: localNoonISO(today) });
  await store.appendRun({ stage: 'generate', driver, cost_usd: 1.0, started_at: localNoonISO(yesterday) });
  await store.appendRun({ stage: 'render', driver, started_at: localNoonISO(today) }); // no cost → 0

  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(approx(await store.dailySpend(today), baseToday + 0.75), "today's spend adds 0.50 + 0.25");
  assert.ok(approx(await store.dailySpend(yesterday), baseYesterday + 1.0), "yesterday's spend adds 1.00");
  assert.ok(approx(await store.dailySpend(far), baseFar), 'a date with none of our runs is unchanged');
}
