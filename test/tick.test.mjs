// AP-836: the tick sweep — the loop that turns a station "Request changes"
// into a redraft back in the review feed, unattended. Hermetic: fixture brain,
// stub adapters, pass-through lint, temp file store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStage } from '../src/stages/registry.mjs';
import { runTickSweep, workDates } from '../src/stages/tick.mjs';
import { decide } from '../review/lib/store.mjs';
import { FixtureBrain } from '../src/drivers/fixture-brain.mjs';
import { mkEnv, adapterStub, lintPass, plannedItem } from './helpers.mjs';

const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

/** Full happy path up to pending_review, exactly like the daily batch. */
async function seedPipeline({ config, store }) {
  await runStage('plan', { config, store, date: RUN_DATE });
  await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  await runStage('render', { config, store, date: SLOT_DATE, adapters: adapterStub });
  await runStage('qa', { config, store, date: SLOT_DATE, lintFn: lintPass });
}

const sweepDeps = () => ({ brain: new FixtureBrain(), adapters: adapterStub, lintFn: lintPass });

test('tick closes the loop: changes_requested → redraft → render → qa → back in review, one sweep', async () => {
  const env = mkEnv();
  const { config, store } = env;
  await seedPipeline(env);

  const pending = await store.listByStatus('pending_review');
  assert.ok(pending.length >= 6);
  const target = pending[0];

  // The owner requests changes through the station's decide path (the real one).
  const res = await decide({
    store,
    itemId: target.id,
    decision: 'changes_requested',
    reasonTags: ['hook-weak'],
    note: 'show the product before the end card',
    via: 'local-station',
  });
  assert.equal(res.ok, true);
  const bounced = await store.getItem(target.id);
  assert.equal(bounced.status, 'drafting', 'the request queues a redraft');
  assert.equal(bounced.attempt, 2);

  // …and the next tick turns it back into a reviewable candidate.
  const sweep = await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.deepEqual(sweep.failures, []);
  assert.ok(sweep.passes.includes(`generate:${SLOT_DATE}`), 'redraft ran');
  assert.ok(sweep.passes.includes(`render:${SLOT_DATE}`), 'the redraft flowed into render in the SAME tick');
  assert.ok(sweep.passes.includes(`qa:${SLOT_DATE}`), '…and through qa');

  const redrafted = await store.getItem(target.id);
  assert.equal(redrafted.status, 'pending_review', 'the redraft is back in the review feed');
  assert.equal(redrafted.attempt, 2);
  assert.ok(
    (redrafted.sources.generation.feedback || []).some((f) => f.includes('show the product before the end card')),
    'the owner note was injected into the redraft prompt (and logged in sources)',
  );
});

test('tick sweeps every date carrying work; an idle tick is quiet', async () => {
  const env = mkEnv();
  const { config, store } = env;

  // Two stranded redrafts on DIFFERENT dates (the exact bug: a daily
  // generate for one date never picks up the other's bounce).
  await store.putItem({ ...plannedItem('ci_20260714_ig_1'), status: 'drafting', attempt: 2,
    slot_at: '2026-07-14T17:30:00+02:00',
    feedback: { note: 'less salesy', reason_tags: [], decided_at: '2026-07-13T10:00:00Z' } });
  await store.putItem({ ...plannedItem('ci_20260716_tt_1'), status: 'drafting', attempt: 2,
    slot_at: '2026-07-16T19:00:00+02:00', platform: 'tiktok', format: 'tiktok_video',
    feedback: { note: 'name the world', reason_tags: [], decided_at: '2026-07-13T10:00:00Z' } });

  assert.deepEqual(await workDates(store, 'generate'), ['2026-07-14', '2026-07-16']);

  const sweep = await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.deepEqual(sweep.failures, []);
  for (const d of ['2026-07-14', '2026-07-16']) {
    assert.ok(sweep.passes.includes(`generate:${d}`), `swept ${d}`);
  }
  assert.equal((await store.getItem('ci_20260714_ig_1')).status, 'pending_review');
  assert.equal((await store.getItem('ci_20260716_tt_1')).status, 'pending_review');

  // Nothing owed now → the next sweep does no forced passes (plan/digest
  // markers are already stamped for today).
  const idle = await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.deepEqual(idle.passes, []);
  assert.deepEqual(idle.failures, []);
});

test('the kill switch pauses the whole tick', async () => {
  const env = mkEnv();
  const { config, store } = env;
  await store.putItem({ ...plannedItem(), status: 'drafting', attempt: 2 });
  await store.setSetting('kill_switch', true);

  const sweep = await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.equal(sweep.paused, true);
  assert.deepEqual(sweep.passes, []);
  assert.equal((await store.getItem('ci_20260714_ig_1')).status, 'drafting', 'nothing moved while paused');
});

test('a failing stage is recorded but never strands the rest of the queue', async () => {
  const env = mkEnv();
  const { config, store } = env;
  await store.putItem({ ...plannedItem('ci_20260714_ig_1'), status: 'drafting', attempt: 2,
    slot_at: '2026-07-14T17:30:00+02:00' });
  await store.putItem({ ...plannedItem('ci_20260716_tt_1'), status: 'drafting', attempt: 2,
    slot_at: '2026-07-16T19:00:00+02:00', platform: 'tiktok', format: 'tiktok_video' });

  // A brain that breaks ONLY for the 07-14 item.
  const moody = {
    name: 'moody',
    async complete(req) {
      if (req.item.id.includes('20260714')) throw new Error('brain offline');
      return new FixtureBrain().complete(req);
    },
  };

  const sweep = await runTickSweep({ config, store, today: RUN_DATE, brain: moody, adapters: adapterStub, lintFn: lintPass });
  assert.ok(sweep.failures.includes('generate:2026-07-14'), 'the broken date is reported');
  assert.equal((await store.getItem('ci_20260716_tt_1')).status, 'pending_review', 'the healthy date still flowed through');
  assert.equal((await store.getItem('ci_20260714_ig_1')).status, 'drafting', 'the failed item stays queued for the next tick');
});
