// autopilot/src/lint/rules/style.mjs
//
// Brand law source: marketing/00-brand/brand-guide.md §3 "Voice" ("Sentence
// case always — headlines and captions are never Title Cased" / exclamation
// points "never in body copy or CTAs") + §5 "Social-specific conventions"
// (TikTok 3-5 tags / IG under ~8, captions) + instagram-pack.md /
// ads-pack.md ("no exclamation points"). Four sub-checks:
//   - title-case-run: overlay hook/beats ONLY (ticket's explicit scope),
//     blocks runs of >=4 consecutive Title-Case words, masking out catalog
//     world names + brand words first so proper nouns don't false-positive.
//   - exclamation-marks: captions only, block on >0 (ads-pack precedent).
//   - hashtag-count: tiktok <=5, instagram <=10 (block).
//   - caption-length: tiktok <=150 warn, instagram <=2200 block.

import { getOverlayHookBeatsFields, escapeRegExp } from '../text-utils.mjs';

const BRAND_PROPER_NOUNS = ['Forevermore'];
const TITLE_CASE_WORD_RE = /^[A-Z][a-z'’]*$/;

function buildProperNounList(catalog) {
  const names = new Set(BRAND_PROPER_NOUNS);
  for (const w of catalog || []) {
    if (!w || !w.name) continue;
    names.add(w.name);
    if (w.name.startsWith('The ')) names.add(w.name.slice(4));
  }
  // Longest first so multi-word names are masked before any sub-phrase.
  return [...names].sort((a, b) => b.length - a.length);
}

function maskProperNouns(text, properNouns) {
  let masked = text;
  for (const noun of properNouns) {
    const re = new RegExp(`\\b${escapeRegExp(noun)}\\b`, 'g');
    masked = masked.replace(re, (match) => match.toLowerCase());
  }
  return masked;
}

function checkTitleCaseRun(field, text, properNouns, violations) {
  const masked = maskProperNouns(text, properNouns);
  const words = masked.match(/[A-Za-z'’-]+/g) || [];
  let run = [];
  const flush = () => {
    if (run.length >= 4) {
      violations.push({
        rule: 'style:title-case-run',
        severity: 'block',
        excerpt: `[${field}] Title Case run (${run.length} words) — sentence case is required: "${text.trim()}"`,
      });
    }
    run = [];
  };
  for (const w of words) {
    if (TITLE_CASE_WORD_RE.test(w)) run.push(w);
    else flush();
  }
  flush();
}

function checkExclamationMarks(item, violations) {
  if (typeof item.caption !== 'string') return;
  const count = (item.caption.match(/!/g) || []).length;
  if (count > 0) {
    violations.push({
      rule: 'style:exclamation-marks',
      severity: 'block',
      excerpt: `[caption] ${count} exclamation mark(s) — body copy/CTAs must have zero: "${item.caption}"`,
    });
  }
}

const HASHTAG_LIMITS = { tiktok: 5, instagram: 10 };

function checkHashtagCount(item, violations) {
  const tags = Array.isArray(item.hashtags) ? item.hashtags : [];
  const limit = HASHTAG_LIMITS[item.platform];
  if (limit != null && tags.length > limit) {
    violations.push({
      rule: 'style:hashtag-count',
      severity: 'block',
      excerpt: `[hashtags] ${tags.length} tags exceeds ${item.platform} limit of ${limit}: ${tags.map((t) => `#${t}`).join(' ')}`,
    });
  }
}

function stripTrailingHashtags(caption) {
  return caption.replace(/(?:\s*#[^\s#]+)+\s*$/, '').trim();
}

function checkCaptionLength(item, violations) {
  if (typeof item.caption !== 'string') return;
  const preTags = stripTrailingHashtags(item.caption);
  const len = preTags.length;
  if (item.platform === 'tiktok' && len > 150) {
    violations.push({
      rule: 'style:caption-length',
      severity: 'warn',
      excerpt: `[caption] ${len} chars (pre-tags) exceeds TikTok's 150-char guideline`,
    });
  }
  if (item.platform === 'instagram' && len > 2200) {
    violations.push({
      rule: 'style:caption-length',
      severity: 'block',
      excerpt: `[caption] ${len} chars (pre-tags) exceeds Instagram's 2200-char hard limit`,
    });
  }
}

export function checkStyle(item, ctx = {}) {
  const violations = [];
  const properNouns = buildProperNounList(ctx.catalog);
  for (const { field, text } of getOverlayHookBeatsFields(item)) {
    checkTitleCaseRun(field, text, properNouns, violations);
  }
  checkExclamationMarks(item, violations);
  checkHashtagCount(item, violations);
  checkCaptionLength(item, violations);
  return violations;
}
