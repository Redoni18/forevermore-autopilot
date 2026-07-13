import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getSchema, validate, extractJson, SCHEMAS } from '../../src/brain/schema.mjs';

const MOCK_DIR = new URL('../../fixtures/brain/mock/', import.meta.url);
const load = (file) => JSON.parse(readFileSync(new URL(file, MOCK_DIR), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ── golden fixtures validate ───────────────────────────────────────────── */

const GOLDEN = [
  { file: 'planner.json', key: 'planner' },
  { file: 'copywriter.json', key: 'copywriter', array: true },
  { file: 'artdirector.json', key: 'artdirector' },
  { file: 'artdirector-judge.json', key: 'artdirector.judge' },
  { file: 'regen.json', key: 'regen' },
  { file: 'reflect.json', key: 'reflect' },
  { file: 'suggestions.json', key: 'suggestions' },
];

test('every schema key has a schema and a golden fixture that validates', () => {
  // Every declared schema is exercised by a golden fixture.
  const covered = new Set(GOLDEN.map((g) => g.key));
  for (const key of Object.keys(SCHEMAS)) {
    assert.ok(covered.has(key), `schema '${key}' has no golden fixture`);
  }

  for (const { file, key, array } of GOLDEN) {
    const schema = getSchema(key);
    const data = load(file);
    const items = array ? data : [data];
    items.forEach((item, i) => {
      const res = validate(schema, item);
      assert.ok(res.ok, `${file}[${i}] should validate against '${key}': ${res.errors.join('; ')}`);
      assert.deepEqual(res.errors, []);
    });
  }
});

test('copywriter fixture is an array of 3 candidates', () => {
  const c = load('copywriter.json');
  assert.ok(Array.isArray(c));
  assert.equal(c.length, 3);
});

/* ── six seeded invalids get rejected ───────────────────────────────────── */

test('validator rejects six seeded invalids, each for the right reason', () => {
  const cw = load('copywriter.json')[0];
  const planner = load('planner.json');

  const cases = [
    {
      name: 'missing required key — copywriter.caption removed',
      key: 'copywriter',
      build: () => {
        const x = clone(cw);
        delete x.caption;
        return x;
      },
      expect: /\$\.caption: missing required key/,
    },
    {
      name: 'wrong enum — planner slot.platform = "twitter"',
      key: 'planner',
      build: () => {
        const x = clone(planner);
        x.slots[0].platform = 'twitter';
        return x;
      },
      expect: /platform: .*not one of/,
    },
    {
      name: 'wrong type — copywriter.hashtags is a string',
      key: 'copywriter',
      build: () => {
        const x = clone(cw);
        x.hashtags = 'giftideas';
        return x;
      },
      expect: /hashtags: expected array/,
    },
    {
      name: 'banned structure — copywriter.overlays is an array, not an object',
      key: 'copywriter',
      build: () => {
        const x = clone(cw);
        x.overlays = ['hook', 'beats'];
        return x;
      },
      expect: /overlays: expected object/,
    },
    {
      name: 'array bound — planner slot.idea_ids has 2 items, not 3',
      key: 'planner',
      build: () => {
        const x = clone(planner);
        x.slots[0].idea_ids = ['A17', 'F03'];
        return x;
      },
      expect: /idea_ids: expected >= 3 items/,
    },
    {
      name: 'nested type — copywriter.selfcheck.claims_ok is a string',
      key: 'copywriter',
      build: () => {
        const x = clone(cw);
        x.selfcheck.claims_ok = 'yes';
        return x;
      },
      expect: /selfcheck\.claims_ok: expected boolean/,
    },
  ];

  assert.equal(cases.length, 6);
  for (const c of cases) {
    const res = validate(getSchema(c.key), c.build());
    assert.equal(res.ok, false, `${c.name} should be rejected`);
    assert.ok(
      res.errors.some((e) => c.expect.test(e)),
      `${c.name}: expected an error matching ${c.expect} but got [${res.errors.join(' | ')}]`,
    );
  }
});

/* ── rationale thinking log (AP-831) ────────────────────────────────────── */

test('copywriter + regen now REQUIRE a rationale thinking log', () => {
  const cw = load('copywriter.json')[0];
  const regen = load('regen.json');
  // The golden fixtures carry a valid rationale.
  assert.ok(validate(getSchema('copywriter'), cw).ok);
  assert.ok(validate(getSchema('regen'), regen).ok);
  // Drop it → both schemas reject with a clear message.
  const cwNo = clone(cw);
  delete cwNo.rationale;
  assert.match(validate(getSchema('copywriter'), cwNo).errors.join(' | '), /\$\.rationale: missing required key/);
  const regenNo = clone(regen);
  delete regenNo.rationale;
  assert.match(validate(getSchema('regen'), regenNo).errors.join(' | '), /\$\.rationale: missing required key/);
});

test('rationale: five seeded invalids each rejected for the right reason', () => {
  const cw = load('copywriter.json')[0];
  const cases = [
    {
      name: 'strategy object missing',
      build: () => { const x = clone(cw); delete x.rationale.strategy; return x; },
      expect: /rationale\.strategy: missing required key/,
    },
    {
      name: 'craft is a string, not an array',
      build: () => { const x = clone(cw); x.rationale.craft = 'POV framing'; return x; },
      expect: /rationale\.craft: expected array/,
    },
    {
      name: 'limits is a string, not an array',
      build: () => { const x = clone(cw); x.rationale.limits = 'no footage'; return x; },
      expect: /rationale\.limits: expected array/,
    },
    {
      name: 'strategy.playbook_rules is a string, not an array',
      build: () => { const x = clone(cw); x.rationale.strategy.playbook_rules = 'tofu-orientation-beat'; return x; },
      expect: /rationale\.strategy\.playbook_rules: expected array/,
    },
    {
      name: 'audience is a number, not a string',
      build: () => { const x = clone(cw); x.rationale.audience = 42; return x; },
      expect: /rationale\.audience: expected string/,
    },
  ];
  assert.equal(cases.length, 5);
  for (const c of cases) {
    const res = validate(getSchema('copywriter'), c.build());
    assert.equal(res.ok, false, `${c.name} should be rejected`);
    assert.ok(res.errors.some((e) => c.expect.test(e)), `${c.name}: got [${res.errors.join(' | ')}]`);
  }
});

test('rationale.strategy.playbook_rules accepts bare ids OR joined {id,rule} objects', () => {
  const cw = load('copywriter.json')[0];
  // as cited by the model (ids)
  const ids = clone(cw);
  ids.rationale.strategy.playbook_rules = ['aee31fc7', 'bf819540'];
  assert.ok(validate(getSchema('copywriter'), ids).ok, 'bare id strings validate');
  // as persisted after the pipeline join — re-validating a stored log still passes
  const joined = clone(cw);
  joined.rationale.strategy.playbook_rules = [{ id: 'aee31fc7', rule: 'orientation beat rule text' }];
  assert.ok(validate(getSchema('copywriter'), joined).ok, 'joined {id,rule} objects validate');
});

test('validator accepts optional keys absent and extra keys present', () => {
  // artdirector.video is optional — omitting it is fine.
  const ad = load('artdirector.json');
  delete ad.video;
  assert.ok(validate(getSchema('artdirector'), ad).ok);

  // Extra keys are tolerated (models sprinkle stray fields).
  const cw = load('copywriter.json')[0];
  cw.model_note = 'ignore me';
  assert.ok(validate(getSchema('copywriter'), cw).ok);
});

test('nullable union type — suggestions.applies_from accepts string or null', () => {
  const s = load('suggestions.json');
  assert.ok(validate(getSchema('suggestions'), s).ok); // has both a date and a null
  s.directives[0].applies_from = 12345; // number is neither
  assert.equal(validate(getSchema('suggestions'), s).ok, false);
});

/* ── extractJson ────────────────────────────────────────────────────────── */

test('extractJson handles clean, fenced, and prose-wrapped output', () => {
  assert.deepEqual(extractJson('{"a":1}'), { ok: true, value: { a: 1 } });

  const fenced = 'here you go:\n```json\n{"a":2}\n```\nthanks';
  assert.deepEqual(extractJson(fenced), { ok: true, value: { a: 2 } });

  const bareFence = '```\n{"a":3}\n```';
  assert.deepEqual(extractJson(bareFence), { ok: true, value: { a: 3 } });

  const trailing = '{"a":4} and that is the answer';
  assert.deepEqual(extractJson(trailing), { ok: true, value: { a: 4 } });
});

test('extractJson fails cleanly on broken and non-string input', () => {
  assert.equal(extractJson('{ "a": }').ok, false);
  assert.equal(extractJson('no json here at all').ok, false);
  assert.equal(extractJson('').ok, false);
  assert.equal(extractJson(null).ok, false);
});

test('the seeded invalid-envelope result text is genuinely unparseable', () => {
  // This is the exact text the fake-claude shim returns on its "invalid" path;
  // the retry test depends on it failing extraction.
  const raw = readFileSync(
    new URL('../../fixtures/brain/envelopes/copywriter-result-invalid.txt', import.meta.url),
    'utf8',
  );
  assert.equal(extractJson(raw).ok, false);
});

test('getSchema throws on an unknown key', () => {
  assert.throws(() => getSchema('nope'), /unknown schema/);
});
