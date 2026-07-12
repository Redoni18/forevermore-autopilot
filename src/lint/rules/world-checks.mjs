// autopilot/src/lint/rules/world-checks.mjs
//
// TICKETS.md AP-401: "world-active check against packages/templates
// manifests via the catalog JSON" (marketing/_research/template-catalog.md).
// Every world named in the item must exist in the catalog; a mention of a
// world with isActive:false blocks, naming the world and suggesting active
// alternates from the same tier.
//
// Two detection paths, both feeding the same checks:
//   1. Explicit structured refs — item.world / item.worlds (slug or name),
//      if the pipeline/idea payload attaches them.
//   2. Free-text mentions — catalog world names (with/without a leading
//      "The ") appearing verbatim in caption/overlay copy, the common case
//      for finished social captions.

import { getTextFields } from '../text-utils.mjs';

function stripLeadingThe(name) {
  return name.startsWith('The ') ? name.slice(4) : name;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNameIndex(catalog) {
  const list = [];
  for (const world of catalog || []) {
    if (!world || !world.name) continue;
    list.push({ match: world.name, world });
    const stripped = stripLeadingThe(world.name);
    if (stripped !== world.name) list.push({ match: stripped, world });
  }
  // Longest phrase first so e.g. "The Blockheart Mine" is tried before any
  // shorter overlapping candidate.
  list.sort((a, b) => b.match.length - a.match.length);
  return list;
}

function findCatalogEntry(catalog, ref) {
  if (!ref) return null;
  const lower = String(ref).toLowerCase();
  return (
    (catalog || []).find(
      (w) =>
        (w.slug && w.slug.toLowerCase() === lower) ||
        (w.name && w.name.toLowerCase() === lower) ||
        (w.name && stripLeadingThe(w.name).toLowerCase() === lower),
    ) || null
  );
}

function alternatesFor(catalog, world, limit = 3) {
  return (catalog || [])
    .filter((w) => w.tier === world.tier && w.isActive && w.slug !== world.slug)
    .slice(0, limit)
    .map((w) => w.name);
}

function inactiveViolation(field, world, catalog, matchedText) {
  const alternates = alternatesFor(catalog, world);
  const altText = alternates.length
    ? `Active ${world.tier} alternates: ${alternates.join(', ')}.`
    : `No active ${world.tier} alternates found in the catalog.`;
  return {
    rule: 'world-checks:inactive-world',
    severity: 'block',
    excerpt: `[${field}] "${matchedText}" (${world.name}) is not active. ${altText}`,
  };
}

export function checkWorldReferences(item, ctx = {}) {
  const catalog = ctx.catalog || [];
  const violations = [];

  // 1. Explicit structured references, if the item carries them.
  const explicitRefs = [].concat(item.worlds || []).concat(item.world ? [item.world] : []);
  for (const ref of explicitRefs) {
    const entry = findCatalogEntry(catalog, ref);
    if (!entry) {
      violations.push({
        rule: 'world-checks:unknown-world',
        severity: 'block',
        excerpt: `[worlds] "${ref}" was not found in the template catalog`,
      });
      continue;
    }
    if (!entry.isActive) {
      violations.push(inactiveViolation('worlds', entry, catalog, String(ref)));
    }
  }

  // 2. Free-text mentions in caption/overlays.
  const nameIndex = buildNameIndex(catalog);
  for (const { field, text } of getTextFields(item)) {
    const seenSlugs = new Set();
    for (const { match, world } of nameIndex) {
      if (seenSlugs.has(world.slug)) continue;
      const re = new RegExp(`\\b${escapeRegExp(match)}\\b`, 'i');
      const m = text.match(re);
      if (m) {
        seenSlugs.add(world.slug);
        if (!world.isActive) {
          violations.push(inactiveViolation(field, world, catalog, m[0]));
        }
      }
    }
  }

  return violations;
}
