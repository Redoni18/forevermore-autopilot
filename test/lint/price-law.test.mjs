import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPriceLaw } from '../../src/lint/rules/price-law.mjs';

function rules(item) {
  return checkPriceLaw(item, {}).map((v) => v.rule);
}

test('price-law: "$15" alone passes', () => {
  assert.deepEqual(rules({ caption: 'gift a world for $15' }), []);
});

test('price-law: "$45" alone passes', () => {
  assert.deepEqual(rules({ caption: 'the premium tier is $45' }), []);
});

test('price-law: "from $250" passes', () => {
  assert.deepEqual(rules({ caption: 'custom worlds start from $250' }), []);
});

test('price-law: bare "$250" without "from" blocks', () => {
  assert.ok(rules({ caption: 'custom worlds cost $250' }).includes('price-law:bare-250'));
});

test('price-law: "$40 credit pack" in caption blocks (AC tricky case)', () => {
  // $40 credit packs are real (brand-guide.md §2) but only in learning docs —
  // captions/overlays may only ever carry $15, $45, or "from $250".
  const violations = checkPriceLaw({ caption: 'grab the $40 credit pack while you can' }, {});
  assert.ok(violations.some((v) => v.rule === 'price-law:disallowed-amount' && v.severity === 'block'));
});

test('price-law: any other bare dollar amount blocks', () => {
  for (const amount of ['$20', '$60', '$99', '$110', '$139']) {
    const violations = checkPriceLaw({ caption: `gifts start at ${amount} today` }, {});
    assert.ok(
      violations.some((v) => v.rule === 'price-law:disallowed-amount'),
      `expected ${amount} to block`,
    );
  }
});

test('price-law: "$30" passes ONLY when both $15 and $45 appear in the same text (AC tricky case)', () => {
  // the script-pack precedent (tiktok-scripts.md S12): "here's what $30
  // actually buys you" alongside "$15 — Sticker Book" and "$45 — Drive-In Night".
  const withBoth = {
    caption: "here's what $30 actually buys you: $15 gets Sticker Book, $45 gets Drive-In Night.",
  };
  assert.deepEqual(rules(withBoth), []);
});

test('price-law: "$30" blocks when $15 and $45 are NOT both present', () => {
  const missingOperand = { caption: "here's what $30 actually buys you today, no other numbers here." };
  assert.ok(rules(missingOperand).includes('price-law:disallowed-amount'));

  const onlyOneOperand = { caption: "here's what $30 buys vs the $15 tier" };
  assert.ok(rules(onlyOneOperand).includes('price-law:disallowed-amount'));
});

test('price-law: "was $X now $Y" strike pattern blocks even when $Y is canonical', () => {
  const violations = checkPriceLaw({ caption: 'was $90, now $45 — today only' }, {});
  assert.ok(violations.some((v) => v.rule === 'price-law:was-now-strike'));
});

test('price-law: markdown-style strikethrough around a price blocks', () => {
  const violations = checkPriceLaw({ caption: 'no longer ~~$60~~ just $45' }, {});
  assert.ok(violations.some((v) => v.rule === 'price-law:strikethrough-markup'));
});

test('price-law: overlays are scanned the same as captions', () => {
  const violations = checkPriceLaw({ overlays: { hook: 'only $99 today', beats: [] } }, {});
  assert.ok(violations.some((v) => v.rule === 'price-law:disallowed-amount' && v.excerpt.includes('overlays.hook')));
});

test('price-law: text with no dollar signs passes cleanly', () => {
  assert.deepEqual(rules({ caption: 'give them a whole world, built from your photos' }), []);
});
