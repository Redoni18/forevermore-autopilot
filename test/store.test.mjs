import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkEnv, plannedItem } from './helpers.mjs';

test('putItem/getItem roundtrip stamps timestamps', async () => {
  const { store } = mkEnv();
  const saved = await store.putItem(plannedItem());
  assert.ok(saved.created_at && saved.updated_at);
  const got = await store.getItem(saved.id);
  assert.equal(got.id, saved.id);
  assert.equal(got.status, 'planned');
  assert.equal(await store.getItem('nope'), null);
});

test('listItems is sorted by slot_at then id; listByStatus filters', async () => {
  const { store } = mkEnv();
  await store.putItem({ ...plannedItem('ci_20260715_ig_1'), slot_at: '2026-07-15T17:30:00+02:00' });
  await store.putItem({ ...plannedItem('ci_20260714_ig_1'), slot_at: '2026-07-14T17:30:00+02:00' });
  await store.putItem({ ...plannedItem('ci_20260714_tt_1'), slot_at: '2026-07-14T19:00:00+02:00', status: 'drafted' });

  const all = await store.listItems();
  assert.deepEqual(all.map((i) => i.id), ['ci_20260714_ig_1', 'ci_20260714_tt_1', 'ci_20260715_ig_1']);

  const planned = await store.listByStatus('planned');
  assert.deepEqual(planned.map((i) => i.id).sort(), ['ci_20260714_ig_1', 'ci_20260715_ig_1']);

  const multi = await store.listByStatus(['planned', 'drafted']);
  assert.equal(multi.length, 3);
});

test('runs: appendRun then updateRun', async () => {
  const { store } = mkEnv();
  const run = await store.appendRun({ stage: 'plan', driver: 'deterministic' });
  assert.equal(run.status, 'running');
  assert.ok(run.id.startsWith('run_'));
  const done = await store.updateRun(run.id, { status: 'ok', produced: 5 });
  assert.equal(done.status, 'ok');
  assert.equal(done.produced, 5);
  assert.equal(done.stage, 'plan');
});

test('approvals: appendApproval then listApprovals (sorted)', async () => {
  const { store } = mkEnv();
  await store.putItem(plannedItem());
  await store.appendApproval({ content_item_id: 'ci_20260714_ig_1', decision: 'approved', via: 'cli' });
  await store.appendApproval({
    content_item_id: 'ci_20260714_ig_1',
    decision: 'edited',
    reason_tags: ['regen'],
    via: 'cli',
  });
  const list = await store.listApprovals('ci_20260714_ig_1');
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.id && a.decided_at));
  assert.deepEqual([...new Set(list.map((a) => a.decision))].sort(), ['approved', 'edited']);
  assert.deepEqual(await store.listApprovals('other'), []);
});

test('settings: get/set roundtrip and concurrent writes both persist', async () => {
  const { store } = mkEnv();
  assert.deepEqual(await store.getSettings(), {});
  await store.setSetting('kill_switch', false);
  assert.equal(await store.getSetting('kill_switch'), false);

  // concurrent writes to different keys should not clobber (lock serializes RMW)
  await Promise.all([
    store.setSetting('autonomy', 'L1'),
    store.setSetting('cadence', { ig: 1 }),
    store.setSetting('kill_switch', true),
  ]);
  const s = await store.getSettings();
  assert.equal(s.autonomy, 'L1');
  assert.deepEqual(s.cadence, { ig: 1 });
  assert.equal(s.kill_switch, true);
});

test('appendLog writes JSONL lines', async () => {
  const { store, config } = mkEnv();
  const run = await store.appendRun({ stage: 'generate' });
  await store.appendLog(run.id, { event: 'a', n: 1 });
  await store.appendLog(run.id, { event: 'b', n: 2 });
  const raw = readFileSync(`${config.resolved.logs}/${run.id}.jsonl`, 'utf8').trim().split('\n');
  assert.equal(raw.length, 2);
  const first = JSON.parse(raw[0]);
  assert.equal(first.event, 'a');
  assert.ok(first.ts);
});
