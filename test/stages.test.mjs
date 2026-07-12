import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runStage } from '../src/stages/registry.mjs';
import { routeAdapter } from '../src/stages/render.mjs';
import { mkEnv, brainStub, adapterStub, lintPass, lintFail, plannedItem } from './helpers.mjs';

const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

test('plan stage is idempotent: re-run is a logged skip, no duplicate items', async () => {
  const { config, store } = mkEnv();
  const first = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(first.status, 'ok');
  assert.equal(first.produced, 42);
  assert.equal((await store.listItems()).length, 42);

  const second = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'already_completed');
  assert.equal((await store.listItems()).length, 42, 'no new items on re-run');

  // --force re-enters the stage but existing ids are left untouched
  const forced = await runStage('plan', { config, store, date: RUN_DATE, force: true });
  assert.equal(forced.status, 'ok');
  assert.equal(forced.produced, 0);
  assert.equal(forced.skipped, 42);
  assert.equal((await store.listItems()).length, 42);
});

test('kill switch pauses stages within the tick', async () => {
  const { config, store } = mkEnv();
  await store.setSetting('kill_switch', true);
  const res = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(res.status, 'paused');
  assert.equal((await store.listItems()).length, 0, 'nothing produced while paused');

  await store.setSetting('kill_switch', false);
  const ok = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.produced, 42);
});

test('env kill switch also pauses', async () => {
  const { config, store } = mkEnv({ env: { AUTOPILOT_KILL_SWITCH: '1' } });
  const res = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(res.status, 'paused');
});

test('full M0 pipeline with stubs: plan → generate → render → qa → digest', async () => {
  const { config, store } = mkEnv();

  await runStage('plan', { config, store, date: RUN_DATE });

  const gen = await runStage('generate', { config, store, date: SLOT_DATE, brain: brainStub });
  assert.equal(gen.produced, 6, '2 slots × 3 candidates for the slot date');
  const drafted = await store.listByStatus('drafted');
  assert.equal(drafted.length, 6);
  assert.ok(drafted.every((i) => i.caption && i.overlays.hook));

  const rendered = await runStage('render', { config, store, date: SLOT_DATE, adapters: adapterStub });
  assert.equal(rendered.produced, 6);
  const withAssets = await store.listByStatus('rendered');
  assert.ok(withAssets.every((i) => i.assets.length >= 1));

  const qa = await runStage('qa', { config, store, date: SLOT_DATE, lintFn: lintPass });
  assert.equal(qa.produced, 6);
  const pending = await store.listByStatus('pending_review');
  assert.equal(pending.length, 6);
  assert.ok(pending.every((i) => i.lint && i.lint.passed));

  const digest = await runStage('digest', { config, store, date: SLOT_DATE });
  assert.equal(digest.produced, 6);
  assert.ok(existsSync(join(config.resolved.digest, `${SLOT_DATE}.html`)));

  // stage idempotency across the board
  const genAgain = await runStage('generate', { config, store, date: SLOT_DATE, brain: brainStub });
  assert.equal(genAgain.status, 'skipped');
});

test('generate resumes a drafting item (regen/crash recovery)', async () => {
  const { config, store } = mkEnv();
  // an item left mid-draft by a prior run
  await store.putItem({ ...plannedItem(), status: 'drafting' });
  const res = await runStage('generate', { config, store, date: SLOT_DATE, brain: brainStub });
  assert.equal(res.produced, 1);
  assert.equal((await store.getItem('ci_20260714_ig_1')).status, 'drafted');
});

test('qa failure bounces rendered → qa_failed → drafting (attempt+1)', async () => {
  const { config, store } = mkEnv();
  await store.putItem({ ...plannedItem(), status: 'rendered', attempt: 1 });
  const res = await runStage('qa', { config, store, date: SLOT_DATE, lintFn: lintFail });
  assert.equal(res.produced, 0);
  const item = await store.getItem('ci_20260714_ig_1');
  assert.equal(item.status, 'drafting');
  assert.equal(item.attempt, 2);
  assert.equal(item.lint.passed, false);
});

test('qa failure skips when attempts are exhausted', async () => {
  const { config, store } = mkEnv();
  config.retry.qa_max_attempts = 1;
  await store.putItem({ ...plannedItem(), status: 'rendered', attempt: 1 });
  await runStage('qa', { config, store, date: SLOT_DATE, lintFn: lintFail });
  assert.equal((await store.getItem('ci_20260714_ig_1')).status, 'skipped');
});

test('routeAdapter maps formats to adapters', () => {
  assert.equal(routeAdapter({ format: 'carousel' }), 'poster');
  assert.equal(routeAdapter({ format: 'image' }), 'poster');
  assert.equal(routeAdapter({ format: 'story' }), 'poster');
  assert.equal(routeAdapter({ format: 'reel' }), 'video');
  assert.equal(routeAdapter({ format: 'tiktok_video' }), 'video');
  assert.equal(routeAdapter({ format: 'reel', overlays: { source: 'capture' } }), 'capture');
});

test('dry-run plan writes nothing and never sets the completion marker', async () => {
  const { config, store } = mkEnv();
  const res = await runStage('plan', { config, store, date: RUN_DATE, dryRun: true });
  assert.equal(res.status, 'ok');
  assert.equal(res.planned.length, 42);
  assert.equal((await store.listItems()).length, 0);
  // a real run still proceeds afterward (marker was not set by the dry run)
  const real = await runStage('plan', { config, store, date: RUN_DATE });
  assert.equal(real.produced, 42);
});
