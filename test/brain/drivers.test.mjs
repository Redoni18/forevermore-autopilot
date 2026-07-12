import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDriver } from '../../src/brain/driver.mjs';
import { getSchema, validate } from '../../src/brain/schema.mjs';

/* ── mock driver ────────────────────────────────────────────────────────── */

test('mock copywriter fans out to 3 distinct, schema-valid candidates', async () => {
  const mock = makeDriver('mock');
  const hooks = new Set();
  for (let variant = 0; variant < 3; variant++) {
    const r = await mock.complete({ stage: 'copywriter', schema: 'copywriter', inputs: { variant } });
    assert.equal(r.ok, true, r.error ?? '');
    assert.equal(r.driver, 'mock');
    assert.equal(r.costUsd, 0);
    assert.equal(r.tokensIn, null);
    assert.ok(validate(getSchema('copywriter'), r.data).ok);
    hooks.add(r.data.overlays.hook);
  }
  assert.equal(hooks.size, 3, 'each variant must yield a distinct hook');
});

test('mock variant index wraps around the candidate array', async () => {
  const mock = makeDriver('mock');
  const a = await mock.complete({ stage: 'copywriter', schema: 'copywriter', inputs: { variant: 0 } });
  const wrapped = await mock.complete({ stage: 'copywriter', schema: 'copywriter', inputs: { variant: 3 } });
  assert.equal(a.data.overlays.hook, wrapped.data.overlays.hook);
});

test('mock returns valid output for every stage schema', async () => {
  const mock = makeDriver('mock');
  const cases = [
    ['planner', 'planner'],
    ['artdirector', 'artdirector'],
    ['artdirector', 'artdirector.judge'],
    ['regen', 'regen'],
    ['reflect', 'reflect'],
    ['suggestions', 'suggestions'],
  ];
  for (const [stage, schema] of cases) {
    const r = await mock.complete({ stage, schema, inputs: {} });
    assert.equal(r.ok, true, `${schema}: ${r.error ?? ''}`);
    assert.ok(validate(getSchema(schema), r.data).ok);
    assert.equal(r.promptSha.length, 64, 'mock still logs a real prompt sha');
  }
});

test('mock surfaces a missing fixture as ok:false, not a throw', async () => {
  const mock = makeDriver('mock', { fixturesDir: '/tmp/does-not-exist-brain-fixtures/' });
  const r = await mock.complete({ stage: 'planner', schema: 'planner', inputs: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /fixture/);
});

/* ── agent-sdk stub ─────────────────────────────────────────────────────── */

test('agent-sdk driver is a loud, compiling stub', async () => {
  const sdk = makeDriver('agent-sdk');
  assert.equal(sdk.name, 'agent-sdk');
  await assert.rejects(
    () => sdk.complete({ stage: 'copywriter', schema: 'copywriter', inputs: {} }),
    /not implemented yet/,
  );
});

/* ── factory ────────────────────────────────────────────────────────────── */

test('makeDriver builds each known driver and rejects unknown names', () => {
  assert.equal(makeDriver('claude-cli').name, 'claude-cli');
  assert.equal(makeDriver('mock').name, 'mock');
  assert.equal(makeDriver('agent-sdk').name, 'agent-sdk');
  assert.equal(makeDriver().name, 'claude-cli'); // default
  assert.throws(() => makeDriver('gpt'), /unknown brain driver/);
});
