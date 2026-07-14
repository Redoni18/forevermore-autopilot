// PostgresStore parity for the Telegram send-ledger + dailySpend (Phase 1) —
// the SAME suite as store-ledger.test.mjs, run against the live control-plane
// DB. Hermetic: every row it writes is tagged and swept in t.after, and the
// whole file SKIPS cleanly when the DB is unreachable (see test/pg-helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgTest, pgItem } from '../pg-helpers.mjs';
import { ledgerRoundTrips, dailySpendRoundTrips } from './ledger-suite.mjs';

test('pg: telegram ledger round-trips (parity with FileStore), slug ids preserved', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(async () => {
    // item-less ledger rows don't cascade off content_items — sweep by tag too.
    await store.sql`delete from autopilot.telegram_messages where dedup_key like ${`%${tag}%`}`;
    await cleanup();
  });

  const item = await store.putItem(pgItem(tag, 1));
  await ledgerRoundTrips(assert, store, { itemId: item.id, keyPrefix: `tg-${tag}`, chatId: 918273645 });
});

test('pg: dailySpend sums runs.cost_usd for the local date (delta, tag-swept)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(async () => {
    await store.sql`delete from autopilot.runs where driver = ${`test-${tag}`}`;
    await cleanup();
  });

  await dailySpendRoundTrips(assert, store, { driver: `test-${tag}` });
});

test('pg: appendApproval with via:"telegram" passes the migration-0004 CHECK', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 1));
  const appr = await store.appendApproval({
    content_item_id: item.id,
    decision: 'approved',
    via: 'telegram',
    reason_tags: [],
    decided_at: new Date().toISOString(),
  });
  assert.equal(appr.via, 'telegram', 'the extended CHECK admits via=telegram');
  const list = await store.listApprovals(item.id);
  assert.ok(list.some((a) => a.via === 'telegram'), 'the telegram approval is persisted');
});
