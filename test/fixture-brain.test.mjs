import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureBrain } from '../src/drivers/fixture-brain.mjs';
import { resolveBrainDriver } from '../src/drivers/brain-driver.mjs';

const IDEA = {
  id: 'I01',
  hook: 'he ignores me for minecraft, so i said it in his language.',
  beats: ['so i met him there.', 'and left a note in the last chunk.'],
  cta: 'getforevermore.co — from $15',
  worlds: ['Gone Fishing'],
  occasions: ['anniversary'],
};

test('fixture fills copy fields and respects hashtag caps', async () => {
  const brain = new FixtureBrain();

  const ig = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_ig_1', platform: 'instagram' },
    idea: IDEA,
  });
  assert.ok(ig.caption.length > 0);
  assert.ok(ig.overlays.hook.startsWith('he ignores'));
  assert.deepEqual(ig.overlays.beats, IDEA.beats.slice(0, 2));
  assert.ok(ig.hashtags.length <= 10);
  assert.equal(ig.meta.driver, 'fixture');
  assert.equal(ig.meta.cost_usd, 0);

  const tt = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_tt_1', platform: 'tiktok' },
    idea: IDEA,
  });
  assert.ok(tt.hashtags.length <= 5, 'tiktok cap is 5');
});

test('fixture is deterministic', async () => {
  const brain = new FixtureBrain();
  const req = { stage: 'copywriter', item: { id: 'x', platform: 'instagram' }, idea: IDEA };
  assert.deepEqual(await brain.complete(req), await brain.complete(req));
});

/* ── AP-820: format-aware copy shapes ───────────────────────────────────── */

const CAROUSEL_IDEA = {
  id: 'C01',
  hook: 'he ignores me for minecraft, so i said it in his language.',
  beats: ['took the pickaxe from the spawn chest', 'our photos were waiting in the caverns', 'six heart-gems, one vault door', 'he can keep the diamonds, i want the vault'],
  cta: 'the blockheart mine · $45 at getforevermore.co',
  worlds: ['The Blockheart Mine'],
  occasions: ['anniversary'],
};

test('carousel: overlays.beats become 5–7 slide texts, cover echoes hook, last beat is the cta line', async () => {
  const brain = new FixtureBrain();
  const r = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_ig_1', platform: 'instagram', format: 'carousel' },
    idea: CAROUSEL_IDEA,
  });
  const beats = r.overlays.beats;
  assert.ok(beats.length >= 5 && beats.length <= 7, `expected 5–7 slide texts, got ${beats.length}`);
  assert.equal(beats[0], r.overlays.hook, 'slide 1 is the hook cover');
  assert.equal(beats[beats.length - 1], r.overlays.cta, 'last slide text is the cta line (cta ≤90 here)');
  assert.ok(beats.every((b) => b.length <= 90), 'each slide text ≤90 chars');
  assert.ok(r.caption.length > 0);
  assert.equal((r.caption.match(/!/g) || []).length, 0, 'no exclamation marks (lint)');
});

test('carousel: reads format from inputs.formatSpec when item.format is absent', async () => {
  const brain = new FixtureBrain();
  const r = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_ig_1', platform: 'instagram' },
    idea: CAROUSEL_IDEA,
    inputs: { formatSpec: { platform: 'instagram', format: 'carousel' } },
  });
  assert.ok(r.overlays.beats.length >= 5);
});

test('image: hook is the single line (≤80), beats is at most one sub-line, caption storytells', async () => {
  const brain = new FixtureBrain();
  const r = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_ig_1', platform: 'instagram', format: 'image' },
    idea: CAROUSEL_IDEA,
  });
  assert.ok(r.overlays.hook.length <= 80, 'image hook ≤80 chars');
  assert.ok(r.overlays.beats.length <= 1, 'image carries ≤1 sub-line');
  assert.ok(r.caption.includes(r.overlays.cta), 'caption carries the story + cta');
});

test('reel shape is unchanged for tiktok_video / default formats', async () => {
  const brain = new FixtureBrain();
  const tt = await brain.complete({
    stage: 'copywriter',
    item: { id: 'ci_tt_1', platform: 'tiktok', format: 'tiktok_video' },
    idea: IDEA,
  });
  assert.deepEqual(tt.overlays.beats, IDEA.beats.slice(0, 2));
  assert.equal(tt.overlays.hook, IDEA.hook.split('\n')[0]);
});

test('resolveBrainDriver: fixture default, mock stand-in, real drivers bridge or error', async () => {
  const d = await resolveBrainDriver('fixture');
  assert.equal(d.name, 'fixture');

  // mock → AP-301 MockDriver when merged, else the deterministic fixture; both
  // satisfy the BrainDriver contract.
  const m = await resolveBrainDriver('mock');
  assert.equal(typeof m.complete, 'function');

  // unknown → always an error (AP-301's makeDriver rejects it, or the seam does)
  await assert.rejects(() => resolveBrainDriver('nonsense'));

  // claude-cli bridges to AP-301 when present, else errors with guidance.
  try {
    const c = await resolveBrainDriver('claude-cli');
    assert.equal(typeof c.complete, 'function');
  } catch (e) {
    assert.match(String(e.message), /AP-301|brain/i);
  }
});
