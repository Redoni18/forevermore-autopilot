/**
 * @file Brain-driver seam (PRD §8.2). The generate stage depends only on the
 * {@link import('../types.mjs').BrainDriver} interface; the concrete driver is
 * injected by name.
 *
 * Resolution order:
 *   - `fixture` (default) → the built-in zero-dependency {@link FixtureBrain},
 *     so `autopilot run generate` works with no other tickets merged.
 *   - `mock` / `claude-cli` / `agent-sdk` → bridged to ticket AP-301's brain
 *     harness at `src/brain/driver.mjs` (`makeDriver(name, config)`), which
 *     returns the same `{name, complete}` contract. If AP-301 is not present,
 *     `mock` falls back to the fixture (still deterministic) and the real
 *     drivers error with guidance.
 *
 * NOTE (integration seam for Fable / AP-801): the brain config keys passed to
 * AP-301 (`promptsDir`, `brandGuidePath`, `cwd`) come from AP-301's documented
 * `makeDriver` config contract; owner overrides go under `config.brain`.
 */

import { join } from 'node:path';
import { FixtureBrain } from './fixture-brain.mjs';

/** Default brain config handed to AP-301's drivers, overridable via config.brain. */
function brainConfig(config, stage) {
  const r = (config && config.resolved) || {};
  const base = {
    promptsDir: r.pkgRoot ? join(r.pkgRoot, 'prompts') : undefined,
    // Brand guide moved in-repo with the §3.12 kit move (2026-07-13): prefer the
    // resolved kit path, falling back to <pkgRoot>/kit for older configs.
    brandGuidePath:
      r.brandGuide || (r.pkgRoot ? join(r.pkgRoot, 'kit', '00-brand', 'brand-guide.md') : undefined),
    cwd: r.repoRoot,
    ...((config && config.brain) || {}),
  };
  // WAVE2 §3.4 model policy: a per-stage pin beats any config.brain.model, and
  // fallbackModel rides along so the claude-cli driver can retry-once when the
  // pinned model is unavailable (e.g. Fable 5 leaving subscription inclusion).
  const pinned = stage && config && config.stageModels ? config.stageModels[stage] : undefined;
  if (pinned) base.model = pinned;
  if (config && config.fallbackModel) base.fallbackModel = config.fallbackModel;
  return base;
}

/**
 * @param {string} name  fixture | mock | claude-cli | agent-sdk
 * @param {ReturnType<import('../config.mjs').loadConfig>} [config]
 * @param {string} [stage] Stage whose stageModels pin applies (WAVE2 §3.4).
 * @returns {Promise<import('../types.mjs').BrainDriver>}
 */
export async function resolveBrainDriver(name, config, stage) {
  const which = name || (config && config.brainDriver) || 'fixture';
  if (which === 'fixture') return new FixtureBrain();

  // Bridge to AP-301's brain harness if it has landed.
  let brain = null;
  try {
    brain = await import('../brain/driver.mjs');
  } catch {
    /* AP-301 not merged in this tree */
  }
  if (brain && typeof brain.makeDriver === 'function') {
    return brain.makeDriver(which, brainConfig(config, stage));
  }

  // Fallbacks when AP-301 isn't present.
  if (which === 'mock') return new FixtureBrain(); // deterministic stand-in
  throw new Error(
    `brain driver "${which}" requires ticket AP-301 (src/brain/), which is not merged in this tree. ` +
      'Run with --driver fixture (or --driver mock) for now.',
  );
}
