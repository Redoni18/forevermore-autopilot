import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNounLaw } from '../../src/lint/rules/noun-law.mjs';

test('noun-law: watched noun within 3 tokens of "gift" warns, not blocks', () => {
  const violations = checkNounLaw({ caption: 'the gift experience is ready for them' }, {});
  const hit = violations.find((v) => v.rule === 'noun-law:watched-noun');
  assert.ok(hit, 'expected a watched-noun violation');
  assert.equal(hit.severity, 'warn');
});

test('noun-law: watched noun outside the 3-token window does not warn', () => {
  // "platform" and "world" are 4 tokens apart here — outside the window.
  const violations = checkNounLaw({ caption: 'platform one two three world' }, {});
  assert.equal(violations.some((v) => v.rule === 'noun-law:watched-noun'), false);
});

test('noun-law: watched noun with no gift/world context anywhere nearby stays clean', () => {
  const violations = checkNounLaw({ caption: 'this platform update rolled out last week' }, {});
  assert.equal(violations.some((v) => v.rule === 'noun-law:watched-noun'), false);
});

test('noun-law: all four watched nouns are covered', () => {
  for (const noun of ['experience', 'platform', 'product', 'content']) {
    const violations = checkNounLaw({ caption: `this gift ${noun} is unlike anything else` }, {});
    assert.ok(
      violations.some((v) => v.rule === 'noun-law:watched-noun'),
      `expected "${noun}" near "gift" to warn`,
    );
  }
});

test('noun-law: "e-card" blocks unless negated', () => {
  const violations = checkNounLaw({ caption: "it's basically just an e-card" }, {});
  assert.ok(violations.some((v) => v.rule === 'noun-law:forbidden-noun' && v.severity === 'block'));
});

test('noun-law: "not an e-card" (negated) passes', () => {
  const violations = checkNounLaw({ caption: "it's not an e-card, it's a whole world" }, {});
  assert.equal(violations.some((v) => v.rule === 'noun-law:forbidden-noun'), false);
});

test('noun-law: "slideshow" blocks unless negated', () => {
  const violations = checkNounLaw({ caption: 'just a fancy slideshow, nothing more' }, {});
  assert.ok(violations.some((v) => v.rule === 'noun-law:forbidden-noun'));
});

test('noun-law: "not a slideshow" (negated) passes', () => {
  const violations = checkNounLaw({ caption: 'not a slideshow, a place to walk through' }, {});
  assert.equal(violations.some((v) => v.rule === 'noun-law:forbidden-noun'), false);
});

test('noun-law: "ecard" (no hyphen) is also caught', () => {
  const violations = checkNounLaw({ caption: 'more than an ecard could ever be' }, {});
  assert.ok(violations.some((v) => v.rule === 'noun-law:forbidden-noun'));
});

test('noun-law: clean on-brand copy has zero violations', () => {
  const item = { caption: 'not a card. not a slideshow. a place.' };
  assert.deepEqual(checkNounLaw(item, {}), []);
});
