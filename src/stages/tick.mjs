/**
 * @file The employee's heartbeat (AP-836): one bounded sweep that moves EVERY
 * piece of in-flight work forward, across ALL slot dates. This is what turns a
 * station "Request changes" into a redraft that comes back to the review feed
 * without anyone running stages by hand — launchd fires it every 30 minutes.
 *
 *   1. plan for today          (once — daily completion marker respected)
 *   2. per date with `drafting` items          → generate  (redrafts, force)
 *   3. per date with `drafted`/`rendering`     → render    (force)
 *   4. per date with `rendered` items          → qa        (force)
 *   5. digest for today        (once — daily completion marker respected)
 *
 * Steps 2–4 force-re-enter completed (stage,date) pairs deliberately: the
 * completion marker records the daily batch, and the sweep exists precisely to
 * revisit a date that a changes_requested bounce re-opened. Stages are
 * status-guarded + CAS'd, so a forced re-entry with nothing to do is a no-op.
 * Work is re-discovered after each stage family, so a fresh redraft flows
 * straight through render → qa inside the SAME tick.
 *
 * The kill switch halts every step via runStage. Failures are collected, never
 * cascading — one broken date can't strand the rest of the queue.
 */

import { isoDatePart, nowISO } from '../util/time.mjs';
import { runStage, isPaused } from './registry.mjs';
import { contractChecks, contractFingerprint } from '../doctor/contract.mjs';

/** Statuses that mean "the employee owes work", and the stage that moves each on. */
export const TICK_STAGE_FOR_STATUS = {
  drafting: 'generate', // changes_requested / qa bounces + crash recovery
  drafted: 'render',
  rendering: 'render', // resume a crashed render
  rendered: 'qa',
};
const TICK_STAGE_ORDER = ['generate', 'render', 'qa'];

/**
 * Contract drift → ONE failed `doctor:contract` run row per distinct failure
 * set (fingerprint in the `contract_state` setting), which the bot scanner's
 * existing failure path turns into a Discord alert. Recovery clears the
 * fingerprint silently. Never throws into the sweep.
 */
async function contractGate({ config, store, print }) {
  const checks = await contractChecks(config);
  const fp = contractFingerprint(checks);
  const prev = (await store.getSetting('contract_state').catch(() => null)) || '';
  if (fp === (prev || '')) return;
  await store.setSetting('contract_state', fp);
  if (fp) {
    const summary = checks
      .filter((c) => c.level === 'critical' && !c.ok)
      .map((c) => `${c.name}: ${c.detail}`)
      .join('; ');
    print(`✗ contract drift — ${summary}`);
    await store.appendRun({
      stage: 'doctor:contract',
      status: 'failed',
      started_at: nowISO(),
      finished_at: nowISO(),
      error: `doctor:contract — kit/platform contract drift: ${summary}`,
    });
  } else {
    print('✓ contract restored');
  }
}

/** Distinct slot dates (ascending) that currently carry work for `stage`. */
export async function workDates(store, stage) {
  const statuses = Object.entries(TICK_STAGE_FOR_STATUS)
    .filter(([, s]) => s === stage)
    .map(([status]) => status);
  const items = await store.listByStatus(statuses);
  return [...new Set(items.map((i) => isoDatePart(i.slot_at)))].sort();
}

/**
 * Run the sweep. Injectable like runStage (brain/lintFn/adapters pass through)
 * so the whole loop is testable without Brave/Remotion/claude.
 *
 * @param {Object} opts
 * @param {ReturnType<import('../config.mjs').loadConfig>} opts.config
 * @param {import('../types.mjs').Store} opts.store
 * @param {string} opts.today  YYYY-MM-DD operating date.
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.driver]
 * @param {(line:string)=>void} [opts.print]
 * @returns {Promise<{passes:string[], failures:string[], paused:boolean}>}
 */
export async function runTickSweep(opts) {
  const { config, store, today, dryRun = false, driver, print = () => {} } = opts;
  const inject = { brain: opts.brain, lintFn: opts.lintFn, adapters: opts.adapters };

  // §3.12 contract gate (AP-845): cheap filesystem checks of the kit +
  // FOREVERMORE_ROOT seam. Alert-only — a broken contract must not stop the
  // sweep (the affected stage fails loudly on its own); paused sweeps skip it
  // (the kill switch halts everything); dry runs stay pure.
  if (!dryRun && !(await isPaused(store, config).catch(() => false))) {
    await contractGate({ config, store, print }).catch(() => {});
  }

  const passes = [];
  const failures = [];
  let paused = false;

  // Liveness marker (WAVE2 §3.10): every sweep END writes last_tick_at, so the
  // Telegram scanner can alert when no tick has completed for >90 min while
  // unpaused. Written on every return path — a paused sweep still "ticked".
  const finish = async () => {
    if (!dryRun) {
      await store
        .setSetting('last_tick_at', {
          at: nowISO(),
          passes: passes.length,
          failures: failures.length,
          paused,
        })
        .catch(() => {});
    }
    return { passes, failures, paused };
  };

  const step = async (stage, date, force) => {
    try {
      const res = await runStage(stage, { config, store, date, dryRun, force, driver, ...inject });
      if (res.status === 'paused') {
        paused = true;
        print(`⏸  ${stage} (${date}) — kill switch engaged`);
        return res;
      }
      if (res.status === 'skipped') return res; // daily marker already done — quiet
      passes.push(`${stage}:${date}`);
      print(`✓ ${stage} (${date}) — produced ${res.produced ?? 0}`);
      return res;
    } catch (err) {
      failures.push(`${stage}:${date}`);
      print(`✗ ${stage} (${date}) — ${err && err.message ? err.message : err}`);
      return null;
    }
  };

  // 1) keep the calendar filled (once per day; marker-respecting)
  await step('plan', today, false);
  if (paused) return finish();

  // 2–4) sweep in-flight work per slot date, earliest first
  for (const stage of TICK_STAGE_ORDER) {
    for (const date of await workDates(store, stage)) {
      await step(stage, date, true);
      if (paused) return finish();
    }
  }

  // 5) daily digest (once; marker-respecting)
  await step('digest', today, false);

  return finish();
}
