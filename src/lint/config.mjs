// autopilot/src/lint/config.mjs
//
// Config loader for the lint engine CLI. Precedence (highest wins):
// CLI flags > autopilot/autopilot.config.json (if present) > built-in
// defaults. The ticket text lists the three sources without dictating an
// order ("if present ... else sensible defaults, else flags"); this
// implements the standard, least-surprising CLI convention — explicit
// flags override the config file, which overrides defaults — and is noted
// as a resolved ambiguity in the ticket write-up.
//
// lintItem() itself never touches the filesystem (pure function); this
// module + catalog.mjs/corpus.mjs are only used by the CLI entrypoint in
// engine.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTOPILOT_ROOT = path.resolve(__dirname, '../..');
// The Forevermore platform checkout (standalone layout: sibling of this
// repo; env FOREVERMORE_ROOT overrides). Autopilot only READS from it
// (template catalog for world-checks).
export const REPO_ROOT =
  process.env.FOREVERMORE_ROOT ||
  path.join(path.dirname(AUTOPILOT_ROOT), 'forevermore');

export const DEFAULT_CONFIG_PATH = path.join(AUTOPILOT_ROOT, 'autopilot.config.json');
export const DEFAULT_CATALOG_PATH = path.join(
  REPO_ROOT,
  'marketing/_research/template-catalog.md',
);

export const DEFAULTS = Object.freeze({
  catalogPath: DEFAULT_CATALOG_PATH,
  corpusPath: null,
  assetsBaseDir: null,
  thresholds: Object.freeze({
    dedupeBlock: 0.55,
    dedupeWarn: 0.4,
  }),
});

/** Reads + parses a JSON file if it exists; returns null otherwise. */
export function readJsonIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read config at ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config JSON at ${filePath}: ${err.message}`);
  }
}

/**
 * Merges defaults <- autopilot.config.json (if present) <- overrides
 * (CLI flags). `configPath` defaults to autopilot/autopilot.config.json;
 * pass `overrides: {}` explicitly to skip CLI-flag layering (e.g. in tests).
 */
export function loadConfig({ configPath = DEFAULT_CONFIG_PATH, overrides = {} } = {}) {
  const fileConfig = readJsonIfExists(configPath) || {};
  return {
    ...DEFAULTS,
    ...fileConfig,
    ...overrides,
    thresholds: {
      ...DEFAULTS.thresholds,
      ...(fileConfig.thresholds || {}),
      ...(overrides.thresholds || {}),
    },
  };
}
