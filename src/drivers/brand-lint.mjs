/**
 * @file Brand-lint bridge (AP-801). Adapts AP-401's full engine —
 * `lintItem(item, {catalog, corpus, config})` → `{lint, dedupe}` — to the
 * pipeline's injected LintFn seam `(item, ctx) → LintResult`.
 *
 * Responsibilities beyond pass-through:
 *  - loads the world catalog once (config.paths or the default markdown)
 *  - builds the dedupe corpus from the store: every item with a hook that is
 *    NOT in this item's candidate_group (siblings share a theme on purpose —
 *    comparing against them would self-block every slot)
 *  - unwraps the engine's `{lint, dedupe}` envelope into the LintResult shape
 *    the qa stage persists ({passed, violations, dedupe})
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lintItem } from '../lint/engine.mjs';
import { parseCatalogMarkdown } from '../lint/catalog.mjs';

/** statuses whose hooks count as "recent posts" for dedupe */
const CORPUS_STATUSES = [
  'pending_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'measured',
  'archived',
];

let catalogCache = null;

function loadCatalogOnce(config) {
  if (catalogCache) return catalogCache;
  // Catalog moved in-repo with the §3.12 kit move (2026-07-13): prefer the
  // resolved kit path, then an explicit lint override, then legacy fallbacks.
  const fmRoot = config?.resolved?.repoRoot;
  const candidates = [
    config?.lint?.catalogPath,
    config?.resolved?.catalog,
    fmRoot && join(fmRoot, 'marketing', '_research', 'template-catalog.md'),
    'marketing/_research/template-catalog.md', // cwd = platform repo (legacy)
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      catalogCache = parseCatalogMarkdown(readFileSync(p, 'utf8'));
      return catalogCache;
    }
  }
  catalogCache = [];
  return catalogCache;
}

async function buildCorpus(store, item) {
  if (!store) return [];
  const corpus = [];
  for (const status of CORPUS_STATUSES) {
    const items = await store.listByStatus(status);
    for (const other of items) {
      if (other.id === item.id) continue;
      if (item.candidate_group && other.candidate_group === item.candidate_group) continue;
      const hook = other.overlays && other.overlays.hook;
      if (hook) corpus.push({ id: other.id, hook });
    }
  }
  return corpus;
}

/** @type {import('../types.mjs').LintFn} */
export default async function brandLint(item, ctx = {}) {
  const catalog = loadCatalogOnce(ctx.config);
  const corpus = await buildCorpus(ctx.store, item);
  const result = lintItem(item, { catalog, corpus, config: ctx.config?.lint || {} });
  return {
    passed: result.lint.passed,
    violations: result.lint.violations,
    dedupe: result.dedupe,
  };
}
