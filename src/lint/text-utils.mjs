// autopilot/src/lint/text-utils.mjs
//
// Shared text-extraction and matching helpers used by every rule module.
// Kept dependency-free (pure Node 22 ESM, no npm packages).

/**
 * Pulls every outward-facing text field off a ContentItem (PRD §5 contract)
 * as a flat list of { field, text }. `field` is a dotted path used in
 * violation excerpts so a human can find the offending copy immediately.
 */
export function getTextFields(item) {
  const fields = [];
  if (item && typeof item.caption === 'string' && item.caption.length > 0) {
    fields.push({ field: 'caption', text: item.caption });
  }
  const overlays = item && item.overlays;
  if (overlays && typeof overlays === 'object' && !Array.isArray(overlays)) {
    if (typeof overlays.hook === 'string' && overlays.hook.length > 0) {
      fields.push({ field: 'overlays.hook', text: overlays.hook });
    }
    if (Array.isArray(overlays.beats)) {
      overlays.beats.forEach((beat, i) => {
        if (typeof beat === 'string' && beat.length > 0) {
          fields.push({ field: `overlays.beats[${i}]`, text: beat });
        }
      });
    }
    if (typeof overlays.cta === 'string' && overlays.cta.length > 0) {
      fields.push({ field: 'overlays.cta', text: overlays.cta });
    }
  }
  return fields;
}

/**
 * Overlay-only text fields (hook + beats, NOT caption/cta) — the scope the
 * AP-401 spec names explicitly for the sentence-case heuristic.
 */
export function getOverlayHookBeatsFields(item) {
  return getTextFields(item).filter(
    (f) => f.field === 'overlays.hook' || f.field.startsWith('overlays.beats['),
  );
}

/** Word tokenizer: keeps letters/digits/apostrophes/hyphens as one token. */
export function tokenizeWords(text) {
  return text.match(/[A-Za-z0-9'’-]+/g) || [];
}

/** Lowercased word list — convenience wrapper around tokenizeWords. */
export function normalizeWords(text) {
  return tokenizeWords(text).map((w) => w.toLowerCase());
}

/** Lowercased tokens appearing immediately before `index` in `text`. */
export function precedingTokens(text, index, count = 3) {
  const before = text.slice(0, Math.max(0, index));
  const words = tokenizeWords(before);
  return words.slice(-count).map((w) => w.toLowerCase());
}

/** True if one of `negWords` appears in the `count` tokens before `index`. */
export function isNegatedBefore(text, index, negWords = ['no', 'not'], count = 2) {
  const tokens = precedingTokens(text, index, count);
  return tokens.some((t) => negWords.includes(t));
}

/** Short, human-readable snippet around a regex match for violation excerpts. */
export function excerpt(text, index, matchLength = 0, radius = 28) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/** Escapes a literal string for safe embedding inside a RegExp. */
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runs each pattern against `text` (globally, even if defined without the
 * `g` flag) and pushes one violation per match onto `violations`.
 */
export function pushPatternViolations(violations, field, text, patterns, ruleName, severity = 'block') {
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let m;
    while ((m = re.exec(text))) {
      violations.push({
        rule: ruleName,
        severity,
        excerpt: `[${field}] ${excerpt(text, m.index, m[0].length)}`,
      });
      if (m[0].length === 0) re.lastIndex += 1; // guard against zero-width infinite loops
    }
  }
}
