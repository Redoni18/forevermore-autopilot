// autopilot/src/lint/rules/link-utm.mjs
//
// PRD §9.4: caption links carry
// `getforevermore.co?utm_source={platform}&utm_medium=organic&...`.
// Neither TikTok nor Instagram captions render clickable links, so the
// bare domain is what actually appears in the caption text; the tagged URL
// instead lives in `item.link_utm` — "the field is what gets pasted into
// bio/comment" per the ticket. Warn-only: this never blocks an item.

const DOMAIN_RE = /getforevermore\.co/i;
const URL_WITH_QUERY_RE = /getforevermore\.co\/?\?([^\s"'<>]*)/i;

function utmSourceFrom(queryString) {
  return new URLSearchParams(queryString).get('utm_source');
}

export function checkLinkUtm(item, _ctx) {
  const violations = [];
  const caption = typeof item.caption === 'string' ? item.caption : '';
  if (!DOMAIN_RE.test(caption)) return violations; // no link mentioned at all

  const urlMatch = caption.match(URL_WITH_QUERY_RE);

  if (urlMatch) {
    const utmSource = utmSourceFrom(urlMatch[1]);
    if (!utmSource) {
      violations.push({
        rule: 'link-utm:missing-utm-source',
        severity: 'warn',
        excerpt: `[caption] link has no utm_source param: "${urlMatch[0]}"`,
      });
    } else if (utmSource.toLowerCase() !== String(item.platform || '').toLowerCase()) {
      violations.push({
        rule: 'link-utm:utm-source-mismatch',
        severity: 'warn',
        excerpt: `[caption] utm_source="${utmSource}" does not match platform "${item.platform}"`,
      });
    }
    return violations;
  }

  // Bare domain mention — require link_utm (the bio/comment-paste field).
  const linkUtm = typeof item.link_utm === 'string' ? item.link_utm.trim() : '';
  if (!linkUtm) {
    violations.push({
      rule: 'link-utm:missing-link-utm-field',
      severity: 'warn',
      excerpt: '[caption] mentions getforevermore.co with no query string; link_utm (for bio/comment) is missing',
    });
    return violations;
  }

  const queryString = linkUtm.split('?')[1] || '';
  const utmSource = utmSourceFrom(queryString);
  if (!utmSource) {
    violations.push({
      rule: 'link-utm:link-field-missing-utm-source',
      severity: 'warn',
      excerpt: `[link_utm] "${linkUtm}" has no utm_source param`,
    });
  } else if (utmSource.toLowerCase() !== String(item.platform || '').toLowerCase()) {
    violations.push({
      rule: 'link-utm:link-field-utm-source-mismatch',
      severity: 'warn',
      excerpt: `[link_utm] utm_source="${utmSource}" does not match platform "${item.platform}"`,
    });
  }

  return violations;
}
