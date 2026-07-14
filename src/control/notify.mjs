/**
 * @file The outbound scanner: a projection of the DB into Telegram messages.
 *
 * runScanCycle() runs on a timer (default 60s). It diffs DB state against the
 * persisted send-ledger (tgClaim/tgMarkSent) so every event fires exactly once
 * and survives restarts. Claim-then-send: claim the dedup_key BEFORE sending so
 * a crash mid-send leaves a claimed-unsent row the next cycle resends.
 *
 * Quiet hours: non-critical events are simply not claimed during the window;
 * the first post-window cycle finds them un-ledgered and flushes them. Critical
 * events (failures, escalation, spend, liveness) bypass quiet hours.
 *
 * Every send also lands in `runs` via the caller's `logAction` so the Station
 * Activity feed and Telegram never disagree.
 */

import { existsSync } from 'node:fs';
import * as cards from './cards.mjs';
import { inQuietHours, resolveQuietWindow } from './quiet.mjs';
import { localToday } from '../util/time.mjs';

const LIVENESS_LAPSE_MS = 90 * 60 * 1000;
const CLAIM_RETRY_MS = 5 * 60 * 1000;

/**
 * @param {Object} ctx
 * @param {import('../types.mjs').Store} ctx.store
 * @param {ReturnType<import('../config.mjs').loadConfig>} ctx.config
 * @param {import('./api.mjs').TelegramApi} ctx.api
 * @param {string|number} ctx.chatId
 * @param {Date} [ctx.now]
 * @param {string} [ctx.stationUrl]
 * @param {(entry:Object)=>Promise<void>} [ctx.logAction]  mirror to runs feed
 * @returns {Promise<{sent:number, byKind:Object}>}
 */
export async function runScanCycle(ctx) {
  const { store, config, api, chatId, now = new Date(), stationUrl, logAction } = ctx;
  const quietWindow = resolveQuietWindow(await store.getSetting('quiet_hours'), config.discord.quietHours);
  const quiet = inQuietHours(now, quietWindow, config.timezone);

  const out = new Sender({ store, config, api, chatId, now, quiet, logAction });

  // 0) resend crash-orphaned claims first (claimed but never sent, >5min old).
  await resendOrphans(out, store, now);

  // 1) new pending_review items → cards (non-critical).
  const pending = await store.listByStatus('pending_review');
  for (const item of pending) {
    const key = `card:${item.id}:pending_review:${item.attempt || 1}`;
    await out.send({
      key,
      kind: 'card',
      critical: false,
      item,
      build: () => cards.reviewCard(item, { stationUrl }),
    });
  }

  // 2+3) run-cursor: failures (critical), fallbacks (non-critical), summary.
  // FIRST BOOT (no cursor yet): initialize the cursor to NOW and alert on
  // nothing historical — back-filling the last 200 runs as alerts floods the
  // owner with stale failures (and "fallback" misfires on runs that predate
  // the model pin). Seen live on the 2026-07-14 first boot: ~24 alerts at
  // 03:30. Cards (section 1) still send on first boot; only run-derived
  // messages are anchored to the cursor.
  const cursor = (await store.getSetting('telegram_runs_cursor')) || null;
  if (!cursor) {
    await store.setSetting('telegram_runs_cursor', now.toISOString());
  } else {
    const runs = await store.listRuns({ limit: 200 });
    const fresh = runs
      .filter((r) => String(r.started_at) > String(cursor))
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

    let maxSeen = cursor;
    let rendered = 0;
    let failed = 0;
    for (const r of fresh) {
      if (String(r.started_at) > String(maxSeen || '')) maxSeen = r.started_at;
      if (r.status === 'ok' && r.stage === 'render') rendered += r.produced || 0;
      if (r.status === 'failed') {
        failed += 1;
        await out.send({
          key: `alert:runfail:${r.id}`,
          kind: 'alert',
          critical: true,
          build: () => ({ text: cards.failureAlert({ stage: r.stage, date: r.date, cause: r.error }) }),
        });
      }
      // model fallback: an ok generate run whose model isn't the pinned one.
      if (r.status === 'ok' && r.stage === 'generate') {
        const want = config.stageModels?.generate;
        if (want && r.model && !prefixMatch(r.model, want)) {
          await out.send({
            key: `alert:fallback:${r.id}`,
            kind: 'alert',
            critical: false,
            build: () => ({ text: cards.fallbackAlert({ ranModel: r.model, wantModel: want, runId: r.id }) }),
          });
        }
      }
    }
    if (maxSeen && maxSeen !== cursor) await store.setSetting('telegram_runs_cursor', maxSeen);

    // tick summary — only when the batch of fresh runs did something.
    if (fresh.length) {
      const awaitingReview = pending.length;
      const qaBounced = fresh.filter((r) => r.stage === 'qa' && r.status === 'failed').length;
      if (rendered || awaitingReview || qaBounced || failed) {
        const at = maxSeen || now.toISOString();
        await out.send({
          key: `summary:${at}`,
          kind: 'summary',
          critical: false,
          build: () => ({ text: cards.tickSummary({ rendered, awaitingReview, qaBounced, failed, at }) }),
        });
      }
    }
  }

  // 4) spend-cap trip (critical) — one per date, off the marker.
  const capHit = await store.getSetting('spend_cap_hit');
  if (capHit && capHit.date) {
    await out.send({
      key: `alert:spend:${capHit.date}`,
      kind: 'alert',
      critical: true,
      build: () => ({ text: cards.spendCapAlert({ spend: capHit.spend, cap: capHit.cap }) }),
    });
  }

  // 5) liveness (critical): unpaused + no tick in >90min.
  const paused = await isPaused(store, config);
  const lastTick = await store.getSetting('last_tick_at');
  if (!paused && lastTick && lastTick.at) {
    const lapse = now.getTime() - new Date(lastTick.at).getTime();
    if (lapse > LIVENESS_LAPSE_MS) {
      const bucket = Math.floor(now.getTime() / LIVENESS_LAPSE_MS); // re-alert ≤ every 90min
      await out.send({
        key: `alert:liveness:${bucket}`,
        kind: 'alert',
        critical: true,
        build: () => ({ text: cards.livenessAlert({ lastAt: lastTick.at }) }),
      });
    }
  }

  // 6) daily heartbeat (~configured hour) — non-critical.
  if (now.getHours() >= (config.discord.heartbeatHour ?? 9)) {
    const today = localToday(now);
    await out.send({
      key: `heartbeat:${today}`,
      kind: 'heartbeat',
      critical: false,
      build: async () => ({
        text: cards.heartbeat({
          pendingReview: pending.length,
          spend: await store.dailySpend(today),
          cap: Number((await store.getSetting('daily_spend_cap_usd')) ?? config.daily_spend_cap_usd ?? 0),
          lastTickAt: lastTick?.at,
        }),
      }),
    });
  }

  return out.stats();
}

