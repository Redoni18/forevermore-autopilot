import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCarouselJobs, planImageJob } from '../src/adapters/poster.mjs';

const WORLD = { slug: 'blockheart-mine', name: 'The Blockheart Mine', tier: 'premium', description: 'A fully-3D voxel world.' };

function carouselItem(beats, { cta = 'the blockheart mine · $45 at getforevermore.co', id = 'ci_20260714_ig_1' } = {}) {
  return {
    id,
    platform: 'instagram',
    format: 'carousel',
    idea_id: 'C01',
    caption: 'swipe →',
    overlays: { hook: beats[0], beats, cta },
  };
}

/* ── carousel slide planning ────────────────────────────────────────────── */

test('carousel jobs are ordered: hook cover first, cta last, n labels are i/N', () => {
  const beats = ['he ignores me for minecraft', 'photos in the caverns', 'six heart-gems', 'the vault opens on my letter'];
  const { jobs } = planCarouselJobs(carouselItem(beats));
  assert.equal(jobs[0].params.slide, 'hook', 'first slide is the hook cover');
  assert.equal(jobs[0].params.line, beats[0]);
  assert.equal(jobs[jobs.length - 1].params.slide, 'cta', 'last slide is the cta');
  const n = jobs.length;
  jobs.forEach((j, i) => {
    assert.equal(j.page, 'carousel-slide.html');
    assert.equal(j.size, 'feed');
    assert.equal(j.out, `ci_20260714_ig_1-s${i + 1}.png`, 'out names are slide-ordered');
    assert.equal(j.params.n, `${i + 1}/${n}`);
  });
  assert.ok(n >= 2 && n <= 10, 'within IG 2..10');
});

test('carousel inserts a world slide at index 1 when a world is provided', () => {
  const beats = ['cover', 'mid a', 'mid b', 'cta line'];
  const { jobs } = planCarouselJobs(carouselItem(beats), { world: WORLD });
  assert.equal(jobs[1].params.slide, 'world');
  assert.equal(jobs[1].params.world, 'blockheart-mine');
  assert.equal(jobs[1].params.name, 'The Blockheart Mine');
  assert.equal(jobs[1].params.tier, 'premium');
});

test('carousel cta slide carries a price chip only when the copy states a price', () => {
  const beats = ['cover', 'mid', 'cta'];
  const priced = planCarouselJobs(carouselItem(beats, { cta: '$45 at getforevermore.co' })).jobs.at(-1);
  assert.equal(priced.params.pricechip, '$45 per gift');

  const noPrice = planCarouselJobs(carouselItem(beats, { cta: 'open their world at getforevermore.co' })).jobs.at(-1);
  assert.equal(noPrice.params.pricechip, undefined, 'no price in copy → no price chip');
});

test('carousel clamps to IG 10-slide limit and warns, always keeping cover + cta', () => {
  // 12 beats → cover + 10 middle + cta = 12 specs, must clamp to 10.
  const beats = Array.from({ length: 12 }, (_, i) => `beat ${i}`);
  const { jobs, warnings } = planCarouselJobs(carouselItem(beats));
  assert.equal(jobs.length, 10, 'clamped to the IG hard limit');
  assert.equal(jobs[0].params.slide, 'hook', 'cover preserved');
  assert.equal(jobs.at(-1).params.slide, 'cta', 'cta preserved');
  assert.equal(jobs.at(-1).params.n, '10/10');
  assert.ok(warnings.length === 1 && /exceeds the IG limit/.test(warnings[0]));
});

test('carousel with a world slide still clamps to 10 with the cta intact', () => {
  const beats = Array.from({ length: 12 }, (_, i) => `beat ${i}`);
  const { jobs } = planCarouselJobs(carouselItem(beats), { world: WORLD });
  assert.equal(jobs.length, 10);
  assert.equal(jobs[1].params.slide, 'world');
  assert.equal(jobs.at(-1).params.slide, 'cta');
});

/* ── image job planning ─────────────────────────────────────────────────── */

test('image job uses quote-card with the hook as the line when no world', () => {
  const item = { id: 'ci_20260716_ig_2', platform: 'instagram', format: 'image', overlays: { hook: 'the burnt-pancake anniversary', beats: ['you kept the recipe'], cta: 'x' } };
  const job = planImageJob(item);
  assert.equal(job.page, 'quote-card.html');
  assert.equal(job.params.line, 'the burnt-pancake anniversary');
  assert.equal(job.params.sub, 'you kept the recipe');
  assert.ok(['gift', 'album', 'book'].includes(job.params.mascot));
  assert.equal(job.out, 'ci_20260716_ig_2.png');
});

test('image job uses world-drop when the idea references an active world', () => {
  const item = { id: 'ci_20260716_ig_1', platform: 'instagram', format: 'image', overlays: { hook: 'h', beats: [], cta: 'x' } };
  const job = planImageJob(item, { world: WORLD });
  assert.equal(job.page, 'world-drop.html');
  assert.equal(job.params.world, 'blockheart-mine');
  assert.equal(job.params.tier, 'premium');
});

test('image mascot rotates deterministically by candidate variant', () => {
  const mk = (n) => planImageJob({ id: `ci_x_${n}`, platform: 'instagram', format: 'image', overlays: { hook: 'h', beats: [], cta: 'x' } }).params.mascot;
  assert.equal(mk(1), 'gift'); // variant 0
  assert.equal(mk(2), 'album'); // variant 1
  assert.equal(mk(3), 'book'); // variant 2
  assert.equal(mk(4), 'gift'); // wraps
});
