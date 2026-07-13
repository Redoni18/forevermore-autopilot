import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkEnv, plannedItem } from './helpers.mjs';

/** The AP-831 thinking-log shape, in the persisted (joined) form. */
function sampleRationale() {
  return {
    summary: 'a first-person reel that lands the tension fast.',
    hook_reasoning: 'it opens on a concrete POV the viewer already feels.',
    strategy: {
      idea_id: 'I01',
      idea_title: 'both a',
      pillar: 'P1',
      playbook_rules: [{ id: 'r-orient', rule: 'include an orientation beat' }],
    },
    craft: ['POV framing', 'orientation beat'],
    limits: ['kinetic-text video — no product footage yet'],
    audience: 'partners shopping for an anniversary gift.',
  };
}

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

test('rationale (AP-831) roundtrips through putItem and a transition patch', async () => {
  const { store } = mkEnv();
  const rationale = sampleRationale();
  const saved = await store.putItem({ ...plannedItem(), rationale });
  assert.deepEqual(saved.rationale, rationale, 'putItem persists the thinking log');
  assert.deepEqual((await store.getItem(saved.id)).rationale, rationale, 'getItem returns it');

  // generate persists rationale on the drafted transition.
  const drafted = await store.transition(saved.id, 'planned', 'drafting', {
    rationale: { ...rationale, summary: 'revised summary' },
  });
  assert.equal(drafted.rationale.summary, 'revised summary');
  assert.equal((await store.getItem(saved.id)).rationale.summary, 'revised summary');
});

test('getRun reads a run by id; missing run → null', async () => {
  const { store } = mkEnv();
  const run = await store.appendRun({ stage: 'generate', driver: 'fixture', model: 'fixture', tokens_in: 10 });
  const got = await store.getRun(run.id);
  assert.equal(got.id, run.id);
  assert.equal(got.stage, 'generate');
  assert.equal(got.tokens_in, 10);
  assert.equal(await store.getRun('run_does_not_exist'), null);
});

test('listPlaybookRules reads playbook.json (weight-desc, status-filtered); empty default', async () => {
  const { store, tmp } = mkEnv();
  // No file yet → empty default (file mode never blocks generation on rules).
  assert.deepEqual(await store.listPlaybookRules('active'), []);

  writeFileSync(
    join(tmp, 'playbook.json'),
    JSON.stringify([
      { id: 'r-lo', rule: 'low weight rule', category: 'hook', weight: 3, status: 'active' },
      { id: 'r-hi', rule: 'high weight rule', category: 'format', weight: 9, status: 'active' },
      { id: 'r-prop', rule: 'still proposed', category: 'caption', weight: 8, status: 'proposed' },
      { id: 'r-mid', rule: 'mid weight rule', category: 'visual', weight: 6 }, // no status → treated active
    ]),
  );

  const active = await store.listPlaybookRules('active');
  assert.deepEqual(active.map((r) => r.id), ['r-hi', 'r-mid', 'r-lo'], 'weight-desc, proposed excluded, status-less = active');
  assert.equal(active[0].rule, 'high weight rule');

  const proposed = await store.listPlaybookRules('proposed');
  assert.deepEqual(proposed.map((r) => r.id), ['r-prop']);
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
