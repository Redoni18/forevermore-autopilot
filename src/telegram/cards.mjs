/**
 * @file Message formatters + media resolution (pure).
 *
 * Every outbound message's text/keyboard is built here so it's unit-testable
 * without a bot. HTML parse mode (Telegram's) — escape all interpolated copy.
 * A card carries the review buttons; alerts/summaries are text-only.
 */

import { join } from 'node:path';
import { encodeDecision } from './callbacks.mjs';

/** Escape text for Telegram HTML parse mode. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Absolute path to an item's primary media file, or null. */
export function mediaPathFor(config, item) {
  const assets = Array.isArray(item?.assets) ? item.assets : [];
  const pick = assets.find((a) => a.kind === 'video') || assets.find((a) => a.kind === 'poster') || assets[0];
  if (!pick || !pick.path) return null;
  return join(config.resolved.outbox, item.id, pick.path);
}

/** Media kind for the Bot API method (sendVideo vs sendPhoto vs sendDocument). */
export function mediaKindFor(item) {
  const assets = Array.isArray(item?.assets) ? item.assets : [];
  if (assets.some((a) => a.kind === 'video')) return 'video';
  if (assets.some((a) => a.kind === 'poster')) return 'photo';
  return null;
}

const FORMAT_LABEL = {
  reel: 'reel',
  carousel: 'carousel',
  image: 'image',
  story: 'story',
  tiktok_video: 'tiktok video',
};

function slotLabel(item) {
  // 2026-07-14T17:30… → "Tue 17:30". Cheap + tz-naive (the slot is already zoned).
  const m = /T(\d{2}:\d{2})/.exec(String(item.slot_at || ''));
  const time = m ? m[1] : '';
  const day = item.slot_at
    ? new Date(item.slot_at).toLocaleDateString('en-US', { weekday: 'short' })
    : '';
  return [day, time].filter(Boolean).join(' ');
}

/**
 * A review card: caption text + the 4-button inline keyboard.
 * @returns {{text:string, keyboard:Object}}
 */
export function reviewCard(item, { stationUrl } = {}) {
  const platform = item.platform === 'instagram' ? 'instagram' : 'tiktok';
  const fmt = FORMAT_LABEL[item.format] || item.format || '';
  const attempt = item.attempt || 1;
  const hook = (item.overlays && item.overlays.hook) || '';
  const caption = item.caption || '';

  const lines = [
    `🎬 <b>${esc(item.id)}</b> — ${esc(platform)} ${esc(fmt)}${slotLabel(item) ? `, slot ${esc(slotLabel(item))}` : ''}`,
  ];
  if (attempt > 1) lines.push(`<i>attempt ${attempt}</i>`);
  lines.push('');
  if (hook) lines.push(`<b>Hook:</b> ${esc(hook)}`);
  if (caption) lines.push(`<b>Caption:</b> ${esc(truncate(caption, 600))}`);

  const row1 = [
    { text: '✅ Approve', callback_data: encodeDecision(item.id, 'approve') },
    { text: '✏️ Changes', callback_data: encodeDecision(item.id, 'changes') },
    { text: '⏭ Skip', callback_data: encodeDecision(item.id, 'skip') },
  ];
  const row2 = stationUrl ? [[{ text: '🔍 Station', url: stationUrl }]] : [];
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [row1, ...row2] } };
}

/** A per-tick summary line (only emitted when something happened). */
export function tickSummary({ rendered = 0, awaitingReview = 0, qaBounced = 0, failed = 0, at }) {
  const bits = [];
  if (rendered) bits.push(`${rendered} rendered`);
  if (awaitingReview) bits.push(`${awaitingReview} awaiting review`);
  if (qaBounced) bits.push(`${qaBounced} QA-bounced`);
  if (failed) bits.push(`${failed} failed`);
  const when = at ? clock(at) : '';
  return `⚙️ Tick ${when} — ${bits.join(', ') || 'nothing new'}`;
}

/** A stage-failure alert. */
export function failureAlert({ stage, date, itemId, attempt, cause }) {
  const who = itemId ? ` — item ${esc(itemId)}${attempt ? `, attempt ${attempt}` : ''}` : '';
  return `✗ <b>${esc(stage)}</b> failed${date ? ` (${esc(date)})` : ''}: ${esc(truncate(cause || '', 240))}${who}`;
}

export function escalationAlert({ stage, date }) {
  return `🚨 <b>${esc(stage)}</b> has failed 3 ticks in a row${date ? ` (${esc(date)})` : ''} — pipeline needs you. /doctor`;
}

export function spendCapAlert({ spend, cap }) {
  return `🛑 Daily brain spend $${fmt2(spend)} ≥ cap $${fmt2(cap)} — generation paused until midnight. /status`;
}

export function livenessAlert({ lastAt }) {
  return `🫥 No tick has completed since ${lastAt ? clock(lastAt) : 'a while'} (>90 min) while unpaused. Check launchd / <code>make logs</code>.`;
}

export function fallbackAlert({ ranModel, wantModel, runId }) {
  return (
    `⚠️ generate ran on <b>${esc(ranModel)}</b> (fallback) — ${esc(wantModel)} was unavailable. ` +
    `If Fable 5 left your subscription, update <code>stageModels.generate</code> in autopilot.config.json.`
  );
}

export function heartbeat({ pendingReview = 0, spend = 0, cap = 0, lastTickAt }) {
  const spendBit = cap > 0 ? `spend $${fmt2(spend)}/$${fmt2(cap)}` : `spend $${fmt2(spend)}`;
  return `🫀 alive — ${pendingReview} pending review, ${spendBit}, last tick ${lastTickAt ? clock(lastTickAt) : '—'}`;
}

/** /status body. */
export function statusText({ counts = {}, lastTickAt, spend = 0, cap = 0, paused, quiet }) {
  const order = ['planned', 'drafting', 'rendered', 'pending_review', 'changes_requested', 'approved', 'scheduled', 'published'];
  const seen = new Set(order);
  const rows = [];
  for (const k of order) if (counts[k]) rows.push(`  ${k}: ${counts[k]}`);
  for (const [k, v] of Object.entries(counts)) if (!seen.has(k) && v) rows.push(`  ${k}: ${v}`);
  return [
    '<b>Status</b>',
    rows.length ? rows.join('\n') : '  (queue empty)',
    '',
    `last tick: ${lastTickAt ? clock(lastTickAt) : '—'}`,
    `today's spend: $${fmt2(spend)}${cap > 0 ? ` / $${fmt2(cap)}` : ''}`,
    `kill switch: ${paused ? 'ENGAGED (paused)' : 'off'}`,
    `quiet hours: ${quiet ? `${quiet.start}–${quiet.end}` : '—'}`,
  ].join('\n');
}

export function helpText() {
  return [
    '<b>Forevermore Autopilot</b>',
    'Reply to a card = change-request note. Any other message = suggestion box.',
    '',
    '/status — queue, last tick, spend',
    '/queue — items awaiting review',
    '/new [instagram|tiktok] [YYYY-MM-DD] &lt;brief&gt; — commission content',
    '/rule &lt;text&gt; [#hook|#caption|#format|#timing|#world|#visual] — add a playbook rule',
    '/pause · /resume — kill switch',
    '/tick — force a tick now',
    '/digest — today’s digest summary',
    '/doctor — health check',
    '/help — this',
  ].join('\n');
}

/* helpers */
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}
function fmt2(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}
function clock(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso));
  return m ? m[1] : String(iso);
}