/** Prefix match tolerant of dated model ids (claude-fable-5-20260601). */
function prefixMatch(actual, want) {
  return String(actual).startsWith(String(want));
}

async function isPaused(store, config) {
  if (config.envKillSwitch) return true;
  return (await store.getSetting('kill_switch')) === true;
}

/** Resend claims that were made but never sent (crash between claim and send). */
async function resendOrphans(out, store, now) {
  const orphans = await store.tgListUnsent({ olderThanMs: CLAIM_RETRY_MS, now });
  for (const row of orphans) {
    // We can only resend text payloads we persisted; cards without a cached
    // payload are re-derived next cycle by their normal path, so skip here.
    if (row.payload && row.payload.text) {
      await out.deliver(row, { text: row.payload.text, buttons: row.payload.buttons });
    }
  }
}

/**
 * Claim-then-send with quiet-hours gating + ledger persistence.
 */
class Sender {
  constructor({ store, config, api, chatId, now, quiet, logAction }) {
    this.store = store;
    this.config = config;
    this.api = api;
    this.chatId = chatId;
    this.now = now;
    this.quiet = quiet;
    this.logAction = logAction;
    this._sent = 0;
    this._byKind = {};
  }

  /**
   * @param {Object} ev
   * @param {string} ev.key   dedup key
   * @param {string} ev.kind  card|summary|alert|heartbeat|digest|prompt
   * @param {boolean} ev.critical  bypass quiet hours
   * @param {Object} [ev.item]  content item (for cards → media)
   * @param {()=>({text?:string,buttons?:Array})|Promise<...>} ev.build
   */
  async send(ev) {
    // Quiet hours: hold non-critical events by NOT claiming them (the ledger is
    // the queue — they flush on the first post-window cycle).
    if (this.quiet && !ev.critical) return false;

    const built = await ev.build();
    const claim = await this.store.tgClaim({
      kind: ev.kind,
      dedup_key: ev.key,
      item_id: ev.item ? ev.item.id : null,
      item_status: ev.item ? ev.item.status : null,
      attempt: ev.item ? ev.item.attempt || 1 : null,
      chat_id: this.chatId,
      payload: { text: built.text, buttons: built.buttons },
    });
    if (!claim.claimed) return false; // already sent (or claimed by a prior cycle)

    await this.deliver(claim.record, built, ev.item);
    return true;
  }

  /** Perform the actual Bot API send + mark the ledger row sent. */
  async deliver(row, built, item) {
    let msg;
    const mediaPath = item && existsSyncSafe(cards.mediaPathFor(this.config, item));
    if (mediaPath) {
      const kind = cards.mediaKindFor(item);
      const opts = { caption: built.text, buttons: built.buttons };
      msg =
        kind === 'photo'
          ? await this.api.sendPhoto(this.chatId, mediaPath, opts)
          : await this.api.sendVideo(this.chatId, mediaPath, opts);
    } else {
      msg = await this.api.sendMessage(this.chatId, built.text, { buttons: built.buttons });
    }
    await this.store.tgMarkSent(row.dedup_key, { message_id: msg?.message_id });
    this._sent += 1;
    this._byKind[row.kind] = (this._byKind[row.kind] || 0) + 1;
    if (this.logAction) {
      await this.logAction({ event: 'control.sent', kind: row.kind, dedup_key: row.dedup_key });
    }
  }

  stats() {
    return { sent: this._sent, byKind: this._byKind };
  }
}

/** Path if it exists on disk, else null (media may not be rendered yet). */
function existsSyncSafe(p) {
  return p && existsSync(p) ? p : null;
}
