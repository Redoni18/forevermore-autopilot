import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorldReferences } from '../../src/lint/rules/world-checks.mjs';
import { FIXTURE_CATALOG } from './fixtures/catalog.fixture.mjs';

function rules(item) {
  return checkWorldReferences(item, { catalog: FIXTURE_CATALOG }).map((v) => v.rule);
}

test('world-checks: mentioning an active world in caption/overlays passes', () => {
  const item = { caption: 'watch it become Sticker Book, sealed page by page' };
  assert.deepEqual(rules(item), []);
});

test('world-checks: mentioning an inactive world blocks with active alternates named (AC tricky case)', () => {
  const item = { caption: 'a Star Map Letter for the two of you' };
  const violations = checkWorldReferences(item, { catalog: FIXTURE_CATALOG });
  const hit = violations.find((v) => v.rule === 'world-checks:inactive-world');
  assert.ok(hit, 'expected an inactive-world violation');
  assert.equal(hit.severity, 'block');
  assert.match(hit.excerpt, /Star Map Letter/);
  assert.match(hit.excerpt, /alternates/i);
  // alternates should be active + same tier (standard)
  assert.match(hit.excerpt, /Birthday Trolley|Blooming Message Garden|Sticker Book/);
});

test('world-checks: "The " prefix is optional — bare name also matches', () => {
  const item = { caption: 'take the pickaxe and step into Blockheart Mine' };
  assert.deepEqual(rules(item), []); // active, so no violation either way
});

test('world-checks: explicit item.worlds referencing an unknown world blocks', () => {
  const item = { worlds: ['a-made-up-world'], caption: 'no mention in text' };
  const violations = checkWorldReferences(item, { catalog: FIXTURE_CATALOG });
  assert.ok(violations.some((v) => v.rule === 'world-checks:unknown-world'));
});

test('world-checks: explicit item.worlds referencing an inactive world blocks with tier-matched alternates', () => {
  const item = { worlds: ['golden-claw'] }; // premium, inactive in the fixture
  const violations = checkWorldReferences(item, { catalog: FIXTURE_CATALOG });
  const hit = violations.find((v) => v.rule === 'world-checks:inactive-world');
  assert.ok(hit);
  assert.match(hit.excerpt, /premium/);
  assert.match(hit.excerpt, /The Blockheart Mine|Drive-In Night/);
});

test('world-checks: explicit item.world (singular) referencing an active world by slug passes', () => {
  const item = { world: 'birthday-trolley' };
  assert.deepEqual(rules(item), []);
});

test('world-checks: no world mention anywhere produces no violations', () => {
  const item = { caption: 'give them a whole world, built from your photos' };
  assert.deepEqual(rules(item), []);
});
