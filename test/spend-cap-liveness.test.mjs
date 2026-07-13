// WAVE2 §3.10 safety rails: the daily brain-spend cap (generation-only) and
// the tick liveness marker. Hermetic: temp file store, fixture brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStage } from '../src/stages/registry.mjs';
import { runTickSweep } from '../src/stages/tick.mjs';
import { FixtureBrain } from '../src/drivers/fixture-brain.mjs';
import { localToday, nowISO } from '../src/util/time.mjs';
import { mkEnv, adapterStub, lintPass } from './helpers.mjs';

const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

/** Force today's spend by writing an ok generate run carrying cost_usd. */
async function spend(store, usd, date = localToday()) {
  const run = await store.appendRun({
    stage: 'generate',
    status: 'ok',
    driver: 'test-spend',
    date,
    started_at: nowISO(),
    finished_at: nowISO(),
  });
  await store.updateRun(run.id, { status: 'ok', finished_at: nowISO(), cost_usd: usd });
}

/* ── spend cap ──────────────────────────────────────────────────────────── */

test('generate pauses when today’s spend ≥ cap; render/qa keep draining', async () => {
  const { config, store } = mkEnv();
  config.daily_spend_cap_usd = 1; // $1 cap for the test
  await runStage('plan', { config, store, date: RUN_DATE });

  await spend(store, 1.25); // over cap

  const gen = await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  assert.equal(gen.status, 'paused');
  assert.equal(gen.reason, 'spend_cap');

  // The trip is recorded once for the scanner to alert on.
  const hit = await store.getSetting('spend_cap_hit');
  assert.equal(hit.date, localToday());
  assert.ok(hit.spend >= 1);

  // No generate happened, so nothing to render — but the cap must NOT gate
  // render/qa themselves: run them on an empty date and they complete.
  const render = await runStage('render', { config, store, date: SLOT_DATE, adapters: adapterStub });
  assert.notEqual(render.status, 'paused', 'render is never spend-capped');
});

test('under-cap generate runs normally', async () => {
  const { config, store } = mkEnv();
  config.daily_spend_cap_usd = 10;
  await runStage('plan', { config, store, date: RUN_DATE });
  await spend(store, 0.4);
  const gen = await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  assert.equal(gen.status, 'ok');
});

test('settings daily_spend_cap_usd overrides config; 0 disables the cap', async () => {
  const { config, store } = mkEnv();
  config.daily_spend_cap_usd = 1;
  await runStage('plan', { config, store, date: RUN_DATE });
  await spend(store, 5);
  await store.setSetting('daily_spend_cap_usd', 0); // disable at runtime
  const gen = await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  assert.equal(gen.status, 'ok', 'cap of 0 disables the gate');
});

test('spend_cap_hit is written once per day, not every blocked tick', async () => {
  const { config, store } = mkEnv();
  config.daily_spend_cap_usd = 1;
  await runStage('plan', { config, store, date: RUN_DATE });
  await spend(store, 2);

  await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  const first = await store.getSetting('spend_cap_hit');
  await runStage('generate', { config, store, date: SLOT_DATE, brain: new FixtureBrain() });
  const second = await store.getSetting('spend_cap_hit');
  assert.deepEqual(first, second, 'the marker is stable across repeated blocked runs');

  // And no run-row flood: only one spend_cap run row exists.
  const runs = await store.listRuns({ limit: 100 });
  const capRows = runs.filter((r) => r.note === 'spend_cap_hit');
  assert.equal(capRows.length, 1);
});

/* ── liveness marker ────────────────────────────────────────────────────── */

test('a completed sweep writes last_tick_at', async () => {
  const { config, store } = mkEnv();
  const before = await store.getSetting('last_tick_at');
  assert.equal(before, undefined);

  await runTickSweep({
    config,
    store,
    today: RUN_DATE,
    brain: new FixtureBrain(),
    adapters: adapterStub,
    lintFn: lintPass,
  });

  const marker = await store.getSetting('last_tick_at');
  assert.ok(marker && marker.at, 'last_tick_at is set after a sweep');
  assert.equal(marker.paused, false);
});

test('a paused (kill-switched) sweep still writes last_tick_at', async () => {
  const { config, store } = mkEnv();
  await store.setSetting('kill_switch', true);

  const sweep = await runTickSweep({
    config,
    store,
    today: RUN_DATE,
    brain: new FixtureBrain(),
    adapters: adapterStub,
    lintFn: lintPass,
  });
  assert.equal(sweep.paused, true);

  const marker = await store.getSetting('last_tick_at');
  assert.ok(marker && marker.at, 'a paused tick is still a heartbeat');
  assert.equal(marker.paused, true);
});

test('a dry-run sweep does NOT write last_tick_at', async () => {
  const { config, store } = mkEnv();
  await runTickSweep({
    config,
    store,
    today: RUN_DATE,
    dryRun: true,
    brain: new FixtureBrain(),
    adapters: adapterStub,
    lintFn: lintPass,
  });
  assert.equal(await store.getSetting('last_tick_at'), undefined);
});
