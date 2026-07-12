// autopilot/src/lint/rules/price-law.mjs
//
// Brand law source: marketing/00-brand/brand-guide.md §2 ("Price, standard"
// / "Price, premium" / "Price, custom" rows) + ads-pack.md honesty-checklist
// item 1 ("does every number match exactly $15 / $45 / 'from $250' — no
// other figure, no strikethrough, no fake 'was/now'?").
//
// Captions/overlays may ONLY carry $15, $45, or "from $250". The one
// documented exception is arithmetic reference to the two base tiers — the
// script-pack precedent (tiktok-scripts.md S12 "$15 vs $45, side by side"):
// its hook says "here's what $30 actually buys you" and the same script
// also states both "$15" and "$45" in full. $30 is exactly $45-$15, so it
// is allowed ONLY when both real prices are also present in the same text.
// This is implemented narrowly (not generalized to arbitrary sums/
// differences of $15/$45/$250) since the ticket names this one precedent
// specifically and the stricter reading is to not invent further leniency.

import { getTextFields, excerpt } from '../text-utils.mjs';

const DOLLAR_RE = /\$\s?(\d[\d,]*)(?:\.\d+)?/g;
const WAS_NOW_RE = /\b(was|now)\s+\$\s?\d[\d,]*(?:\.\d+)?\b/i;
const STRIKETHROUGH_RE = /~~?[^~\n]*\$\s?\d[\d,]*[^~\n]*~~?/;

// The one documented arithmetic exception: "$30" when $15 AND $45 both
// appear verbatim in the same text (script-pack precedent, S12).
const ARITHMETIC_EXCEPTIONS = [{ result: 30, operands: [15, 45] }];

function checkStrikePatterns(field, text, violations) {
  const wasNow = text.match(WAS_NOW_RE);
  if (wasNow) {
    violations.push({
      rule: 'price-law:was-now-strike',
      severity: 'block',
      excerpt: `[${field}] "was/now" strike pattern — ${excerpt(text, wasNow.index, wasNow[0].length)}`,
    });
  }
  const strike = text.match(STRIKETHROUGH_RE);
  if (strike) {
    violations.push({
      rule: 'price-law:strikethrough-markup',
      severity: 'block',
      excerpt: `[${field}] strikethrough price markup — ${excerpt(text, strike.index, strike[0].length)}`,
    });
  }
}

function checkDollarAmounts(field, text, violations) {
  const re = new RegExp(DOLLAR_RE.source, DOLLAR_RE.flags);
  let m;
  while ((m = re.exec(text))) {
    const amount = Number(m[1].replace(/,/g, ''));
    const idx = m.index;

    if (amount === 15 || amount === 45) continue; // canonical inline prices

    if (amount === 250) {
      const preceding = text.slice(Math.max(0, idx - 10), idx);
      const isFromPrefixed = /\bfrom\s+$/i.test(preceding);
      if (isFromPrefixed) continue; // "from $250" is the only allowed $250 form
      violations.push({
        rule: 'price-law:bare-250',
        severity: 'block',
        excerpt: `[${field}] "$250" without the required "from" prefix — ${excerpt(text, idx, m[0].length)}`,
      });
      continue;
    }

    const exception = ARITHMETIC_EXCEPTIONS.find((ex) => ex.result === amount);
    if (exception) {
      const hasAllOperands = exception.operands.every((op) => new RegExp(`\\$\\s?${op}\\b`).test(text));
      if (hasAllOperands) continue; // e.g. "$30" alongside both "$15" and "$45"
    }

    violations.push({
      rule: 'price-law:disallowed-amount',
      severity: 'block',
      excerpt: `[${field}] "$${m[1]}" — only $15, $45, or "from $250" may appear — ${excerpt(text, idx, m[0].length)}`,
    });
  }
}

export function checkPriceLaw(item, _ctx) {
  const violations = [];
  for (const { field, text } of getTextFields(item)) {
    checkStrikePatterns(field, text, violations);
    checkDollarAmounts(field, text, violations);
  }
  return violations;
}
