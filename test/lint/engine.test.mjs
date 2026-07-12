import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lintItem, RULES } from '../../src/lint/engine.mjs';
import { loadCatalog } from '../../src/lint/catalog.mjs';
import { DEFAULT_CATALOG_PATH } from '../../src/lint/config.mjs';
import { FIXTURE_CATALOG } from './fixtures/catalog.fixture.mjs';
import { FIXTURE_CORPUS } from './fixtures/corpus.fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.resolve(__dirname, '../../src/lint/engine.mjs');

// ---------------------------------------------------------------------
// Shape contract
// ---------------------------------------------------------------------

test('lintItem: return shape matches PRD §5 — {lint:{passed,violations},dedupe:{hook_sim,nearest_item,method}}', () => {
  const result = lintItem({ caption: 'give them a whole world' }, {});
  assert.deepEqual(Object.keys(result).sort(), ['dedupe', 'lint']);
  assert.deepEqual(Object.keys(result.lint).sort(), ['passed', 'violations']);
  assert.equal(typeof result.lint.passed, 'boolean');
  assert.ok(Array.isArray(result.lint.violations));
  assert.deepEqual(Object.keys(result.dedupe).sort(), ['hook_sim', 'method', 'nearest_item']);
});

test('lintItem: violation entries carry exactly {rule, severity, excerpt}', () => {
  const result = lintItem({ caption: 'unleash the whole world' }, {});
  assert.ok(result.lint.violations.length > 0);
  for (const v of result.lint.violations) {
    assert.deepEqual(Object.keys(v).sort(), ['excerpt', 'rule', 'severity']);
    assert.ok(['block', 'warn'].includes(v.severity));
  }
});

test('lintItem: passed is false when ANY violation is block-severity, true when only warn/none', () => {
  const blocked = lintItem({ caption: 'unleash the whole world' }, {});
  assert.equal(blocked.lint.passed, false);

  const warnOnly = lintItem(
    { caption: 'the gift experience is ready for them' }, // noun-law warn only
    {},
  );
  assert.ok(warnOnly.lint.violations.every((v) => v.severity === 'warn'));
  assert.equal(warnOnly.lint.passed, true);

  const clean = lintItem({ caption: 'give them a whole world' }, {});
  assert.equal(clean.lint.passed, true);
});

test('lintItem: throws a TypeError for a non-object item', () => {
  assert.throws(() => lintItem(null, {}), TypeError);
  assert.throws(() => lintItem('not an item', {}), TypeError);
});

test('lintItem: all 9 gate-1 rule families are wired into RULES', () => {
  assert.equal(RULES.length, 9);
});

// ---------------------------------------------------------------------
// AC tricky cases (TICKETS.md AP-401)
// ---------------------------------------------------------------------

test('AC: literal-mechanic "unlock the vault" blocks even as a real in-world mechanic', () => {
  const item = {
    caption: 'spend six hard-won gems to unlock the vault holding your message',
  };
  const result = lintItem(item, {});
  assert.equal(result.lint.passed, false);
  assert.ok(result.lint.violations.some((v) => v.rule === 'banned-lexicon:term'));
});

test('AC: "$40 credit pack" in caption blocks', () => {
  const item = { caption: 'grab the $40 credit pack before it is gone' };
  const result = lintItem(item, {});
  assert.equal(result.lint.passed, false);
  assert.ok(result.lint.violations.some((v) => v.rule === 'price-law:disallowed-amount'));
});

test('AC: "$30" passes when both $15 and $45 are present in the same text', () => {
  const item = {
    caption: "here's what $30 actually buys you: $15 gets Sticker Book, $45 gets Drive-In Night.",
  };
  const result = lintItem(item, { catalog: FIXTURE_CATALOG });
  assert.equal(
    result.lint.violations.some((v) => v.rule.startsWith('price-law')),
    false,
  );
});

test('AC: "Pay once. It\'s theirs forever." passes; "your love stays forever guaranteed" blocks', () => {
  const passing = lintItem({ caption: "Pay once. It's theirs forever." }, {});
  assert.equal(passing.lint.passed, true);

  const blocked = lintItem({ caption: 'your love stays forever guaranteed' }, {});
  assert.equal(blocked.lint.passed, false);
  assert.ok(blocked.lint.violations.some((v) => v.rule === 'off-limits-claims:forever-guarantee'));
});

