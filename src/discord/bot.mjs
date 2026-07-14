/**
 * @file The Discord bot daemon: gateway + scan timer + lockfile + shutdown.
 *
 * One process does BOTH inbound (gateway dispatch → neutral events →
 * control/commands router) and outbound (control/notify runScanCycle on a
 * timer). Own lockfile (state/bot.lock) prevents a second daemon on the box; a
 * heartbeat refresh + 15-min stale threshold lets a crashed daemon's lock be
 * reclaimed.
 *
 * Unlike the Telegram long-poll design there is no update offset: outbound
 * state lives in the DB-driven scanner, and an inbound message missed during a
 * gateway gap simply needs re-sending by the owner (v1 accepts this — READY
 * resyncs nothing). All Discord ids stay STRINGS (snowflakes exceed 2^53).
 */

import { open, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscordApi } from './api.mjs';
import { DiscordGateway } from './gateway.mjs';
import { handleEvent } from '../control/commands.mjs';
import { parseCallback } from '../control/callbacks.mjs';
import { runScanCycle } from '../control/notify.mjs';

const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_REFRESH_MS = 5 * 60 * 1000;

/** Acquire state/bot.lock (O_EXCL) with a refreshable heartbeat + stale-break. */
export async function acquireLock(stateDir, now = () => Date.now()) {
  const path = join(stateDir, 'bot.lock');
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
    let stale = true;
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const age = now() - new Date(raw.at).getTime();
      stale = !Number.isFinite(age) || age > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error(`bot lock held (${path}) — another daemon is running`);
    await rm(path, { force: true });
    await tryCreate();
  }
  return {
    path,
    refresh: () => writeFile(path, payload()).catch(() => {}),
    release: () => rm(path, { force: true }).catch(() => {}),
  };
}

/** Map a raw gateway dispatch to a neutral router event, or null to ignore. */
export function toNeutralEvent(eventType, d, { channelId, api }) {
  if (eventType === 'MESSAGE_CREATE') {
    if (!d || d.author?.bot) return null; // never route our own (or any bot's) messages
    if (String(d.channel_id) !== String(channelId)) return null;
    return {
      kind: 'text',
      text: d.content || '',
      authorId: String(d.author?.id ?? ''),
      channelId: String(d.channel_id),
      replyToMessageId: d.referenced_message ? String(d.referenced_message.id) : d.message_reference ? String(d.message_reference.message_id) : null,
      replyToText: d.referenced_message ? d.referenced_message.content || '' : '',
    };
  }
  if (eventType === 'INTERACTION_CREATE') {
    if (!d || d.type !== 3) return null; // 3 = MESSAGE_COMPONENT (button)
    const parsed = parseCallback(d.data?.custom_id);
    if (!parsed) return null;
    const authorId = String(d.member?.user?.id ?? d.user?.id ?? '');
    return {
      kind: 'button',
      itemId: parsed.itemId,
      action: parsed.action,
      authorId,
      channelId: String(d.channel_id ?? channelId),
      messageId: d.message ? String(d.message.id) : null,
      ack: (text) => api.respondToInteraction(d.id, d.token, text),
    };
  }
  return null;
}

/**
 * Run the bot. Fully injectable for tests (api, gateway, spawn*, sleep,
 * shouldStop/maxCycles). Resolves when stopped.
 * @param {Object} opts
 * @param {ReturnType<import('../config.mjs').loadConfig>} opts.config
 * @param {import('../types.mjs').Store} opts.store
 */
export async function runBot(opts) {
  const { config, store } = opts;
  const dc = config.discord || {};
  if (!dc.enabled) throw new Error('discord is disabled (DISCORD_ENABLED not set)');
  if (!dc.botToken) throw new Error('DISCORD_BOT_TOKEN is required');
  if (!dc.channelId) throw new Error('DISCORD_CHANNEL_ID is required');
  if (!dc.ownerId) throw new Error('DISCORD_OWNER_ID is required');

  const api = opts.api || new DiscordApi({ token: dc.botToken, apiBase: dc.apiBase });
  const channelId = String(dc.channelId);
  const ownerId = String(dc.ownerId);
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bin = opts.bin || join(config.resolved.pkgRoot, 'bin', 'autopilot.mjs');
  const log = (entry) =>
    store
      .appendRun({
        stage: 'report',
        status: 'ok',
        driver: 'discord',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        note: entry.event,
      })
      .catch(() => {});

  const lock = opts.skipLock ? null : await acquireLock(config.resolved.state);
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  if (!opts.skipSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  const routerCtx = {
    store,
    config,
    api,
    channelId,
    ownerId,
    bin,
    log,
    spawnTick: opts.spawnTick,
    spawnDoctor: opts.spawnDoctor,
  };

  // Inbound: gateway dispatch → neutral event → router. Errors are contained
  // per event so one bad payload can't kill the daemon.
  const gateway =
    opts.gateway ||
    new DiscordGateway({
      token: dc.botToken,
      url: await api.getGatewayUrl().catch(() => undefined),
      onDispatch: (t, d) => {
        const ev = toNeutralEvent(t, d, { channelId, api });
        if (!ev) return;
        handleEvent(ev, routerCtx).catch((err) => opts.onError && opts.onError(err));
      },
      onError: (err) => opts.onError && opts.onError(err),
    });

  let lastRefresh = Date.now();
  let cycles = 0;

  try {
    await gateway.start(); // resolves on first READY
    while (!stopped && !(opts.shouldStop && opts.shouldStop())) {
      try {
        // No logAction here: passive sends (cards/alerts/summaries) live in the
        // send-ledger + daemon log only. Minting a `report` run per send buried
        // the Station Activity feed in ~44 rows on first boot (2026-07-14).
        // Real actions (decisions, commissions) are logged by the router.
        await runScanCycle({ store, config, api, chatId: channelId, stationUrl: opts.stationUrl });
      } catch (err) {
        if (opts.onError) opts.onError(err);
      }
      if (lock && Date.now() - lastRefresh >= LOCK_REFRESH_MS) {
        lastRefresh = Date.now();
        await lock.refresh();
      }
      cycles += 1;
      if (opts.maxCycles && cycles >= opts.maxCycles) break;
      await sleep((dc.scanIntervalSec || 60) * 1000);
    }
  } finally {
    gateway.stop();
    if (lock) await lock.release();
    if (!opts.skipSignals) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    if (opts.closeStore !== false && typeof store.close === 'function') await store.close().catch(() => {});
  }
  return { cycles };
}
