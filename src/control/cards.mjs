/**
 * @file Message formatters + media resolution (pure, channel-neutral).
 *
 * Every outbound message is built here so it's unit-testable without a bot.
 * Output shape: `{ text, buttons? }` where text is Discord-flavored markdown
 * and buttons is a flat list of `{label, itemId, action}` decision buttons
 * and/or `{label, url}` link buttons — the transport (src/discord/api.mjs)
 * turns them into message components. Escape all interpolated copy with esc().
 */

import { join } from 'node:path';

/** Escape user copy for Discord markdown (bold/italic/code/spoiler/quote). */
export function esc(s) {
  return String(s ?? '').replace(/([*_`~|\\])/g, '\\$1').replace(/^>/gm, '\\>');
}

/** Absolute path to an item's primary media file, or null. */
export function mediaPathFor(config, item) {
  const assets = Array.isArray(item?.assets) ? item.assets : [];
  const pick = assets.find((a) => a.kind === 'video') || assets.find((a) => a.kind === 'poster') || assets[0];
  if (!pick || !pick.path) return null;
  return join(config.resolved.outbox, item.id, pick.path);
}

/** Media kind hint for the transport (attachment either way on Discord). */
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
  const m = /T(\d{2}:\d{2})/.exec(String(item.slot_at || ''));
  const time = m ? m[1] : '';
  const day = item.slot_at
    ? new Date(item.slot_at).toLocaleDateString('en-US', { weekday: 'short' })
    : '';
  return [day, time].filter(Boolean).join(' ');
}

/**
 * A review card: markdown body + decision buttons (+ optional Station link).
 * @returns {{text:string, buttons:Array<Object>}}
 */
export function reviewCard(item, { stationUrl } = {}) {
  const platform = item.platform === 'instagram' ? 'instagram' : 'tiktok';
  const fmt = FORMAT_LABEL[item.format] || item.format || '';
  const attempt = item.attempt || 1;
  const hook = (item.overlays && item.overlays.hook) || '';
  const caption = item.caption || '';

  const lines = [
    `🎬 **${esc(item.id)}** — ${esc(platform)} ${esc(fmt)}${slotLabel(item) ? `, slot ${esc(slotLabel(item))}` : ''}`,
  ];
  if (attempt > 1) lines.push(`*attempt ${attempt}*`);
  lines.push('');
  if (hook) lines.push(`**Hook:** ${esc(hook)}`);
  if (caption) lines.push(`**Caption:** ${esc(truncate(caption, 600))}`);

  const buttons = [
    { label: '✅ Approve', itemId: item.id, action: 'approve' },
    { label: '✏️ Changes', itemId: item.id, action: 'changes' },
    { label: '⏭ Skip', itemId: item.id, action: 'skip' },
  ];
  if (stationUrl) buttons.push({ label: '🔍 Station', url: stationUrl });
  return { text: lines.join('\n'), buttons };
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
  return `✗ **${esc(stage)}** failed${date ? ` (${esc(date)})` : ''}: ${esc(truncate(cause || '', 240))}${who}`;
}

export function escalationAlert({ stage, date }) {
  return `🚨 **${esc(stage)}** has failed 3 ticks in a row${date ? ` (${esc(date)})` : ''} — pipeline needs you. /doctor`;
}

export function spendCapAlert({ spend, cap }) {
  return `🛑 Daily brain spend $${fmt2(spend)} ≥ cap $${fmt2(cap)} — generation paused until midnight. /status`;
}

export function livenessAlert({ lastAt }) {
  return `🫥 No tick has completed since ${lastAt ? clock(lastAt) : 'a while'} (>90 min) while unpaused. Check launchd / \`make logs\`.`;
}

export function fallbackAlert({ ranModel, wantModel }) {
  return (
    `⚠️ generate ran on **${esc(ranModel)}** (fallback) — ${esc(wantModel)} was unavailable. ` +
    `If Fable 5 left your subscription, update \`stageModels.generate\` in autopilot.config.json.`
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
    '**Status**',
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
    '**Forevermore Autopilot**',
    'Reply to a card = change-request note. Any other message = suggestion box.',
    '',
    '`/status` — queue, last tick, spend',
    '`/queue` — items awaiting review',
    '`/new [instagram|tiktok] [YYYY-MM-DD] <brief>` — commission content',
    '`/rule <text> [#hook|#caption|#format|#timing|#world|#visual]` — add a playbook rule',
    '`/pause` · `/resume` — kill switch',
    '`/tick` — force a tick now',
    '`/digest` — today’s digest summary',
    '`/doctor` — health check',
    '`/help` — this',
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
