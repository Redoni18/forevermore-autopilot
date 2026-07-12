import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWeek } from '../src/plan/planner.mjs';
import { formatForSlot, formatPreferenceRank, DEFAULT_FORMAT_MIX } from '../src/plan/ideas.mjs';

const SLOT_TIMES = { instagram: '17:30', tiktok: '19:00' };
const CADENCE = { instagram_per_day: 1, tiktok_per_day: 1, candidates_per_slot: 3, quiet_days: [] };

/* ── format_mix pattern ─────────────────────────────────────────────────── */

test('formatForSlot maps weekday→format from the default mix', () => {
  // Mon..Sun (ISO 1..7)
  const ig = [1, 2, 3, 4, 5, 6, 7].map((wd) => formatForSlot('instagram', wd));
  assert.deepEqual(ig, ['reel', 'carousel', 'reel', 'image', 'carousel', 'reel', 'reel']);
  for (const wd of [1, 2, 3, 4, 5, 6, 7]) assert.equal(formatForSlot('tiktok', wd), 'tiktok_video');
});

test('formatForSlot falls back to the natural default for an unconfigured platform/weekday', () => {
  assert.equal(formatForSlot('instagram', 4, { instagram: {} }), 'reel');
  assert.equal(formatForSlot('tiktok', 4, { tiktok: {} }), 'tiktok_video');
  // string keys (config-file JSON) resolve too
  assert.equal(formatForSlot('instagram', 2, { instagram: { 2: 'image' } }), 'image');
});

test("'story' is a legal value but never appears in the defaults", () => {
  const values = new Set(Object.values(DEFAULT_FORMAT_MIX.instagram));
  assert.ok(!values.has('story'), 'stories need manual placement — not auto-scheduled');
  // but it is still resolvable when an operator opts a slot into it by hand
  assert.equal(formatForSlot('instagram', 2, { instagram: { 2: 'story' } }), 'story');
});

/* ── format-aware idea selection ────────────────────────────────────────── */

test('formatPreferenceRank prefers the right platform per format', () => {
  const igc = { platform: 'ig-carousel' };
  const both = { platform: 'both' };
  const reelsS = { platform: 'reels', effort: 'S' };
  const reelsL = { platform: 'reels', effort: 'L' };
  const igStory = { platform: 'ig-story' };

  // carousel: ig-carousel < both < other
  assert.ok(formatPreferenceRank(igc, 'carousel') < formatPreferenceRank(both, 'carousel'));
  assert.ok(formatPreferenceRank(both, 'carousel') < formatPreferenceRank(reelsL, 'carousel'));
  // image: low-effort both/reels leads
  assert.ok(formatPreferenceRank(reelsS, 'image') < formatPreferenceRank(reelsL, 'image'));
  assert.ok(formatPreferenceRank(reelsL, 'image') < formatPreferenceRank(igc, 'image'));
  // story: ig-story leads
  assert.ok(formatPreferenceRank(igStory, 'story') < formatPreferenceRank(both, 'story'));
});

// A pool with one purpose-built carousel idea + higher-scored `both` ideas.
const MIXED = [
  { id: 'BOTH_HI', platform: 'both', score: 100, effort: 'M' },
  { id: 'CAROUSEL', platform: 'ig-carousel', score: 40, effort: 'M' },
  { id: 'BOTH_MID', platform: 'both', score: 80, effort: 'M' },
  { id: 'IMG_S', platform: 'both', score: 55, effort: 'S' },
];

test('a carousel slot picks the purpose-built ig-carousel idea first, despite a lower score', () => {
  const items = planWeek({
    ideas: MIXED,
    cadence: { instagram_per_day: 1, tiktok_per_day: 0, candidates_per_slot: 1, quiet_days: [] },
    slotTimes: SLOT_TIMES,
    timezone: 'Europe/Tirane',
    startDate: '2026-07-13', // T+1 = 2026-07-14 (Tuesday, ISO 2) → carousel
    horizonDays: 1,
  });
  const slot = items[0];
  assert.equal(slot.format, 'carousel');
  assert.equal(slot.idea_id, 'CAROUSEL', 'carousel tier beats raw score');
});

test('an image slot prefers a low-effort (S) idea over a higher-scored heavier one', () => {
  const items = planWeek({
    ideas: MIXED,
    cadence: { instagram_per_day: 1, tiktok_per_day: 0, candidates_per_slot: 1, quiet_days: [] },
    slotTimes: SLOT_TIMES,
    timezone: 'Europe/Tirane',
    startDate: '2026-07-15', // T+1 = 2026-07-16 (Thursday, ISO 4) → image
    horizonDays: 1,
  });
  const slot = items[0];
  assert.equal(slot.format, 'image');
  assert.equal(slot.idea_id, 'IMG_S', 'S-effort tier beats higher-scored M-effort');
});

/* ── determinism + planned variety across a week ────────────────────────── */

const WEEK_IDEAS = [
  { id: 'A', platform: 'both', score: 100 },
  { id: 'B', platform: 'ig-carousel', score: 90 },
  { id: 'C', platform: 'both', score: 85, effort: 'S' },
  { id: 'D', platform: 'ig-carousel', score: 70 },
  { id: 'E', platform: 'reels', score: 65, effort: 'S' },
  { id: 'F', platform: 'both', score: 60 },
  { id: 'G', platform: 'tiktok', score: 95 },
  { id: 'H', platform: 'tiktok', score: 80 },
];
const WEEK_OPTS = {
  ideas: WEEK_IDEAS,
  cadence: CADENCE,
  slotTimes: SLOT_TIMES,
  timezone: 'Europe/Tirane',
  startDate: '2026-07-13',
  horizonDays: 7,
};

test('planWeek with a format mix is deterministic and yields a varied IG week', () => {
  const a = planWeek(WEEK_OPTS);
  const b = planWeek(WEEK_OPTS);
  assert.deepEqual(a, b, 'same inputs → same plan');

  const igFormats = a
    .filter((i) => i.platform === 'instagram')
    .sort((x, y) => x.slot_at.localeCompare(y.slot_at))
    .filter((i, idx, arr) => arr.findIndex((z) => z.slot_at === i.slot_at) === idx) // one per day
    .map((i) => i.format);
  // Tue carousel, Wed reel, Thu image, Fri carousel, Sat reel, Sun reel, Mon reel
  assert.deepEqual(igFormats, ['carousel', 'reel', 'image', 'carousel', 'reel', 'reel', 'reel']);

  // Every TikTok slot is a video.
  assert.ok(a.filter((i) => i.platform === 'tiktok').every((i) => i.format === 'tiktok_video'));
});

test('slots are always filled to candidates_per_slot with distinct ideas within the group', () => {
  const items = planWeek(WEEK_OPTS);
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.candidate_group)) groups.set(it.candidate_group, []);
    groups.get(it.candidate_group).push(it.idea_id);
  }
  for (const [cg, ids] of groups) {
    assert.equal(ids.length, 3, `${cg} has 3 candidates`);
    assert.equal(new Set(ids).size, 3, `${cg} candidates use distinct ideas`);
  }
});
