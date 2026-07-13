/**
 * @file Stage registry + `runStage()` wrapper.
 *
 * Every stage runs through `runStage`, which provides the cross-cutting
 * guarantees the AC requires:
 *   1. Kill-switch check at the top (settings.kill_switch OR env) — PRD §0/§11.
 *   2. Idempotency: a completed (stage,date) is a no-op with a logged skip,
 *      unless `--force`. Dry runs never read/write the completion marker.
 *   3. A `runs` record per stage execution (started→ok/failed), with a JSONL
 *      log the stage writes through `ctx.log`.
 *
 * Stages themselves are additionally idempotent by construction (status-guarded
 * CAS transitions), so a crashed mid-stage run resumes cleanly on re-run.
 */

import { nowISO, localToday } from '../util/time.mjs';
import { runId as makeRunId } from '../util/ids.mjs';
import { resolveBrainDriver } from '../drivers/brain-driver.mjs';
import { resolveLint } from '../drivers/noop-lint.mjs';
import { defaultAdapters } from '../adapters/index.mjs';

import { planStage } from './plan.mjs';
import { generateStage } from './generate.mjs';
import { renderStage } from './render.mjs';
import { qaStage } from './qa.mjs';
import { digestStage } from './digest.mjs';

/** @type {Record<string, (ctx:Object)=>Promise<Object>>} */
export const STAGE_FNS = {
  plan: planStage,
  generate: generateStage,
  render: renderStage,
  qa: qaStage,
  digest: digestStage,
};

export const STAGE_NAMES = Object.keys(STAGE_FNS);

function completionKey(stage, date) {
  return `stage_completed:${stage}:${date}`;
}

/**
 * Is the pipeline paused? Settings kill_switch OR env override.
 * @param {import('../types.mjs').Store} store
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 */
export async function isPaused(store, config) {
  if (config.envKillSwitch) return true;
  return (await store.getSetting('kill_switch')) === true;
}

/**
 * Run a single stage.
 * @param {string} name
 * @param {Object} opts
 * @param {ReturnType<import('../config.mjs').loadConfig>} opts.config
 * @param {import('../types.mjs').Store} opts.store
 * @param {string} opts.date         Operating date (YYYY-MM-DD).
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force]
 * @param {string} [opts.driver]     Brain driver name override.
 * @param {import('../types.mjs').BrainDriver} [opts.brain]    Inject (tests).
 * @param {import('../types.mjs').LintFn} [opts.lintFn]        Inject (tests).
 * @param {import('../types.mjs').RendererAdapters} [opts.adapters] Inject (tests).
 * @returns {Promise<Object>} { status, produced, ... }
 */
export async function runStage(name, opts) {
  const { config, store, date, dryRun = false, force = false } = opts;
  const stageFn = STAGE_FNS[name];
  if (!stageFn) throw new Error(`unknown stage "${name}" (want: ${STAGE_NAMES.join('|')})`);
  if (!date) throw new Error('runStage: date is required');

  // 1) kill switch
  if (await isPaused(store, config)) {
    const run = await store.appendRun({
      stage: name,
      status: 'ok',
      driver: 'deterministic',
      date,
      note: 'kill_switch_engaged',
      started_at: nowISO(),
      finished_at: nowISO(),
    });
    await store.appendLog(run.id, { event: 'stage.paused', stage: name, date });
    return { status: 'paused', stage: name, date, produced: 0, run: run.id };
  }

  // 2) daily brain-spend cap (WAVE2 §3.10) — generation only; render/qa/digest
  // cost nothing and keep draining the queue. Sum of runs.cost_usd for the
  // LOCAL day vs the cap (settings key beats config; <=0 disables). Only the
  // FIRST trip of the day writes a run row + the spend_cap_hit marker (the
  // Telegram scanner alerts off it); repeat blocks stay silent so the 30-min
  // tick can't flood the activity feed (same principle as AP-836).
  if (name === 'generate' && !dryRun) {
    const cap = Number((await store.getSetting('daily_spend_cap_usd')) ?? config.daily_spend_cap_usd ?? 0);
    if (cap > 0) {
      const today = localToday();
      const spent = await store.dailySpend(today);
      if (spent >= cap) {
        const already = await store.getSetting('spend_cap_hit');
        if (!already || already.date !== today) {
          await store.setSetting('spend_cap_hit', { date: today, at: nowISO(), spend: spent, cap });
          const run = await store.appendRun({
            stage: name,
            status: 'ok',
            driver: 'deterministic',
            date,
            note: 'spend_cap_hit',
            started_at: nowISO(),
            finished_at: nowISO(),
          });
          await store.appendLog(run.id, { event: 'stage.spend_cap', stage: name, date, spend: spent, cap });
        }
        return { status: 'paused', reason: 'spend_cap', stage: name, date, produced: 0, spend: spent, cap };
      }
    }
  }

  // 3) idempotency (skip completed unless force/dry-run). A skip is a
  // NON-event: it writes no run row — the 30-minute tick would otherwise
  // append ~100 "already_completed" rows a day and bury the activity feed
  // (AP-836). The completion marker itself is the durable record.
  const ckey = completionKey(name, date);
  if (!dryRun && !force) {
    const done = await store.getSetting(ckey);
    if (done) {
      return { status: 'skipped', reason: 'already_completed', stage: name, date, produced: 0, completed: done };
    }
  }

  // 4) resolve injected deps (unless provided)
  const brain = opts.brain || (name === 'generate' ? await resolveBrainDriver(opts.driver, config, name) : null);
  const lintFn = opts.lintFn || (name === 'qa' ? await resolveLint(config) : null);
  const adapters = opts.adapters || (name === 'render' ? defaultAdapters : null);

  // 5) stage run + execute
  const runIdVal = makeRunId(name);
  const run = await store.appendRun({
    id: runIdVal,
    stage: name,
    status: 'running',
    driver: brain ? brain.name : 'deterministic',
    date,
    started_at: nowISO(),
    note: dryRun ? 'dry_run' : undefined,
  });

  // The store is authoritative for the run id: FileStore echoes the slug id
  // back; PostgresStore mints the row's uuid PK. Using the returned id keeps
  // updateRun/appendLog valid on BOTH backends (AP-815 fix — the slug id
  // crashed updateRun in postgres mode).
  const rid = run.id || runIdVal;
  const ctx = {
    config,
    store,
    date,
    dryRun,
    force,
    runId: rid,
    brain,
    lintFn,
    adapters,
    now: opts.now || new Date(),
    log: (entry) => store.appendLog(rid, entry),
  };

  try {
    await ctx.log({ event: 'stage.start', stage: name, date, dryRun });
    const result = (await stageFn(ctx)) || {};
    await store.updateRun(rid, {
      status: 'ok',
      finished_at: nowISO(),
      produced: result.produced ?? 0,
    });
    if (!dryRun) await store.setSetting(ckey, { run: rid, at: nowISO() });
    await ctx.log({ event: 'stage.ok', stage: name, date, produced: result.produced ?? 0 });
    return { status: 'ok', stage: name, date, run: rid, ...result };
  } catch (err) {
    await store.updateRun(rid, {
      status: 'failed',
      finished_at: nowISO(),
      error: String(err && err.message ? err.message : err),
    });
    await ctx.log({ event: 'stage.failed', stage: name, date, error: String(err && err.message ? err.message : err) });
    throw err;
  }
}
