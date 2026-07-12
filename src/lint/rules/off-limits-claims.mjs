// autopilot/src/lint/rules/off-limits-claims.mjs
//
// Brand law source: marketing/00-brand/brand-guide.md §2 "⚠️ Claims OFF
// LIMITS in ads until the product catches up" + ads-pack.md honesty
// checklist items 2-5. Four sub-families, all block-severity:
//   1. off-limits-claims  — scheduled delivery / keepsake download /
//      recipient reply-reaction / "forever" as a legal guarantee.
//   2. no-ai-mention
//   3. no-invented-stats
//   4. no-fake-urgency (real dated occasions are explicitly allowed)

import { getTextFields, excerpt, isNegatedBefore, pushPatternViolations } from '../text-utils.mjs';

const SCHEDULED_DELIVERY_PATTERNS = [
  /\barrives?\s+on\b/i,
  /\bschedule\s+it\s+for\b/i,
  /\bdeliver(?:s|ed|ing)?\s+it\s+on\s+the\s+day\b/i,
];

const KEEPSAKE_COPY_RE = /\bkeepsake\s+cop(?:y|ies)\b/gi;
const DOWNLOAD_RE = /\bdownload(?:able|s|ed|ing)?\b/gi;

const RECIPIENT_REPLY_PATTERNS = [
  /\brecipients?\s+can\s+(?:reply|react)\b/i,
  /\b(?:they|the recipient)\s+can\s+(?:reply|react)\b/i,
  /\brepl(?:y|ies|ying)\s+(?:back\s+)?to\s+(?:the\s+)?(?:gift|letter|world|sender)\b/i,
  /\breact(?:s|ing)?\s+to\s+(?:the\s+)?(?:gift|letter|world)\b/i,
  /\bsend(?:s)?\s+(?:a\s+)?reaction(?:s)?\s+back\b/i,
];

// "Forever" framed as a legal permanence guarantee — the approved verbatims
// ("theirs to keep", "stays theirs", "Pay once. It's theirs forever.")
// never match these; they don't need an explicit allowlist carve-out.
const FOREVER_GUARANTEE_PATTERNS = [
  /\bguaranteed\s+forever\b/i,
  /\bforever\s+guaranteed\b/i,
  /\bnever\s+goes\s+away\b/i,
];

const AI_MENTION_PATTERNS = [
  /\bartificial\s+intelligence\b/i,
  /\bai[- ]generated\b/i,
  /\bgenerated\s+by\s+ai\b/i,
  /\bchatgpt\b/i,
  /\bmachine[- ]generated\b/i,
  /\bai\b/i,
];

const INVENTED_STATS_RE = /\b[0-9][0-9,]*\+?\s+(?:happy\s+)?(?:customers|people|gifts sold)\b/gi;

const FAKE_URGENCY_PATTERNS = [
  /\blimited\s+spots?\b/i,
  /\bonly\s+\d+\s+(?:spots?|left)\b/i,
  /\bhurry\b/i,
  /\bcountdown\b/i,
  /\bends?\s+in\s+\d+/i,
  /\blast\s+chance\b/i,
  /\btime'?s?\s+running\s+out\b/i,
  /\bact\s+now\b/i,
];

function checkKeepsakeAndDownload(field, text, violations) {
  let m;
  const keepsakeRe = new RegExp(KEEPSAKE_COPY_RE.source, KEEPSAKE_COPY_RE.flags);
  while ((m = keepsakeRe.exec(text))) {
    violations.push({
      rule: 'off-limits-claims:keepsake-download',
      severity: 'block',
      excerpt: `[${field}] "keepsake copy" (no export feature exists) — ${excerpt(text, m.index, m[0].length)}`,
    });
  }

  // "download" itself is fine when negated — "No app. No account. No
  // download." is an approved verbatim (brand-guide.md §2, Recipient effort).
  const downloadRe = new RegExp(DOWNLOAD_RE.source, DOWNLOAD_RE.flags);
  while ((m = downloadRe.exec(text))) {
    if (isNegatedBefore(text, m.index, ['no', 'not'], 2)) continue;
    violations.push({
      rule: 'off-limits-claims:download-claim',
      severity: 'block',
      excerpt: `[${field}] downloadability claim (no export feature exists) — ${excerpt(text, m.index, m[0].length)}`,
    });
  }
}

export function checkOffLimitsClaims(item, _ctx) {
  const violations = [];
  for (const { field, text } of getTextFields(item)) {
    pushPatternViolations(violations, field, text, SCHEDULED_DELIVERY_PATTERNS, 'off-limits-claims:scheduled-delivery');
    checkKeepsakeAndDownload(field, text, violations);
    pushPatternViolations(violations, field, text, RECIPIENT_REPLY_PATTERNS, 'off-limits-claims:recipient-reply');
    pushPatternViolations(violations, field, text, FOREVER_GUARANTEE_PATTERNS, 'off-limits-claims:forever-guarantee');
    pushPatternViolations(violations, field, text, AI_MENTION_PATTERNS, 'off-limits-claims:ai-mention');
    pushPatternViolations(violations, field, text, [INVENTED_STATS_RE], 'off-limits-claims:invented-stats');
    pushPatternViolations(violations, field, text, FAKE_URGENCY_PATTERNS, 'off-limits-claims:fake-urgency');
  }
  return violations;
}
