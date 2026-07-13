// Pure-module unit tests: callbacks, quiet hours, cards, /new parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeDecision, parseCallback, callbackByteLength } from '../../src/telegram/callbacks.mjs';
import { inQuietHours, resolveQuietWindow } from '../../src/telegram/quiet.mjs';
import * as cards from '../../src/telegram/cards.mjs';
import { parseNewCommand } from '../../src/telegram/newitem.mjs';
import { extractItemId } from '../../src/telegram/commands.mjs';

/* ── callbacks ──────────────────────────────────────────────────────────── */

test('callback round-trips and stays under 64 bytes even with a uuid id', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const data = encodeDecision(uuid, 'changes');
  assert.ok(callbackByteLength(data) <= 64, `got ${callbackByteLength(data)} bytes`);
  assert.deepEqual(parseCallback(data), { itemId: uuid, action: 'changes' });
});

test('every action encodes and parses back', () => {
  for (const a of ['approve', 'changes', 'skip']) {
    assert.deepEqual(parseCallback(encodeDecision('ci_20260714_ig_1', a)), { itemId: 'ci_20260714_ig_1', action: a });
  }
});

test('malformed callback data returns null (never throws)', () => {
  for (const bad of ['', 'noop', 'x:y:z', 'd:only-two', 'd::a', 'd:id:z', null, undefined, 42]) {
    assert.equal(parseCallback(bad), null, `should reject: ${bad}`);
  }
});

/* ── quiet hours ────────────────────────────────────────────────────────── */

const TZ = 'Europe/Tirane'; // UTC+2 in July

test('across-midnight window 23:00–08:00 wraps correctly', () => {
  const at = (utc) => new Date(utc);
  assert.equal(inQuietHours(at('2026-07-14T00:00:00Z'), { start: '23:00', end: '08:00' }, TZ), true, '02:00 local → quiet');
  assert.equal(inQuietHours(at('2026-07-14T05:00:00Z'), { start: '23:00', end: '08:00' }, TZ), true, '07:00 local → quiet');
  assert.equal(inQuietHours(at('2026-07-14T07:00:00Z'), { start: '23:00', end: '08:00' }, TZ), false, '09:00 local → awake');
  assert.equal(inQuietHours(at('2026-07-14T13:00:00Z'), { start: '23:00', end: '08:00' }, TZ), false, '15:00 local → awake');
  assert.equal(inQuietHours(at('2026-07-14T21:30:00Z'), { start: '23:00', end: '08:00' }, TZ), true, '23:30 local → quiet');
});

test('same-day window and zero-width window', () => {
  assert.equal(inQuietHours(new Date('2026-07-14T01:00:00Z'), { start: '01:00', end: '06:00' }, TZ), true, '03:00 local');
  assert.equal(inQuietHours(new Date('2026-07-14T05:00:00Z'), { start: '01:00', end: '06:00' }, TZ), false, '07:00 local');
  assert.equal(inQuietHours(new Date('2026-07-14T00:00:00Z'), { start: '08:00', end: '08:00' }, TZ), false, 'zero-width → never');
});

test('settings quiet window overrides the config default', () => {
  assert.deepEqual(resolveQuietWindow({ start: '22:00', end: '07:00' }, { start: '23:00', end: '08:00' }), { start: '22:00', end: '07:00' });
  assert.deepEqual(resolveQuietWindow(null, { start: '23:00', end: '08:00' }), { start: '23:00', end: '08:00' });
  assert.deepEqual(resolveQuietWindow({ start: '22:00' }, { start: '23:00', end: '08:00' }), { start: '23:00', end: '08:00' }, 'partial ignored');
});

/* ── cards ──────────────────────────────────────────────────────────────── */

test('review card escapes HTML and carries the three decision buttons', () => {
  const item = {
    id: 'ci_20260714_ig_1',
    platform: 'instagram',
    format: 'reel',
    attempt: 2,
    slot_at: '2026-07-14T17:30:00+02:00',
    overlays: { hook: 'he <ignores> me & minecraft' },
    caption: 'a caption',
  };
  const { text, keyboard } = cards.reviewCard(item, { stationUrl: 'http://localhost:4600' });
  assert.match(text, /&lt;ignores&gt;/, 'hook is HTML-escaped');
  assert.match(text, /&amp;/, 'ampersand escaped');
  assert.match(text, /attempt 2/);
  const codes = keyboard.inline_keyboard[0].map((b) => b.callback_data);
  assert.deepEqual(codes, ['d:ci_20260714_ig_1:a', 'd:ci_20260714_ig_1:c', 'd:ci_20260714_ig_1:s']);
  assert.equal(keyboard.inline_keyboard[1][0].url, 'http://localhost:4600');
});

test('tick summary only names what happened', () => {
  assert.match(cards.tickSummary({ rendered: 3, awaitingReview: 2, qaBounced: 1 }), /3 rendered, 2 awaiting review, 1 QA-bounced/);
});

/* ── /new parsing ───────────────────────────────────────────────────────── */

test('/new parses platform + date + brief, with sensible defaults', () => {
  assert.deepEqual(parseNewCommand('/new make a video about dads and fishing'), {
    ok: true,
    platform: 'instagram',
    date: null,
    brief: 'make a video about dads and fishing',
  });
  assert.deepEqual(parseNewCommand('/new tiktok: the burnt pancake anniversary'), {
    ok: true,
    platform: 'tiktok',
    date: null,
    brief: 'the burnt pancake anniversary',
  });
  assert.deepEqual(parseNewCommand('/new instagram 2026-07-20 a carousel of worlds'), {
    ok: true,
    platform: 'instagram',
    date: '2026-07-20',
    brief: 'a carousel of worlds',
  });
  assert.equal(parseNewCommand('/new').ok, false, 'empty brief rejected');
});

test('extractItemId finds both planner and commissioned ids', () => {
  assert.equal(extractItemId('🎬 ci_20260714_ig_1 — instagram reel'), 'ci_20260714_ig_1');
  assert.equal(extractItemId('reply for ci_20260714_tt_x2 please'), 'ci_20260714_tt_x2');
  assert.equal(extractItemId('nothing here'), null);
});
