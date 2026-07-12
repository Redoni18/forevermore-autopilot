import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStyle } from '../../src/lint/rules/style.mjs';
import { FIXTURE_CATALOG } from './fixtures/catalog.fixture.mjs';

function rules(item, ctx = {}) {
  return checkStyle(item, ctx).map((v) => v.rule);
}

test('style: a Title Case run of 4+ words in overlay hook/beats blocks', () => {
  const item = { overlays: { hook: 'Give Them Everything Today', beats: [] } };
  assert.ok(rules(item).includes('style:title-case-run'));
});

test('style: normal sentence case in overlay hook/beats passes', () => {
  const item = { overlays: { hook: 'give them everything today', beats: [] } };
  assert.equal(rules(item).includes('style:title-case-run'), false);
});

test('style: sentence-case allows "The Blockheart Mine drops today." (AC tricky case)', () => {
  const item = { overlays: { hook: 'The Blockheart Mine drops today.', beats: [] } };
  const ctx = { catalog: FIXTURE_CATALOG };
  assert.equal(rules(item, ctx).includes('style:title-case-run'), false);
});

test('style: catalog world-name masking prevents false positives on longer proper nouns', () => {
  // Without masking, "The Blockheart Mine Awaits Tonight" is 5 consecutive
  // Title-Case words and would wrongly block; masking the catalog name first
  // leaves only "Awaits Tonight" (2 words) — under threshold.
  const item = { overlays: { hook: 'The Blockheart Mine Awaits Tonight', beats: [] } };
  const ctx = { catalog: FIXTURE_CATALOG };
  assert.equal(rules(item, ctx).includes('style:title-case-run'), false);
});

test('style: without catalog context, the same long proper-noun run does block', () => {
  const item = { overlays: { hook: 'The Blockheart Mine Awaits Tonight', beats: [] } };
  assert.ok(rules(item, { catalog: [] }).includes('style:title-case-run'));
});

test('style: caption text is NOT scanned for title-case runs (ticket scopes this to overlays only)', () => {
  const item = { caption: 'Give Them Everything Today' };
  assert.equal(rules(item).includes('style:title-case-run'), false);
});

test('style: any exclamation mark in the caption blocks', () => {
  const violations = checkStyle({ caption: 'we love this so much!' }, {});
  assert.ok(violations.some((v) => v.rule === 'style:exclamation-marks' && v.severity === 'block'));
});

test('style: captions with zero exclamation marks pass', () => {
  const violations = checkStyle({ caption: 'we love this so much' }, {});
  assert.equal(violations.some((v) => v.rule === 'style:exclamation-marks'), false);
});

test('style: TikTok caption with 6 hashtags blocks (AC tricky case)', () => {
  const item = { platform: 'tiktok', hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] };
  assert.ok(rules(item).includes('style:hashtag-count'));
});

test('style: TikTok caption with 5 hashtags (the limit) passes', () => {
  const item = { platform: 'tiktok', hashtags: ['a', 'b', 'c', 'd', 'e'] };
  assert.equal(rules(item).includes('style:hashtag-count'), false);
});

test('style: Instagram caption with 11 hashtags blocks', () => {
  const item = { platform: 'instagram', hashtags: Array.from({ length: 11 }, (_, i) => `tag${i}`) };
  assert.ok(rules(item).includes('style:hashtag-count'));
});

test('style: Instagram caption with 10 hashtags (the limit) passes', () => {
  const item = { platform: 'instagram', hashtags: Array.from({ length: 10 }, (_, i) => `tag${i}`) };
  assert.equal(rules(item).includes('style:hashtag-count'), false);
});

test('style: TikTok caption over 150 chars (pre-tags) warns, not blocks', () => {
  const item = { platform: 'tiktok', caption: 'x'.repeat(151) };
  const violations = checkStyle(item, {});
  const hit = violations.find((v) => v.rule === 'style:caption-length');
  assert.ok(hit);
  assert.equal(hit.severity, 'warn');
});

test('style: Instagram caption over 2200 chars hard-blocks', () => {
  const item = { platform: 'instagram', caption: 'x'.repeat(2201) };
  const violations = checkStyle(item, {});
  const hit = violations.find((v) => v.rule === 'style:caption-length');
  assert.ok(hit);
  assert.equal(hit.severity, 'block');
});

test('style: caption length is measured pre-tags (trailing hashtags stripped first)', () => {
  const item = { platform: 'tiktok', caption: `${'x'.repeat(140)} #a #b #c #d #e` };
  // 140 chars of body text is under the 150-char guideline once trailing tags are stripped.
  const violations = checkStyle(item, {});
  assert.equal(violations.some((v) => v.rule === 'style:caption-length'), false);
});

test('style: clean on-brand copy has zero violations', () => {
  const item = {
    platform: 'instagram',
    caption: 'give them a whole world, built from your photos and your words',
    hashtags: ['giftideas', 'anniversarygift'],
    overlays: { hook: 'your photos, your words, and the song that is already theirs', beats: ['1 tap.'] },
  };
  assert.deepEqual(checkStyle(item, { catalog: FIXTURE_CATALOG }), []);
});
