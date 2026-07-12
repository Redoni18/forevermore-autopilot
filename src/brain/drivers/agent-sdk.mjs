/**
 * @file agent-sdk driver — COMPILING STUB (PRD §8.2, M1).
 *
 * The M1 driver will run stages through `@anthropic-ai/claude-agent-sdk`
 * `query()` — the same package `apps/builder` already uses
 * (`server/utils/runner-claude.ts`). It's needed for CI (where there is no
 * interactive subscription session) and for per-call model routing.
 *
 * This stub is intentionally inert: it does NOT import the SDK (that package is
 * only installed under `apps/builder`, not `autopilot/`) and makes NO network
 * calls. It shares the exact `StageRequest → StageResult` contract, so swapping
 * it in later is a driver-name change, nothing else.
 *
 * ── TODO(AP-301 / M1): implement ─────────────────────────────────────────────
 *   import { query } from '@anthropic-ai/claude-agent-sdk'
 *   // add the dep to autopilot/package.json; requires CLAUDE_CODE_OAUTH_TOKEN
 *   // (from `claude setup-token`) or ANTHROPIC_API_KEY in the environment.
 *
 *   async complete(req) {
 *     const schema = getSchema(req.schema)
 *     const { prompt, promptSha } = assemblePrompt(req, this.config)
 *     // Reuse the retry loop shape from claude-cli.mjs: on schema-invalid
 *     // output, re-query with an appended corrective instruction (×2).
 *     const conversation = query({
 *       prompt,
 *       options: {
 *         model: this.config.model,                 // per-call routing (PRD §8.1)
 *         systemPrompt: { preset: 'claude_code' },   // matches builder's runner
 *         allowedTools: [],                          // pure completion, no tools
 *         maxTurns: 1,
 *         abortController: this.config.abortController,
 *       },
 *     })
 *     // Drain the async iterable; on the `result` message read
 *     //   message.result           → model text  → extractJson() → validate()
 *     //   message.usage.input_tokens / output_tokens
 *     //   message.total_cost_usd
 *     // Return a StageResult identical in shape to the claude-cli driver.
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

// These imports document the intended reuse and keep the stub honest — the same
// schema + assembly path the real implementation will use. They add no runtime
// dependency beyond the dependency-free brain modules.
import { assemblePrompt } from '../assemble.mjs';
import { getSchema } from '../schema.mjs';

const DRIVER = 'agent-sdk';

export class AgentSdkDriver {
  constructor(config = {}) {
    this.name = DRIVER;
    this.config = config;
  }

  /**
   * @param {import('../schema.mjs').StageRequest} req
   * @returns {Promise<import('../schema.mjs').StageResult>}
   */
  async complete(req) {
    // Validate the request shape so a misconfigured call fails clearly even
    // against the stub (schema key must exist; assembly must be possible).
    getSchema(req.schema);
    const { promptSha } = assemblePrompt(req, this.config);
    void promptSha;
    throw new Error(
      "agent-sdk driver is not implemented yet (M1). Use driver 'claude-cli' (subscription auth) " +
        "or 'mock' (fixtures). See the TODO in autopilot/src/brain/drivers/agent-sdk.mjs.",
    );
  }
}
