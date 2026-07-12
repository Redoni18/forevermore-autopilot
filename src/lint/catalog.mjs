// autopilot/src/lint/catalog.mjs
//
// Loads the world/template catalog used by the world-checks rule and by
// style.mjs's proper-noun carve-out. Normative source: TICKETS.md AP-401 —
// "world-active check against packages/templates manifests via the catalog
// JSON" — and marketing/_research/template-catalog.md, which embeds the
// catalog as a fenced ```json block. A raw `.json` file path is also
// accepted (config override) and parsed directly, no fence needed.

import fs from 'node:fs';

const FENCE_RE = /```json\r?\n([\s\S]*?)\r?\n```/;

/** Extracts and parses the fenced ```json block from catalog markdown. */
export function parseCatalogMarkdown(markdown) {
  const match = markdown.match(FENCE_RE);
  if (!match) {
    throw new Error('parseCatalogMarkdown: no fenced ```json block found');
  }
  const data = JSON.parse(match[1]);
  if (!Array.isArray(data)) {
    throw new Error('parseCatalogMarkdown: fenced JSON block is not an array');
  }
  return data;
}

/**
 * Loads the catalog from disk. `.json` paths are parsed directly (config
 * override path); anything else is treated as markdown containing a fenced
 * JSON block (the default `template-catalog.md` source).
 */
export function loadCatalog(filePath) {
  if (!filePath) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error(`loadCatalog: ${filePath} does not contain a JSON array`);
    }
    return data;
  }
  return parseCatalogMarkdown(raw);
}
