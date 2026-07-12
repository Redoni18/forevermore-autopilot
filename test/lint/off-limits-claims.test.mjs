import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOffLimitsClaims } from '../../src/lint/rules/off-limits-claims.mjs';

function rules(item) {
  return checkOffLimitsClaims(item, {}).map((v) => v.rule);
}

test('off-limits-claims: scheduled/timed delivery promises block', () => {
  assert.ok(rules({ caption: "we'll deliver it on the day you choose" }).includes('off-limits-claims:scheduled-delivery'));
  assert.ok(rules({ caption: 'it arrives on their birthday morning' }).includes('off-limits-claims:scheduled-delivery'));
  assert.ok(rules({ caption: 'schedule it for the exact moment' }).includes('off-limits-claims:scheduled-delivery'));
});

test('off-limits-claims: "a keepsake copy to download" blocks', () => {
  const violations = checkOffLimitsClaims({ caption: 'get a keepsake copy to download after' }, {});
  assert.ok(violations.some((v) => v.rule === 'off-limits-claims:keepsake-download'));
});

test('off-limits-claims: bare "keepsake" (not "keepsake copy") does not trip the download rule', () => {
  const violations = checkOffLimitsClaims({ caption: 'the finished map becomes the keepsake' }, {});
  assert.equal(violations.some((v) => v.rule === 'off-limits-claims:keepsake-download'), false);
});

test('off-limits-claims: "No app. No account. No download." approved verbatim passes', () => {
  const violations = checkOffLimitsClaims({ caption: 'No app. No account. No download.' }, {});
  assert.equal(violations.some((v) => v.rule === 'off-limits-claims:download-claim'), false);
});

test('off-limits-claims: an unnegated downloadability claim blocks', () => {
  const violations = checkOffLimitsClaims({ caption: 'download your gift as a keepsake' }, {});
  assert.ok(violations.some((v) => v.rule === 'off-limits-claims:download-claim'));
});

test('off-limits-claims: recipient reply/reaction feature claims block', () => {
  assert.ok(rules({ caption: 'and they can reply right there in the world' }).includes('off-limits-claims:recipient-reply'));
  assert.ok(rules({ caption: 'recipients can react to every letter' }).includes('off-limits-claims:recipient-reply'));
});

test('off-limits-claims: "forever" framed as a guarantee blocks (AC tricky case)', () => {
  const violations = checkOffLimitsClaims({ caption: 'your love stays forever guaranteed' }, {});
  assert.ok(violations.some((v) => v.rule === 'off-limits-claims:forever-guarantee' && v.severity === 'block'));
});

test('off-limits-claims: "never goes away" blocks', () => {
  const violations = checkOffLimitsClaims({ caption: 'this gift never goes away, we promise' }, {});
  assert.ok(violations.some((v) => v.rule === 'off-limits-claims:forever-guarantee'));
});

test('off-limits-claims: approved forever verbatims pass (AC tricky case)', () => {
  assert.deepEqual(rules({ caption: "Pay once. It's theirs forever." }), []);
  assert.deepEqual(rules({ caption: 'it stays theirs, no subscription ever' }), []);
  assert.deepEqual(rules({ caption: 'theirs to keep, always' }), []);
});

test('off-limits-claims: AI mentions block', () => {
  assert.ok(rules({ caption: 'built with AI in seconds' }).includes('off-limits-claims:ai-mention'));
  assert.ok(rules({ caption: 'this world is ai-generated for you' }).includes('off-limits-claims:ai-mention'));
});

test('off-limits-claims: hand-built framing does not trip the AI check', () => {
  const violations = checkOffLimitsClaims(
    { caption: 'hand-built worlds, filled with your own photos and words' },
    {},
  );
  assert.equal(violations.some((v) => v.rule === 'off-limits-claims:ai-mention'), false);
});

test('off-limits-claims: invented stats block', () => {
  assert.ok(rules({ caption: 'join 10,000 happy customers today' }).includes('off-limits-claims:invented-stats'));
  assert.ok(rules({ caption: 'over 500 gifts sold this week' }).includes('off-limits-claims:invented-stats'));
});

test('off-limits-claims: fake urgency blocks', () => {
  assert.ok(rules({ caption: 'limited spots available, act now' }).includes('off-limits-claims:fake-urgency'));
  assert.ok(rules({ caption: 'only 3 spots left, hurry' }).includes('off-limits-claims:fake-urgency'));
  assert.ok(rules({ caption: 'countdown is on, last chance' }).includes('off-limits-claims:fake-urgency'));
});

test('off-limits-claims: a real dated occasion is allowed (no invented deadline)', () => {
  const violations = checkOffLimitsClaims({ caption: "Father's Day is this Sunday, get yours early" }, {});
  assert.equal(violations.some((v) => v.rule === 'off-limits-claims:fake-urgency'), false);
});

test('off-limits-claims: clean on-brand copy has zero violations', () => {
  const item = {
    caption: 'give them a whole world, built from your photos and your words',
    overlays: { hook: 'you already have everything it needs', beats: ['1 tap.'] },
  };
  assert.deepEqual(checkOffLimitsClaims(item, {}), []);
});
