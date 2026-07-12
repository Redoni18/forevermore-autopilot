import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWeek } from '../src/plan/planner.mjs';
import { ideaEligibleFor, formatFor, riskFor } from '../src/plan/ideas.mjs';
import { zonedISO, addDays, offsetString } from '../src/util/time.mjs';
import { IDEAS_FIXTURE } from './helpers.mjs';

const CADENCE = { instagram_per_day: 1, tiktok_per_day: 1, candidates_per_slot: 3, quiet_days: [] };
const SLOT_TIMES = { instagram: '17:30', tiktok: '19:00' };
const BASE = {
  ideas: IDEAS_FIXTURE,
  cadence: CADENCE,
  slotTimes: SLOT_TIMES,
  timezone: 'Europe/Tirane',
  startDate: '2026-07-13',
  horizonDays: 7,
};

test('planWeek is deterministic: identical inputs → identical output', () => {
  const a = planWeek(BASE);
  const b = planWeek(BASE);
  assert.deepEqual(a, b);
});

test('planWeek honors D-6 cadence: 1 IG + 1 TT slot/day × 7 days × 3 candidates = 42', () => {
  const items = planWeek(BASE);
  assert.equal(items.length, 42);

  // group by candidate_group → 14 groups of 3
  const groups = new Map();
  for (const it of items) {
    groups.set(it.candidate_group, (groups.get(it.candidate_group) || 0) + 1);
  }
  assert.equal(groups.size, 14);
  for (const n of groups.values()) assert.equal(n, 3);
});

test('shells carry deterministic ids, shared candidate_group, and correct slot_at offset', () => {
  const items = planWeek(BASE);
  const firstDay = addDays(BASE.startDate, 1); // 2026-07-14
  const ig = items.filter((i) => i.id.startsWith(`ci_20260714_ig_`));
  assert.deepEqual(
    ig.map((i) => i.id).sort(),
    ['ci_20260714_ig_1', 'ci_20260714_ig_2', 'ci_20260714_ig_3'],
  );
  for (const i of ig) {
    assert.equal(i.candidate_group, 'cg_20260714_ig');
    assert.equal(i.platform, 'instagram');
    assert.equal(i.status, 'planned');
    assert.equal(i.slot_at, zonedISO(firstDay, '17:30', 'Europe/Tirane'));
    assert.ok(i.slot_at.endsWith('+02:00'), 'Tirane is +02:00 in July');
    assert.match(i.link_utm, /utm_source=instagram/);
    assert.match(i.link_utm, /utm_content=ci_20260714_ig_/);
  }

  // candidates within a slot use distinct ideas
  const ideaIds = ig.map((i) => i.idea_id);
  assert.equal(new Set(ideaIds).size, ideaIds.length);
});

test('produced_by is null in the pure planner (kept out for reproducibility)', () => {
  const items = planWeek(BASE);
  assert.ok(items.every((i) => i.produced_by === null));
  const stamped = planWeek({ ...BASE, producedBy: 'run_1' });
  assert.ok(stamped.every((i) => i.produced_by === 'run_1'));
});

test('recency penalty reorders candidate selection deterministically', () => {
  // 3 IG-eligible ideas; highest score is A.
  const ideas = [
    { id: 'A', pillar: 'P1', platform: 'both', score: 100, hook: 'a' },
    { id: 'B', pillar: 'P1', platform: 'both', score: 90, hook: 'b' },
    { id: 'C', pillar: 'P1', platform: 'both', score: 80, hook: 'c' },
  ];
  const opts = {
    ideas,
    cadence: { instagram_per_day: 1, tiktok_per_day: 0, candidates_per_slot: 3, quiet_days: [] },
    slotTimes: SLOT_TIMES,
    timezone: 'Europe/Tirane',
    startDate: '2026-07-13',
    horizonDays: 1,
  };
  // no usage → A is candidate 1
  const fresh = planWeek(opts);
  assert.equal(fresh.find((i) => i.id.endsWith('_1')).idea_id, 'A');

  // A used the day before the slot → heavy penalty → B leads
  const penalized = planWeek({ ...opts, usage: { A: { last_used_at: '2026-07-13', uses: 1 } } });
  assert.equal(penalized.find((i) => i.id.endsWith('_1')).idea_id, 'B');
});

test('quiet_days skip that weekday', () => {
  // 2026-07-14 is a Tuesday (ISO weekday 2). Quiet Tuesday removes it.
  const items = planWeek({ ...BASE, cadence: { ...CADENCE, quiet_days: [2] } });
  assert.ok(!items.some((i) => i.slot_at.startsWith('2026-07-14')), 'Tuesday should be skipped');
  assert.ok(items.some((i) => i.slot_at.startsWith('2026-07-15')), 'other days remain');
});

test('platform/format/risk mapping', () => {
  const both = IDEAS_FIXTURE.find((i) => i.id === 'I01');
  const carousel = IDEAS_FIXTURE.find((i) => i.id === 'I05');
  const story = IDEAS_FIXTURE.find((i) => i.id === 'I06');
  const tiktok = IDEAS_FIXTURE.find((i) => i.id === 'I03');

  assert.ok(ideaEligibleFor(both, 'instagram') && ideaEligibleFor(both, 'tiktok'));
  assert.ok(!ideaEligibleFor(tiktok, 'instagram'));
  assert.ok(!ideaEligibleFor(carousel, 'tiktok'));

  assert.equal(formatFor(both, 'instagram'), 'reel');
  assert.equal(formatFor(both, 'tiktok'), 'tiktok_video');
  assert.equal(formatFor(carousel, 'instagram'), 'carousel');
  assert.equal(formatFor(story, 'instagram'), 'story');

  assert.equal(riskFor({ title: 'a memorial for grandma', occasions: [], worlds: [] }), 'sensitive');
  assert.equal(riskFor({ title: 'anniversary reel', occasions: ['anniversary'], worlds: [] }), 'standard');
});

test('time helpers', () => {
  assert.equal(zonedISO('2026-07-14', '17:30', 'Europe/Tirane'), '2026-07-14T17:30:00+02:00');
  // winter → +01:00 for Tirane
  assert.equal(zonedISO('2026-01-14', '09:00', 'Europe/Tirane'), '2026-01-14T09:00:00+01:00');
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(offsetString(120), '+02:00');
  assert.equal(offsetString(-330), '-05:30');
  assert.equal(offsetString(0), '+00:00');
});
