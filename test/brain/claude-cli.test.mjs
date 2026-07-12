import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { makeDriver } from '../../src/brain/driver.mjs';
import { assemblePrompt } from '../../src/brain/assemble.mjs';

/** The fake `claude` CLI shim (behaviour switched by FAKE_CLAUDE_MODE). */
const SHIM = fileURLToPath(new URL('../../fixtures/brain/fake-claude.sh', import.meta.url));

function req() {
  return {
    stage: 'copywriter',
    schema: 'copywriter',
    inputs: {
      formatSpec: { platform: 'tiktok', format: 'tiktok_video' },
      idea: { id: 'F03', title: 'gamer-partner wedge', worlds: ['The Blockheart Mine'] },
      worldFacts: [
        { name: 'The Blockheart Mine', slug: 'blockheart-mine', tier: 'premium', isActive: true, description: 'voxel world' },
      ],
    },
  };
}

const driver = (mode) => makeDriver('claude-cli', { bin: SHIM, env: { FAKE_CLAUDE_MODE: mode } });

test('happy path: valid envelope → schema-valid result with tokens, cost, model, sha', async () => {
  const r = await driver('happy').complete(req());
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.attempts, 1);
  assert.equal(r.driver, 'claude-cli');
  // Envelope fields the driver must surface (PRD §5 runs row).
  assert.equal(r.tokensIn, 1234);
  assert.equal(r.tokensOut, 210);
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.model, 'claude-sonnet-4-5-fake');
  // The model's JSON was extracted from a fenced block wrapped in prose.
  assert.equal(typeof r.data.caption, 'string');
  assert.ok(r.data.caption.length > 0);
  assert.ok(Array.isArray(r.data.hashtags));
  assert.equal(typeof r.data.overlays.hook, 'string');
  // promptSha is the sha of the assembled BASE prompt (traceable, retry-stable).
  assert.equal(r.promptSha, assemblePrompt(req()).promptSha);
});

test('invalid-JSON-then-retry: one corrective retry, then success (attempts=2)', async () => {
  const r = await driver('invalid_then_valid').complete(req());
  assert.equal(r.ok, true, `expected success after retry, got: ${r.error}`);
  assert.equal(r.attempts, 2);
  assert.ok(r.data.overlays.hook.length > 0);
});

test('retry exhaustion: always-invalid → ok:false after 3 attempts', async () => {
  const r = await driver('always_invalid').complete(req());
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(r.data, null);
  assert.match(r.error, /after 3 attempts/);
  assert.match(r.error, /not valid JSON/);
});

test('CLI error path: non-zero exit → ok:false, error names the CLI failure + stderr', async () => {
  const r = await driver('error').complete(req());
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.match(r.error, /claude CLI error/);
  assert.match(r.error, /code 2/);
  assert.match(r.error, /simulated CLI failure/); // captured stderr
});

test('spawn failure: a missing binary is reported, not thrown', async () => {
  const d = makeDriver('claude-cli', { bin: '/no/such/claude-binary-xyz', env: {} });
  const r = await d.complete(req());
  assert.equal(r.ok, false);
  assert.match(r.error, /claude CLI error/);
});

test('the corrective retry actually changes the prompt (marker present on retry)', async () => {
  // Indirect proof: invalid_then_valid only succeeds because attempt 2 carries
  // the CORRECTIVE-RETRY marker the shim keys on. If the driver did not append
  // it, the shim would return invalid forever and attempts would hit 3.
  const r = await driver('invalid_then_valid').complete(req());
  assert.equal(r.attempts, 2);
});
