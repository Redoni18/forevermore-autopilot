import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDedupe } from '../../src/lint/dedupe.mjs';
import { FIXTURE_CORPUS } from './fixtures/corpus.fixture.mjs';

// Similarity values below are exact 4-gram Jaccard results against
// FIXTURE_CORPUS's 'ci_prior_1' hook ("he ignores me for minecraft so i
// said it in his language"), verified by direct computation:
//   identical                                          -> 1.0
//   "...so i said it back"                              -> 0.6    (block, >0.55)
//   "minecraft so i said it in his language, every time" -> 0.4545 (warn, in (0.40, 0.55])
//   "...so i love him anyway"                            -> 0.3333 (pass under defaults)

test('dedupe: empty corpus yields hook_sim 0 and no violation', () => {
  const { dedupe, violations } = computeDedupe({ overlays: { hook: 'anything at all here' } }, [], {});
  assert.equal(dedupe.hook_sim, 0);
  assert.equal(dedupe.nearest_item, null);
  assert.equal(dedupe.method, 'jaccard-4gram');
  assert.deepEqual(violations, []);
});

test('dedupe: no overlays.hook on the item yields hook_sim 0 and no violation', () => {
  const { dedupe, violations } = computeDedupe({ caption: 'no hook field here' }, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 0);
  assert.equal(dedupe.nearest_item, null);
  assert.deepEqual(violations, []);
});

test('dedupe: an identical hook to a corpus item blocks (sim 1.0 > 0.55)', () => {
  const item = { overlays: { hook: 'he ignores me for minecraft so i said it in his language' } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 1);
  assert.equal(dedupe.nearest_item, 'ci_prior_1');
  assert.ok(violations.some((v) => v.rule === 'dedupe:hook-similarity' && v.severity === 'block'));
});

test('dedupe: a near-duplicate hook blocks (sim 0.6 > 0.55)', () => {
  const item = { overlays: { hook: 'he ignores me for minecraft so i said it back' } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 0.6);
  assert.equal(dedupe.nearest_item, 'ci_prior_1');
  assert.ok(violations.some((v) => v.severity === 'block'));
});

test('dedupe: a moderately similar hook warns (sim 0.4545, in the (0.40, 0.55] band)', () => {
  const item = { overlays: { hook: 'minecraft so i said it in his language, every time' } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 0.4545);
  const hit = violations.find((v) => v.rule === 'dedupe:hook-similarity');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('dedupe: a dissimilar hook passes with no violation', () => {
  const item = { overlays: { hook: 'a totally different hook about sunsets and rooftops' } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 0);
  assert.deepEqual(violations, []);
});

test('dedupe: below-default-threshold similarity (0.3333) passes under default config', () => {
  const item = { overlays: { hook: 'he ignores me for minecraft so i love him anyway' } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, {});
  assert.equal(dedupe.hook_sim, 0.3333);
  assert.deepEqual(violations, []);
});

test('dedupe: custom (tightened) thresholds can flip a normally-passing item to block', () => {
  const item = { overlays: { hook: 'he ignores me for minecraft so i love him anyway' } };
  const config = { thresholds: { dedupeBlock: 0.3, dedupeWarn: 0.15 } };
  const { dedupe, violations } = computeDedupe(item, FIXTURE_CORPUS, config);
  assert.equal(dedupe.hook_sim, 0.3333);
  assert.ok(violations.some((v) => v.severity === 'block'));
});

test('dedupe: the dedupe field always has the {hook_sim, nearest_item, method} shape', () => {
  const { dedupe } = computeDedupe({ overlays: { hook: 'anything' } }, FIXTURE_CORPUS, {});
  assert.deepEqual(Object.keys(dedupe).sort(), ['hook_sim', 'method', 'nearest_item']);
});
