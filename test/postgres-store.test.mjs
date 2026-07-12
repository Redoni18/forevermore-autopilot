// PostgresStore contract tests — mirroring the critical FileStore cases
// (roundtrip, CAS conflict via concurrent transitions, listByStatus, approvals
// incl. changes_requested, settings) against the live control-plane DB. Each
// test is hermetic (tagged rows, cleaned up) and SKIPS cleanly when the DB is
// unreachable. See test/pg-helpers.mjs for the isolation model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasConflictError } from '../src/types.mjs';
import { pgTest, pgItem } from './pg-helpers.mjs';

test('pg putItem/getItem roundtrip preserves the file-mode slug ids + shape', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const saved = await store.putItem(pgItem(tag, 1, { produced_by: `run_${tag}_gen` }));
  assert.ok(saved.created_at && saved.updated_at, 'timestamps stamped');
  assert.equal(saved.id, `ci_${tag}_1`, 'putItem echoes the caller slug id');

  const got = await store.getItem(`ci_${tag}_1`);
  assert.equal(got.id, `ci_${tag}_1`);
  assert.equal(got.status, 'planned');
  assert.equal(got.candidate_group, `cg_${tag}`, 'slug candidate_group survives the uuid column');
  assert.equal(got.produced_by, `run_${tag}_gen`, 'slug produced_by survives via the envelope');
  assert.equal(got.caption, `caption ${tag}-1`);
  assert.deepEqual(got.hashtags, ['forevermore', 'giftideas']);
  assert.deepEqual(got.overlays, { hook: `hook ${tag}-1` }, 'overlays returns clean (envelope stripped)');
  assert.equal(got.assets.length, 1);
  assert.equal(got.lint.passed, true);

  assert.equal(await store.getItem(`ci_${tag}_missing`), null, 'missing item → null');
});

test('pg putItem upserts (same slug id → one row, updated in place)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  await store.putItem(pgItem(tag, 1, { caption: 'first' }));
  await store.putItem(pgItem(tag, 1, { caption: 'second', status: 'drafted' }));
  const got = await store.getItem(`ci_${tag}_1`);
  assert.equal(got.caption, 'second');
  assert.equal(got.status, 'drafted');

  const drafted = (await store.listByStatus('drafted')).filter((i) => i.id === `ci_${tag}_1`);
  assert.equal(drafted.length, 1, 'exactly one row after upsert');
});

test('pg transition CAS: two concurrent transitions, exactly one wins', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 2));
  const results = await Promise.allSettled([
    store.transition(item.id, 'planned', 'drafting', { by: 'A' }),
    store.transition(item.id, 'planned', 'drafting', { by: 'B' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one transition commits');
  assert.equal(rejected.length, 1, 'the other is rejected');
  assert.equal(rejected[0].reason.code, 'CAS_CONFLICT');
  assert.equal((await store.getItem(item.id)).status, 'drafting');
});

test('pg transition: mismatched `from` throws CasConflictError with the actual status', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 3));
  await assert.rejects(() => store.transition(item.id, 'rendered', 'pending_review', {}), (err) => {
    assert.ok(err instanceof CasConflictError);
    assert.equal(err.code, 'CAS_CONFLICT');
    assert.equal(err.actual, 'planned');
    return true;
  });
  assert.equal((await store.getItem(item.id)).status, 'planned', 'untouched');
});

test('pg transition: missing item rejects with "no such item"', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);
  await assert.rejects(() => store.transition(`ci_${tag}_nope`, 'planned', 'drafting', {}), /no such item/);
});

test('pg transition applies whitelisted column patches, drops file-mode-only keys', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 4, { status: 'pending_review' }));
  const updated = await store.transition(item.id, 'pending_review', 'approved', {
    chosen: true,
    caption: 'approved caption',
    skip_reason: 'not-a-column', // dropped silently
  });
  assert.equal(updated.status, 'approved');
  assert.equal(updated.chosen, true);
  assert.equal(updated.caption, 'approved caption');
  assert.equal(updated.skip_reason, undefined, 'non-column patch keys are not surfaced');
});

test('pg listByStatus filters (single + multi)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  await store.putItem(pgItem(tag, 1, { status: 'planned' }));
  await store.putItem(pgItem(tag, 2, { status: 'pending_review' }));
  await store.putItem(pgItem(tag, 3, { status: 'drafted' }));

  const mine = (arr) => arr.filter((i) => i.id.startsWith(`ci_${tag}_`)).map((i) => i.id).sort();
  assert.deepEqual(mine(await store.listByStatus('pending_review')), [`ci_${tag}_2`]);
  assert.deepEqual(mine(await store.listByStatus(['planned', 'drafted'])), [`ci_${tag}_1`, `ci_${tag}_3`]);
});

test('pg approvals: appendApproval (incl. changes_requested + local-station) then listApprovals sorted', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const id = `ci_${tag}_1`;
  await store.putItem(pgItem(tag, 1));
  await store.appendApproval({ content_item_id: id, decision: 'approved', via: 'cli' });
  await store.appendApproval({
    content_item_id: id,
    decision: 'changes_requested',
    reason_tags: ['hook-weak', 'timing'],
    note: 'sharpen the open',
    via: 'local-station',
  });

  const list = await store.listApprovals(id);
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.id && a.decided_at), 'every approval has id + decided_at');
  assert.ok(list.every((a) => a.content_item_id === id), 'content_item_id echoes the slug');
  assert.deepEqual([...new Set(list.map((a) => a.decision))].sort(), ['approved', 'changes_requested']);
  const cr = list.find((a) => a.decision === 'changes_requested');
  assert.deepEqual(cr.reason_tags, ['hook-weak', 'timing']);
  assert.equal(cr.via, 'local-station');
  assert.deepEqual(await store.listApprovals(`ci_${tag}_other`), []);
});

test('pg settings: get/set roundtrip for boolean + object values', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const kSwitch = `test_${tag}_kill_switch`;
  const kCadence = `test_${tag}_cadence`;
  assert.equal(await store.getSetting(kSwitch), undefined, 'unset key → undefined');

  await store.setSetting(kSwitch, false);
  assert.equal(await store.getSetting(kSwitch), false);
  await store.setSetting(kSwitch, true); // upsert overwrites
  assert.equal(await store.getSetting(kSwitch), true);
  await store.setSetting(kCadence, { ig: 1, tt: 2 });
  assert.deepEqual(await store.getSetting(kCadence), { ig: 1, tt: 2 });

  const all = await store.getSettings();
  assert.equal(all[kSwitch], true);
  assert.deepEqual(all[kCadence], { ig: 1, tt: 2 });
});
