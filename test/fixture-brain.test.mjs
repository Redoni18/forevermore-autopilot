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
