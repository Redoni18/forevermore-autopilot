/**
 * @file claude-cli driver (PRD §8.2, M0 default).
 *
 * Spawns the installed `claude` CLI as a pure completion:
 *
 *   claude -p <prompt> --output-format json [--model <m>] --allowedTools ""
 *
 * `--allowedTools ""` yields an empty tool allowlist, so in non-interactive
 * (`-p`) mode the model can't touch the filesystem or run tools — it just
 * completes. All context the stage needs is injected into the prompt by
 * `assemble.mjs` (the model never reads files itself).
 *
 * The CLI wraps the model's answer in a JSON envelope:
 *   { type:"result", subtype:"success", is_error:false, result:"<model text>",
 *     total_cost_usd, usage:{input_tokens,output_tokens}, modelUsage:{…} }
 * We pull `result`, extract the model's JSON from it, and validate against the
 * stage schema. On invalid output we retry (default ×2) with an appended
 * corrective instruction. CLI-level failures (non-zero exit, unparseable
 * envelope, error envelope) fail fast — they are not model-fixable.
 */

import { spawn } from 'node:child_process';

import { assemblePrompt } from '../assemble.mjs';
import { extractJson, getSchema, validate } from '../schema.mjs';

const DRIVER = 'claude-cli';
/** Stable marker so retries are detectable in the prompt (and by test shims). */
const CORRECTIVE_MARKER = 'CORRECTIVE-RETRY';

export class ClaudeCliDriver {
  /**
   * @param {object} [config]
   * @param {string} [config.bin='claude']  Path/name of the CLI binary.
   * @param {string} [config.model]         Passed through as `--model`.
   * @param {number} [config.maxRetries=2]  Extra attempts after an invalid output.
   * @param {number} [config.timeoutMs=180000]
   * @param {string} [config.cwd]
   * @param {Record<string,string>} [config.env]  Merged over process.env.
   * @param {string} [config.promptsDir] @param {string} [config.brandGuidePath]
   */
  constructor(config = {}) {
    this.name = DRIVER;
    this.config = config;
    this.bin = config.bin ?? 'claude';
    this.maxRetries = config.maxRetries ?? 2;
    this.timeoutMs = config.timeoutMs ?? 180000;
  }

  /**
   * @param {import('../schema.mjs').StageRequest} req
   * @returns {Promise<import('../schema.mjs').StageResult>}
   */
  async complete(req) {
    const schema = getSchema(req.schema);
    const { prompt, promptSha } = assemblePrompt(req, this.config);

    const maxAttempts = 1 + this.maxRetries;
    let lastError = 'no attempts made';
    let lastRaw = '';
    let lastEnvelope = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const fullPrompt =
        attempt === 1 ? prompt : `${prompt}\n\n${correctiveSuffix(attempt, lastError)}`;

      const spawnResult = await this._spawn(fullPrompt);

      // 1) Process/spawn failure → not model-fixable.
      if (spawnResult.error) {
        return this._fail({
          promptSha,
          attempts: attempt,
          error: `claude CLI error: ${spawnResult.error}${
            spawnResult.stderr ? ` :: ${truncate(spawnResult.stderr, 500)}` : ''
          }`,
          envelope: null,
        });
      }

      const envelope = spawnResult.envelope;
      lastEnvelope = envelope;

      // 2) The CLI returned an error envelope (API error, refusal, etc.).
      if (envelope.is_error === true || (envelope.subtype && envelope.subtype !== 'success')) {
        return this._fail({
          promptSha,
          attempts: attempt,
          error: `claude returned an error envelope (subtype=${envelope.subtype ?? '?'}): ${truncate(
            String(envelope.result ?? envelope.error ?? ''),
            500,
          )}`,
          envelope,
        });
      }

      const resultText = typeof envelope.result === 'string' ? envelope.result : '';
      lastRaw = resultText;

      // 3) Extract + validate the MODEL's JSON. Failures here are retryable.
      const parsed = extractJson(resultText);
      if (!parsed.ok) {
        lastError = `output was not valid JSON (${parsed.error})`;
        continue;
      }
      const check = validate(schema, parsed.value);
      if (!check.ok) {
        lastError = `output failed schema '${req.schema}': ${check.errors.join('; ')}`;
        continue;
      }

      // Success.
      return {
        ok: true,
        data: parsed.value,
        raw: resultText,
        tokensIn: envelope.usage?.input_tokens ?? null,
        tokensOut: envelope.usage?.output_tokens ?? null,
        model: pickModel(envelope, this.config.model),
        promptSha,
        costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
        error: null,
        attempts: attempt,
        driver: DRIVER,
      };
    }

