/**
 * @file BrainDriver interface + factory (PRD §8.2, decision D-2).
 *
 * A driver turns a {@link import('./schema.mjs').StageRequest} into a
 * schema-validated {@link import('./schema.mjs').StageResult}. Three drivers
 * share the contract:
 *
 *   - `claude-cli`  (M0 default) — spawns the local `claude` CLI on the owner's
 *                    subscription auth. Zero new keys. See drivers/claude-cli.mjs.
 *   - `mock`        — deterministic fixtures for AP-201 pipeline tests + CI.
 *   - `agent-sdk`   (M1 stub) — @anthropic-ai/claude-agent-sdk; not implemented.
 *
 * @typedef {Object} BrainDriver
 * @property {string} name
 * @property {(req: import('./schema.mjs').StageRequest) => Promise<import('./schema.mjs').StageResult>} complete
 */

import { ClaudeCliDriver } from './drivers/claude-cli.mjs';
import { MockDriver } from './drivers/mock.mjs';
import { AgentSdkDriver } from './drivers/agent-sdk.mjs';

export { ClaudeCliDriver, MockDriver, AgentSdkDriver };

/** @typedef {'claude-cli'|'mock'|'agent-sdk'} DriverName */

/**
 * Build a driver by name.
 *
 * @param {DriverName} [name='claude-cli']
 * @param {object} [config] Driver-specific config. Common keys:
 *   `promptsDir`, `brandGuidePath` (assembly); `model`, `bin`, `maxRetries`,
 *   `timeoutMs`, `cwd`, `env` (claude-cli); `fixturesDir` (mock).
 * @returns {BrainDriver}
 */
export function makeDriver(name = 'claude-cli', config = {}) {
  switch (name) {
    case 'claude-cli':
      return new ClaudeCliDriver(config);
    case 'mock':
      return new MockDriver(config);
    case 'agent-sdk':
      return new AgentSdkDriver(config);
    default:
      throw new Error(`unknown brain driver '${name}' (known: claude-cli, mock, agent-sdk)`);
  }
}
