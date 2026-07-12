// autopilot/src/lint/rules/banned-lexicon.mjs
//
// Brand law source: marketing/00-brand/brand-guide.md §3 "Banned" +
// marketing/03-content/ads-pack.md honesty-checklist item 8.
//
// IMPORTANT: banned words block even when used as a literal in-world
// mechanic (e.g. "unlock the vault" in a mining game). The guide's own
// precedent is the IG pack reworking literal uses of "unlock"/"journey" —
// there is no contextual carve-out. See TICKETS.md AP-401 AC.

import { getTextFields, excerpt, escapeRegExp } from '../text-utils.mjs';

const BANNED_TERMS = [
  'unleash',
  'elevate',
  'seamless',
  'unlock',
  'empower',
  'journey',
  'solution',
  'game-changer',
  'revolutionary',
  'cutting-edge',
  'unforgettable',
  'take it to the next level',
];

// "Introducing X — the ultimate Y" — wildcard middle, same-sentence scope.
const INTRODUCING_ULTIMATE_RE = /\bintroducing\b[^.!?\n]*\bthe ultimate\b/i;

const ROCKET_EMOJI_RE = /\u{1F680}/gu; // 🚀
const SPARKLE_EMOJI_RE = /✨/gu; // ✨

// Brand-approved tiny all-caps badges (brand-guide.md §4) — exempt from the
// ALL-CAPS body-copy check when they are the field's entire (trimmed) text.
const ALLCAPS_CHIP_WHITELIST = new Set(['MOST LOVED', '1 OF 1', 'WOW', 'THE FOREVERMORE WAY']);

function wordRegex(term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
}

function checkTerms(field, text, violations) {
  for (const term of BANNED_TERMS) {
    const re = wordRegex(term);
    let m;
    while ((m = re.exec(text))) {
      violations.push({
        rule: 'banned-lexicon:term',
        severity: 'block',
        excerpt: `[${field}] banned word "${term}" — ${excerpt(text, m.index, m[0].length)}`,
      });
    }
  }
}

function checkIntroducingUltimate(field, text, violations) {
  const m = text.match(INTRODUCING_ULTIMATE_RE);
  if (m) {
    violations.push({
      rule: 'banned-lexicon:introducing-ultimate',
      severity: 'block',
      excerpt: `[${field}] "Introducing … the ultimate" pattern — ${excerpt(text, m.index, m[0].length)}`,
    });
  }
}

function checkEmoji(field, text, violations) {
  const rockets = text.match(ROCKET_EMOJI_RE);
  if (rockets && rockets.length >= 1) {
    violations.push({
      rule: 'banned-lexicon:emoji-rocket',
      severity: 'block',
      excerpt: `[${field}] rocket emoji present (${rockets.length}×): "${text.trim()}"`,
    });
  }
  const sparkles = text.match(SPARKLE_EMOJI_RE);
  if (sparkles && sparkles.length > 1) {
    violations.push({
      rule: 'banned-lexicon:emoji-sparkle-spam',
      severity: 'block',
      excerpt: `[${field}] sparkle-emoji spam (${sparkles.length}×, >1 not allowed): "${text.trim()}"`,
    });
  }
}

function checkAllCapsRun(field, text, violations) {
  const trimmed = text.trim();
  if (ALLCAPS_CHIP_WHITELIST.has(trimmed)) return; // approved chip badge, verbatim

  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  let run = [];
  const flush = () => {
    if (run.length > 3) {
      violations.push({
        rule: 'banned-lexicon:all-caps-run',
        severity: 'block',
        excerpt: `[${field}] ALL-CAPS body copy (${run.length} consecutive words): "${run.join(' ')}"`,
      });
    }
    run = [];
  };
  for (const w of words) {
    const isAllCaps = w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w);
    if (isAllCaps) run.push(w);
    else flush();
  }
  flush();
}

export function checkBannedLexicon(item, _ctx) {
  const violations = [];
  for (const { field, text } of getTextFields(item)) {
    checkTerms(field, text, violations);
    checkIntroducingUltimate(field, text, violations);
    checkEmoji(field, text, violations);
    checkAllCapsRun(field, text, violations);
  }
  return violations;
}
