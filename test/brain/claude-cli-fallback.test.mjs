// Model-policy fallback (WAVE2 §3.4): when the pinned model is unavailable,
// the claude-cli driver retries ONCE on fallbackModel and completes the run;
// transient/API errors must NOT trigger the swap. isModelUnavailable is the
// classifier both the driver and (later) the Telegram scanner lean on — its
// accepted shapes are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCliDriver, isModelUnavailable } from '../../src/brain/drivers/claude-cli.mjs';

const REQ = { stage: 'copywriter', schema: 'copywriter', inputs: { item: { id: 'x' } } };

/** Driver whose _spawn is scripted: each call shifts the next result. */
function scriptedDriver(config, script) {
  const driver = new ClaudeCliDriver({
    ...config,
    promptsDir: new URL('../../prompts/', import.meta.url).pathname,
    brandGuidePath: new URL('../../kit/00-brand/brand-guide.md', import.meta.url).pathname,
  });
  const calls = [];
  driver._spawn = (prompt, model) => {
    calls.push({ model, corrective: prompt.includes('CORRECTIVE-RETRY') });
    const next = script.shift();
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };
  return { driver, calls };
}

// Matches COPYWRITER_SCHEMA (src/brain/schema.mjs) so a success envelope
// validates on the first try — otherwise corrective retries burn the script.
const GOOD_COPY = {
  caption: 'a real caption for the test',
  hashtags: ['#a'],
  overlays: { hook: 'a hook', beats: ['one', 'two', 'three'], cta: 'getforevermore.co' },
  link_utm: 'getforevermore.co?utm_source=instagram',
  selfcheck: { claims_ok: true, nouns_ok: true, no_banned_words: true },
  rationale: {
    summary: 'why this should work in two sentences.',
    hook_reasoning: 'why this hook stops this audience.',
    strategy: { idea_id: 'F03', idea_title: 't', pillar: 'p', playbook_rules: [] },
    craft: ['POV framing'],
    limits: ['kinetic text only'],
    audience: 'gamer partners',
  },
};
const okEnvelope = (model) => ({
  envelope: {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(GOOD_COPY),
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: { [model]: { outputTokens: 20 } },
  },
});

/* ── the classifier ─────────────────────────────────────────────────────── */

test('isModelUnavailable accepts the observed unavailable shapes', () => {
  for (const s of [
    'API error: model claude-fable-5 not found',
    'The model `claude-fable-5` is not available on your plan',
    'model claude-fable-5 is invalid',
    'Your account does not have access to the model claude-fable-5',
    'you are not entitled to model claude-fable-5',
    '{"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-5"}}',
    'model "claude-fable-5" does not exist',
  ]) {
    assert.equal(isModelUnavailable(s), true, `should match: ${s}`);
  }
});

test('isModelUnavailable rejects transient/API errors (no false fallback)', () => {
  for (const s of [
    'rate_limit_error: too many requests',
    'overloaded_error',
    'network error: ECONNRESET',
    'exited with code 1',
    'timed out after 180000ms',
    'invalid_request_error: prompt is too long',
  ]) {
    assert.equal(isModelUnavailable(s), false, `should NOT match: ${s}`);
  }
});

/* ── the fallback retry ─────────────────────────────────────────────────── */

test('unavailable pinned model → one retry on fallbackModel, run completes', async () => {
  const { driver, calls } = scriptedDriver(
    { model: 'claude-fable-5', fallbackModel: 'claude-opus-4-8' },
    [
      { error: 'exited with code 1', stderr: 'model claude-fable-5 not found' },
      okEnvelope('claude-opus-4-8'),
    ],
  );
  const res = await driver.complete(REQ);
  assert.equal(res.ok, true);
  assert.equal(res.model, 'claude-opus-4-8', 'result reports the model that actually answered');
  assert.deepEqual(
    calls.map((c) => c.model),
    ['claude-fable-5', 'claude-opus-4-8'],
  );
  assert.equal(calls[1].corrective, false, 'the model swap is not a corrective retry');
});

test('unavailable via error ENVELOPE also falls back', async () => {
  const { driver, calls } = scriptedDriver(
    { model: 'claude-fable-5', fallbackModel: 'claude-opus-4-8' },
    [
      {
        envelope: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'The model `claude-fable-5` is not available',
        },
      },
      okEnvelope('claude-opus-4-8'),
    ],
  );
  const res = await driver.complete(REQ);
  assert.equal(res.ok, true);
  assert.deepEqual(
    calls.map((c) => c.model),
    ['claude-fable-5', 'claude-opus-4-8'],
  );
});

test('fallback also unavailable → fail (never a second swap)', async () => {
  const { driver, calls } = scriptedDriver(
    { model: 'claude-fable-5', fallbackModel: 'claude-opus-4-8' },
    [
      { error: 'exited with code 1', stderr: 'model claude-fable-5 not found' },
      { error: 'exited with code 1', stderr: 'model claude-opus-4-8 not found' },
    ],
  );
  const res = await driver.complete(REQ);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 2, 'exactly one swap, then fail');
});

test('non-model errors do NOT trigger the fallback', async () => {
  const { driver, calls } = scriptedDriver(
    { model: 'claude-fable-5', fallbackModel: 'claude-opus-4-8' },
    [{ error: 'timed out after 180000ms' }],
  );
  const res = await driver.complete(REQ);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1);
  assert.match(res.error, /timed out/);
});

test('no fallbackModel configured → no swap, plain failure', async () => {
  const { driver, calls } = scriptedDriver({ model: 'claude-fable-5' }, [
    { error: 'exited with code 1', stderr: 'model claude-fable-5 not found' },
  ]);
  const res = await driver.complete(REQ);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1);
});

test('corrective retries still work on the fallback model after a swap', async () => {
  const { driver, calls } = scriptedDriver(
    { model: 'claude-fable-5', fallbackModel: 'claude-opus-4-8', maxRetries: 2 },
    [
      { error: 'spawn error', stderr: 'model claude-fable-5 is invalid' },
      {
        envelope: { type: 'result', subtype: 'success', is_error: false, result: 'not json at all' },
      },
      okEnvelope('claude-opus-4-8'),
    ],
  );
  const res = await driver.complete(REQ);
  assert.equal(res.ok, true);
  assert.deepEqual(
    calls.map((c) => c.model),
    ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-8'],
  );
  assert.equal(calls[2].corrective, true, 'schema retry marker present after the swap');
});
