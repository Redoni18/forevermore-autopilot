// autopilot/src/lint/dedupe.mjs
//
// QA gate 2 (PRD §7.3): hook 4-gram Jaccard similarity vs a corpus of
// trailing-90-day items [{id, hook}] the pipeline passes in. block >0.55,
// warn >0.40. Produces the ContentItem `dedupe` field shape
// {hook_sim, nearest_item, method} AND feeds a matching entry into
// lint.violations so lintItem's overall `passed` reflects both gates —
// this module is gate 2, not one of the 9 gate-1 rule families, so it
// lives beside engine.mjs/config.mjs rather than under rules/.

const N = 4;
const DEFAULT_BLOCK_THRESHOLD = 0.55;
const DEFAULT_WARN_THRESHOLD = 0.4;

function normalizeWords(text) {
  return (text.toLowerCase().match(/[a-z0-9'’-]+/g) || []);
}

function ngramSet(words, n) {
  if (words.length === 0) return new Set();
  if (words.length < n) return new Set([words.join(' ')]); // short-hook fallback
  const set = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    set.add(words.slice(i, i + n).join(' '));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @returns {{ dedupe: {hook_sim:number, nearest_item:string|null, method:string}, violations: Array }}
 */
export function computeDedupe(item, corpus = [], config = {}) {
  const blockThreshold = config?.thresholds?.dedupeBlock ?? DEFAULT_BLOCK_THRESHOLD;
  const warnThreshold = config?.thresholds?.dedupeWarn ?? DEFAULT_WARN_THRESHOLD;
  const hook = item?.overlays?.hook;

  const dedupe = { hook_sim: 0, nearest_item: null, method: `jaccard-${N}gram` };

  if (typeof hook !== 'string' || !hook.trim() || !Array.isArray(corpus) || corpus.length === 0) {
    return { dedupe, violations: [] };
  }

  const candidateGrams = ngramSet(normalizeWords(hook), N);
  let best = { sim: 0, id: null };
  for (const entry of corpus) {
    if (!entry || typeof entry.hook !== 'string') continue;
    const grams = ngramSet(normalizeWords(entry.hook), N);
    const sim = jaccard(candidateGrams, grams);
    if (sim > best.sim) best = { sim, id: entry.id ?? null };
  }

  dedupe.hook_sim = Math.round(best.sim * 10000) / 10000;
  dedupe.nearest_item = best.id;

  const violations = [];
  if (best.sim > blockThreshold) {
    violations.push({
      rule: 'dedupe:hook-similarity',
      severity: 'block',
      excerpt: `hook_sim=${dedupe.hook_sim} vs nearest_item="${best.id}" exceeds block threshold ${blockThreshold}`,
    });
  } else if (best.sim > warnThreshold) {
    violations.push({
      rule: 'dedupe:hook-similarity',
      severity: 'warn',
      excerpt: `hook_sim=${dedupe.hook_sim} vs nearest_item="${best.id}" exceeds warn threshold ${warnThreshold}`,
    });
  }

  return { dedupe, violations };
}
