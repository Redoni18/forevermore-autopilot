/**
 * @file The bot daemon: long-poll loop + scan timer + lockfile + shutdown.
 *
 * One process does BOTH inbound (getUpdates long-poll → router) and outbound
 * (runScanCycle on a timer). Own lockfile (state/telegram.lock) prevents a
 * second poller on the same box; a heartbeat refresh + 15-min stale threshold
 * lets a crashed daemon's lock be reclaimed (a long-running daemon can't use
 * the tick's age-based staleness).
 *
 * The update offset persists in settings (`telegram_update_offset`) so a
 * restart resumes where it left off; re-processing a decision is safe (decide's
 * CAS returns 409 → "already decided").
 */

import { open, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TelegramApi } from './api.mjs';
import { handleUpdate } from './commands.mjs';
import { runScanCycle } from './notify.mjs';

const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_REFRESH_MS = 5 * 60 * 1000;

/**
 * Acquire state/telegram.lock (O_EXCL), breaking a stale/unreadable lock.
 * Mirrors cmdTick's acquireTickLock but with a refreshable heartbeat.
 * @returns {Promise<{path:string, release:()=>Promise<void>, refresh:()=>Promise<void>}>}
 */
export async function acquireLock(stateDir, now = () => Date.now()) {
  const path = join(stateDir, 'telegram.lock');
  const payload = () => JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() });
  const tryCreate = async () => {
    const fh = await open(path, 'wx');
    await fh.writeFile(payload());
    await fh.close();
  };
  try {
    await tryCreate();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Stale-break: unreadable, unparseable, or older than the threshold.
    let stale = true;
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const age = now() - new Date(raw.at).getTime();
      stale = !Number.isFinite(age) || age > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error(`telegram lock held (${path}) — another poller is running`);
    await rm(path, { force: true });
    await tryCreate();
  }
  return {
    path,
    refresh: () => writeFile(path, payload()).catch(() => {}),
    release: () => rm(path, { force: true }).catch(() => {}),
  };
}

/**
 * Run the bot. Fully injectable for tests (api, spawnTick, spawnDoctor, sleep,
 * shouldStop). Resolves when shouldStop() returns true or a stop signal fires.
 * @param {Object} opts
 * @param {ReturnType<import('../config.mjs').loadConfig>} opts.config
 * @param {import('../types.mjs').Store} opts.store
 * @param {TelegramApi} [opts.api]
 * @param {()=>boolean} [opts.shouldStop]
 * @param {number} [opts.maxCycles]  test bound
 */
export async function runBot(opts) {
  const { config, store } = opts;
  const tg = config.telegram || {};
  if (!tg.enabled) throw new Error('telegram is disabled (TELEGRAM_ENABLED not set)');
  if (!tg.botToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!tg.chatId) throw new Error('TELEGRAM_CHAT_ID is required');

  const api = opts.api || new TelegramApi({ token: tg.botToken, apiBase: tg.apiBase });
  const chatId = tg.chatId;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bin = opts.bin || join(config.resolved.pkgRoot, 'bin', 'autopilot.mjs');
  const log = (entry) => store.appendRun({ stage: 'report', status: 'ok', driver: 'telegram', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), note: entry.event }).catch(() => {});

  const lock = opts.skipLock ? null : await acquireLock(config.resolved.state);
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  if (!opts.skipSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let offset = Number((await store.getSetting('telegram_update_offset')) || 0) || undefined;
  let lastScan = 0;
  let lastRefresh = Date.now();
  let cycles = 0;
  let backoff = 1000;

  const routerCtx = {
    store,
    config,
    api,
    chatId,
    bin,
    log,
    spawnTick: opts.spawnTick,
    spawnDoctor: opts.spawnDoctor,
  };

  try {
    while (!stopped && !(opts.shouldStop && opts.shouldStop())) {
      // 1) poll for updates
      try {
        const updates = await api.getUpdates({ offset, timeout: tg.pollTimeoutSec });
        for (const u of updates || []) {
          offset = u.update_id + 1;
          try {
            await handleUpdate(u, routerCtx);
          } catch (err) {
            if (opts.onError) opts.onError(err);
          }
        }
        if (updates && updates.length) await store.setSetting('telegram_update_offset', offset);
        backoff = 1000;
      } catch (err) {
        // 409 = another poller (e.g. Mac+VPS at cutover): alert once, keep trying.
        if (err.status === 409 && opts.onError) opts.onError(err);
        await sleep(Math.min(backoff, 60000));
        backoff = Math.min(backoff * 2, 60000);
      }

      // 2) scan on its interval
      const nowMs = Date.now();
      if (nowMs - lastScan >= (tg.scanIntervalSec || 60) * 1000) {
        lastScan = nowMs;
        try {
          await runScanCycle({ store, config, api, chatId, stationUrl: opts.stationUrl, logAction: log });
        } catch (err) {
          if (opts.onError) opts.onError(err);
        }
      }

      // 3) refresh the lock heartbeat
      if (lock && nowMs - lastRefresh >= LOCK_REFRESH_MS) {
        lastRefresh = nowMs;
        await lock.refresh();
      }

      cycles += 1;
      if (opts.maxCycles && cycles >= opts.maxCycles) break;
    }
  } finally {
    if (lock) await lock.release();
    if (!opts.skipSignals) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    if (opts.closeStore !== false && typeof store.close === 'function') await store.close().catch(() => {});
  }
  return { cycles };
}
