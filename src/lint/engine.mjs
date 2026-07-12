#!/usr/bin/env node
// autopilot/src/lint/engine.mjs
//
// Forevermore Autopilot — deterministic brand-law lint engine (AP-401).
// QA gates 1 + 2 (PRD §7.3): rule-family lint + hook dedupe.
//
// API (pure function, no filesystem access):
//   lintItem(item, { catalog, corpus, config }) -> { lint, dedupe }
//     lint   = { passed, violations: [{ rule, severity, excerpt }] }
//     dedupe = { hook_sim, nearest_item, method }
//
// CLI:
//   node autopilot/src/lint/engine.mjs <item.json> [--catalog path]
//     [--corpus path] [--config path] [--assets-base-dir path]
//   Reads catalog/corpus paths from autopilot/autopilot.config.json if
//   present, else sensible defaults (marketing/_research/template-catalog.md
//   for the catalog; no corpus by default), else the flags above.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBannedLexicon } from './rules/banned-lexicon.mjs';
import { checkPriceLaw } from './rules/price-law.mjs';
import { checkOffLimitsClaims } from './rules/off-limits-claims.mjs';
import { checkNounLaw } from './rules/noun-law.mjs';
import { checkStyle } from './rules/style.mjs';
import { checkLinkUtm } from './rules/link-utm.mjs';
import { checkWorldReferences } from './rules/world-checks.mjs';
import { checkAssetSpecs } from './rules/asset-specs.mjs';
import { checkSafeArea } from './rules/safe-area.mjs';
import { computeDedupe } from './dedupe.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs';
import { loadCatalog } from './catalog.mjs';
import { loadCorpus } from './corpus.mjs';

// One module per rule family (gate 1). Order doesn't affect the result —
// violations from every family are pooled before computing `passed`.
export const RULES = [
  checkBannedLexicon,
  checkPriceLaw,
  checkOffLimitsClaims,
  checkNounLaw,
  checkStyle,
  checkLinkUtm,
  checkWorldReferences,
  checkAssetSpecs,
  checkSafeArea,
];

/**
 * Lints one ContentItem against gate 1 (rule families) and gate 2 (dedupe).
 * Pure function: never touches the filesystem, never throws for well-formed
 * input, safe to call in a hot pipeline loop or from tests.
 */
export function lintItem(item, { catalog = [], corpus = [], config = {} } = {}) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('lintItem(item, ctx): item must be an object');
  }

  const ctx = { catalog, corpus, config };
  const violations = [];
  for (const rule of RULES) {
    violations.push(...rule(item, ctx));
  }

  const { dedupe, violations: dedupeViolations } = computeDedupe(item, corpus, config);
  violations.push(...dedupeViolations);

  const passed = !violations.some((v) => v.severity === 'block');

  return {
    lint: { passed, violations },
    dedupe,
  };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--catalog') args.catalog = argv[++i];
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--assets-base-dir') args.assetsBaseDir = argv[++i];
    else args._.push(a);
  }
  return args;
}

function severityIcon(sev) {
  return sev === 'block' ? '✖' : '⚠'; // ✖ / ⚠
}

function printReport(itemPath, result) {
  const { lint, dedupe } = result;
  const lines = [];
  lines.push('');
  lines.push(`Lint report — ${itemPath}`);
  lines.push(`Status: ${lint.passed ? 'PASS' : 'FAIL'} (${lint.violations.length} violation(s))`);
  if (lint.violations.length === 0) {
    lines.push('  No violations.');
  } else {
    for (const v of lint.violations) {
      lines.push(`  ${severityIcon(v.severity)} [${v.severity.toUpperCase()}] ${v.rule}`);
      lines.push(`      ${v.excerpt}`);
    }
  }
  lines.push('');
  lines.push(`Dedupe: hook_sim=${dedupe.hook_sim} nearest_item=${dedupe.nearest_item ?? 'n/a'} method=${dedupe.method}`);
  lines.push('');
  console.log(lines.join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const itemPath = args._[0];

  if (!itemPath) {
    console.error(
      'Usage: node autopilot/src/lint/engine.mjs <item.json> ' +
        '[--catalog path] [--corpus path] [--config path] [--assets-base-dir path]',
    );
    process.exitCode = 2;
    return;
  }

  const config = loadConfig({
    configPath: args.config || DEFAULT_CONFIG_PATH,
    overrides: {
      ...(args.catalog ? { catalogPath: args.catalog } : {}),
      ...(args.corpus ? { corpusPath: args.corpus } : {}),
      ...(args.assetsBaseDir ? { assetsBaseDir: args.assetsBaseDir } : {}),
    },
  });

  let catalog = [];
  try {
    catalog = loadCatalog(config.catalogPath);
  } catch (err) {
    console.error(`Warning: failed to load catalog from ${config.catalogPath}: ${err.message}`);
  }

  let corpus = [];
  try {
    corpus = loadCorpus(config.corpusPath);
  } catch (err) {
    console.error(`Warning: failed to load corpus from ${config.corpusPath}: ${err.message}`);
  }

  const raw = fs.readFileSync(itemPath, 'utf8');
  const item = JSON.parse(raw);

  const result = lintItem(item, { catalog, corpus, config });
  printReport(itemPath, result);
  process.exitCode = result.lint.passed ? 0 : 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
