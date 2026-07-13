// FileStore contract for the Telegram send-ledger + dailySpend (Phase 1).
// Same suite runs against PostgresStore in postgres-parity.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkEnv, plannedItem } from '../helpers.mjs';
import { ledgerRoundTrips, dailySpendRoundTrips } from './ledger-suite.mjs';

test('file: telegram ledger claim/dedup/mark-sent/find-by-message/list-unsent round-trips', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem('ci_20260714_ig_1'));
  await ledgerRoundTrips(assert, store, { itemId: item.id, keyPrefix: 'file', chatId: 424242 });
});

test('file: dailySpend sums runs.cost_usd for the local date', async () => {
  const { store } = mkEnv();
  await dailySpendRoundTrips(assert, store, { driver: 'test-file' });
});

test('file: telegram-messages.json is the persistence, keyed by dedup_key', async () => {
  const { store } = mkEnv();
  await store.tgClaim({ kind: 'alert', dedup_key: 'alert:spend:2026-07-13', chat_id: 7, payload: { critical: true } });
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(store.telegramMessagesPath, 'utf8'));
  assert.ok(raw['alert:spend:2026-07-13'], 'the ledger is a map keyed by dedup_key');
  assert.equal(raw['alert:spend:2026-07-13'].message_id, null, 'claimed rows land unsent');
  assert.equal(raw['alert:spend:2026-07-13'].item_id, null, 'item-less alert carries null item_id');
});