    return this._fail({
      promptSha,
      attempts: maxAttempts,
      error: `invalid output after ${maxAttempts} attempts: ${lastError}`,
      envelope: lastEnvelope,
      raw: lastRaw,
    });
  }

  /**
   * Spawn the CLI once and parse its stdout envelope.
   * @returns {Promise<{ envelope?: any, stdout?: string, stderr?: string, error?: string }>}
   */
  _spawn(prompt) {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(this.config.model ? ['--model', this.config.model] : []),
      // Empty allowlist LAST: the variadic `<tools...>` stops at end-of-args and
      // can't accidentally swallow the positional prompt (which precedes it).
      '--allowedTools',
      '',
    ];

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.bin, args, {
          cwd: this.config.cwd ?? process.cwd(),
          env: { ...process.env, ...(this.config.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ error: `failed to spawn '${this.bin}': ${err.message}` });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ error: `timed out after ${this.timeoutMs}ms`, stderr });
      }, this.timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => done({ error: err.message, stderr }));
      child.on('close', (code) => {
        if (code !== 0) {
          done({ error: `exited with code ${code}`, stdout, stderr });
          return;
        }
        // The envelope should be the whole stdout, but tolerate stray banners.
        const parsed = extractJson(stdout);
        if (!parsed.ok || parsed.value == null || typeof parsed.value !== 'object') {
          done({ error: `could not parse CLI envelope: ${parsed.ok ? 'not an object' : parsed.error}`, stdout, stderr });
          return;
        }
        done({ envelope: parsed.value, stdout, stderr });
      });
    });
  }

  _fail({ promptSha, attempts, error, envelope, raw }) {
    return {
      ok: false,
      data: null,
      raw: raw ?? (typeof envelope?.result === 'string' ? envelope.result : ''),
      tokensIn: envelope?.usage?.input_tokens ?? null,
      tokensOut: envelope?.usage?.output_tokens ?? null,
      model: pickModel(envelope, this.config.model),
      promptSha,
      costUsd: typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
      error,
      attempts,
      driver: DRIVER,
    };
  }
}

/**
 * The model that actually answered. Prefer the primary key in `modelUsage`
 * (highest output tokens), then the configured model, then null. Reporting
 * reality beats echoing config.
 */
function pickModel(envelope, configModel) {
  const usage = envelope?.modelUsage;
  if (usage && typeof usage === 'object') {
    let best = null;
    let bestOut = -1;
    for (const [model, u] of Object.entries(usage)) {
      const out = Number(u?.outputTokens ?? 0);
      if (out > bestOut) {
        bestOut = out;
        best = model;
      }
    }
    if (best) return best;
  }
  return configModel ?? null;
}

function correctiveSuffix(attempt, lastError) {
  return [
    `${RULE} ${CORRECTIVE_MARKER} (attempt ${attempt}) ${RULE}`,
    `Your previous reply could not be used: ${lastError}.`,
    'Reply again with ONLY the corrected JSON object — no prose, no markdown fences, no commentary.',
    'Every required key must be present with the correct type and allowed enum values.',
  ].join('\n');
}

const RULE = '━'.repeat(4);

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}
