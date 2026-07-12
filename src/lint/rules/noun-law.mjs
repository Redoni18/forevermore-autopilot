// autopilot/src/lint/rules/noun-law.mjs
//
// Brand law source: marketing/00-brand/brand-guide.md §1 "What we are":
// "Never say 'experience', 'platform', 'product', or 'content' for the
// gift." / "'Card' and 'slideshow' exist only as the thing we're not."
//
// Two sub-checks:
//   - watched-noun: warn (needs judgment) when experience/platform/product/
//     content sits within 3 tokens of a gift/world context word — these
//     words are legitimate in *other* contexts (e.g. "platform" in an
//     unrelated sense), so this stays a warn, not a block.
//   - forbidden-noun: block "e-card"/"slideshow" outright unless negated
//     ("not a card", "not a slideshow" — the site's own contrast device).

import { getTextFields, excerpt } from '../text-utils.mjs';

const WATCHED_NOUNS = new Set(['experience', 'platform', 'product', 'content']);
const GIFT_CONTEXT_WORDS = new Set(['gift', 'gifts', 'world', 'worlds']);
const FORBIDDEN_NOUN_RE = /\be-?card\b|\bslideshow\b/gi;
const NEGATION_BEFORE_RE = /\bnot\s+an?\s*$/i;

function isNearGiftContext(words, idx, windowSize = 3) {
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(words.length, idx + windowSize + 1);
  for (let i = start; i < end; i++) {
    if (i === idx) continue;
    if (GIFT_CONTEXT_WORDS.has(words[i])) return true;
  }
  return false;
}

function checkWatchedNouns(field, text, violations) {
  const words = text.match(/[A-Za-z0-9'’-]+/g) || [];
  const lower = words.map((w) => w.toLowerCase());
  lower.forEach((w, i) => {
    if (WATCHED_NOUNS.has(w) && isNearGiftContext(lower, i)) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lower.length, i + 4);
      violations.push({
        rule: 'noun-law:watched-noun',
        severity: 'warn',
        excerpt: `[${field}] "${words[i]}" used for the gift — "…${words.slice(start, end).join(' ')}…"`,
      });
    }
  });
}

function checkForbiddenNouns(field, text, violations) {
  const re = new RegExp(FORBIDDEN_NOUN_RE.source, FORBIDDEN_NOUN_RE.flags);
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (NEGATION_BEFORE_RE.test(before)) continue; // "not a card" / "not an e-card"
    violations.push({
      rule: 'noun-law:forbidden-noun',
      severity: 'block',
      excerpt: `[${field}] "${m[0]}" is the thing we're not, unless negated — ${excerpt(text, m.index, m[0].length)}`,
    });
  }
}

export function checkNounLaw(item, _ctx) {
  const violations = [];
  for (const { field, text } of getTextFields(item)) {
    checkWatchedNouns(field, text, violations);
    checkForbiddenNouns(field, text, violations);
  }
  return violations;
}
