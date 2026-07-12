import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSafeArea } from '../../src/lint/rules/safe-area.mjs';

test('safe-area: no overlay coords at all skips silently (base {hook,beats} shape)', () => {
  const item = { overlays: { hook: 'hello', beats: ['one', 'two'] } };
  assert.deepEqual(checkSafeArea(item, {}), []);
});

test('safe-area: no overlays field at all skips silently', () => {
  assert.deepEqual(checkSafeArea({ caption: 'hi' }, {}), []);
});

test('safe-area: a chip fully inside the safe zone passes', () => {
  const item = { overlays: { hook: 'hi', chips: [{ text: 'CTA', x: 100, y: 100, w: 200, h: 100 }] } };
  assert.deepEqual(checkSafeArea(item, {}), []);
});

test('safe-area: a chip intersecting the bottom gutter blocks (AC tricky case)', () => {
  // bottom gutter = y in [1600, 1920] across the full 1080px width
  const item = { overlays: { chips: [{ text: 'CTA', x: 100, y: 1700, w: 200, h: 100 }] } };
  const violations = checkSafeArea(item, {});
  assert.ok(violations.some((v) => v.rule === 'safe-area:gutter-intersection' && v.severity === 'block'));
  assert.match(violations[0].excerpt, /bottom/);
});

test('safe-area: a chip intersecting the right gutter blocks', () => {
  // right gutter = x in [940, 1080] across the full 1920px height
  const item = { overlays: { chips: [{ text: 'CTA', x: 1000, y: 100, w: 100, h: 100 }] } };
  const violations = checkSafeArea(item, {});
  assert.ok(violations.some((v) => v.rule === 'safe-area:gutter-intersection'));
  assert.match(violations[0].excerpt, /right/);
});

test('safe-area: a chip intersecting both gutters reports both', () => {
  const item = { overlays: { chips: [{ text: 'CTA', x: 1000, y: 1700, w: 60, h: 60 }] } };
  const violations = checkSafeArea(item, {});
  assert.match(violations[0].excerpt, /bottom \+ right|right \+ bottom/);
});

test('safe-area: geometry nested arbitrarily deep is still found', () => {
  const item = {
    overlays: {
      hook: 'hi',
      beats: ['one'],
      scenes: [{ chips: [{ x: 0, y: 0, w: 50, h: 50 }, { x: 950, y: 1650, w: 100, h: 100 }] }],
    },
  };
  const violations = checkSafeArea(item, {});
  assert.equal(violations.length, 1);
});

test('safe-area: multiple bad chips each produce their own violation', () => {
  const item = {
    overlays: {
      chips: [
        { x: 100, y: 1700, w: 50, h: 50 }, // bottom
        { x: 1000, y: 100, w: 50, h: 50 }, // right
      ],
    },
  };
  const violations = checkSafeArea(item, {});
  assert.equal(violations.length, 2);
});

test('safe-area: non-numeric or partial coordinate fields are ignored, not crashed on', () => {
  const item = { overlays: { chips: [{ text: 'CTA', x: 'left', y: 100, w: 200, h: 100 }] } };
  assert.deepEqual(checkSafeArea(item, {}), []);
});