test('AC: sentence-case allows "The Blockheart Mine drops today."', () => {
  const item = { overlays: { hook: 'The Blockheart Mine drops today.', beats: [] } };
  const result = lintItem(item, { catalog: FIXTURE_CATALOG });
  assert.equal(
    result.lint.violations.some((v) => v.rule === 'style:title-case-run'),
    false,
  );
});

test('AC: an inactive world blocks with active alternates suggested', () => {
  const item = { caption: 'a Star Map Letter made just for you' };
  const result = lintItem(item, { catalog: FIXTURE_CATALOG });
  assert.equal(result.lint.passed, false);
  const hit = result.lint.violations.find((v) => v.rule === 'world-checks:inactive-world');
  assert.ok(hit);
  assert.match(hit.excerpt, /alternates/i);
});

test('AC: TikTok caption with 6 hashtags blocks', () => {
  const item = { platform: 'tiktok', caption: 'give them a whole world', hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] };
  const result = lintItem(item, {});
  assert.equal(result.lint.passed, false);
  assert.ok(result.lint.violations.some((v) => v.rule === 'style:hashtag-count'));
});

test('AC: an overlay chip intersecting a TikTok safe-area gutter blocks', () => {
  const item = {
    overlays: { hook: 'hi', chips: [{ text: 'CTA', x: 950, y: 1700, w: 100, h: 100 }] },
  };
  const result = lintItem(item, {});
  assert.equal(result.lint.passed, false);
  assert.ok(result.lint.violations.some((v) => v.rule === 'safe-area:gutter-intersection'));
});

// ---------------------------------------------------------------------
// Integration: dedupe merges into lint.violations (item is "gate 1 and 2")
// ---------------------------------------------------------------------

test('lintItem: a hook near-duplicate to the corpus fails the item even with otherwise-clean copy', () => {
  const item = {
    caption: 'give them a whole world',
    overlays: { hook: 'he ignores me for minecraft so i said it back', beats: [] },
  };
  const result = lintItem(item, { corpus: FIXTURE_CORPUS });
  assert.equal(result.lint.passed, false);
  assert.ok(result.lint.violations.some((v) => v.rule === 'dedupe:hook-similarity' && v.severity === 'block'));
  assert.ok(result.dedupe.hook_sim > 0.55);
});

// ---------------------------------------------------------------------
// Real catalog file: fenced-JSON parsing + world-active check end-to-end
// ---------------------------------------------------------------------

test('catalog.mjs: the real marketing/_research/template-catalog.md parses into a sane array', () => {
  const catalog = loadCatalog(DEFAULT_CATALOG_PATH);
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length > 10);
  for (const w of catalog) {
    assert.equal(typeof w.slug, 'string');
    assert.equal(typeof w.name, 'string');
    assert.ok(['standard', 'premium'].includes(w.tier));
    assert.equal(typeof w.isActive, 'boolean');
  }
});

test('world-checks against the REAL catalog: a currently-inactive world blocks by name', () => {
  const catalog = loadCatalog(DEFAULT_CATALOG_PATH);
  const inactive = catalog.find((w) => w.isActive === false);
  assert.ok(inactive, 'expected at least one inactive world in the live catalog');

  const item = { caption: `their very own ${inactive.name}, made just for them` };
  const result = lintItem(item, { catalog });
  const hit = result.lint.violations.find((v) => v.rule === 'world-checks:inactive-world');
  assert.ok(hit, `expected mentioning "${inactive.name}" to block`);
  assert.equal(result.lint.passed, false);
});

// ---------------------------------------------------------------------
// CLI smoke tests
// ---------------------------------------------------------------------

function writeTempItem(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap401-cli-'));
  const file = path.join(dir, 'item.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return { dir, file };
}

test('CLI: a clean item exits 0 and prints PASS', () => {
  const { dir, file } = writeTempItem({ caption: 'give them a whole world' });
  try {
    const out = execFileSync('node', [ENGINE_PATH, file], { encoding: 'utf8' });
    assert.match(out, /Status: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a violating item exits non-zero and prints FAIL with violation detail', () => {
  const { dir, file } = writeTempItem({ caption: 'unleash the whole world' });
  try {
    execFileSync('node', [ENGINE_PATH, file], { encoding: 'utf8' });
    assert.fail('expected the CLI to exit non-zero for a failing item');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(err.stdout, /Status: FAIL/);
    assert.match(err.stdout, /banned-lexicon:term/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: no item path argument exits with usage error (code 2)', () => {
  try {
    execFileSync('node', [ENGINE_PATH], { encoding: 'utf8' });
    assert.fail('expected the CLI to exit non-zero with no arguments');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /Usage:/);
  }
});
