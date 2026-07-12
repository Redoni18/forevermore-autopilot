/**
 * @file Lint seam. The real deterministic lint engine is ticket AP-401
 * (`src/lint/`, not created here). The qa stage depends only on a
 * {@link import('../types.mjs').LintFn}; config.lintModule points at the real
 * engine when it lands. Default = a no-op that passes everything, so the
 * pipeline flows M0 without QA blocking.
 */

import { pathToFileURL } from 'node:url';

/**
 * No-op lint: everything passes. @type {import('../types.mjs').LintFn}
 */
export function noopLint(/* item */) {
  return { passed: true, violations: [] };
}

/**
 * Resolve the lint function: config.resolved.lintModule (default export =
 * LintFn) if configured, else the built-in no-op.
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @returns {Promise<import('../types.mjs').LintFn>}
 */
export async function resolveLint(config) {
  const modPath = config?.resolved?.lintModule;
  if (!modPath) return noopLint;
  const mod = await import(pathToFileURL(modPath).href);
  const fn = mod.default || mod.lint || mod.lintItem;
  if (typeof fn !== 'function') {
    throw new Error(`lint module ${modPath} must default-export a LintFn (item) => LintResult`);
  }
  return fn;
}
