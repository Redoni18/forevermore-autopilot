/**
 * @file The DETERMINISTIC planning core (PRD §6.3, v0 — no model).
 *
 * `planWeek()` is a pure function: identical inputs → byte-identical output
 * (no clock, no RNG, no I/O). It emits `planned` ContentItem shells for the
 * next `horizonDays` days (T+1..T+horizon) honoring the D-6 cadence (1 IG + 1
 * TikTok slot/day by default), `candidates_per_slot` candidates per slot, with
 * ideas selected by `baseScore × recencyPenalty` and a per-run "don't repeat an
 * idea across the week" rule.
 *
 * The model "garnish" (re-picking / off-list proposals, PRD §6.3 step 3) is
 * ticket AP-301's job; v0 is fully deterministic so `plan --dry-run` is testable.
 */

import { addDays, zonedISO } from '../util/time.mjs';
import { itemId, candidateGroupId } from '../util/ids.mjs';
import {
  ideaEligibleFor,
  riskFor,
  baseScore,
  formatForSlot,
  formatPreferenceRank,
  DEFAULT_FORMAT_MIX,
} from './ideas.mjs';

/** Recency window (days): an idea used `WINDOW`+ days ago carries no penalty. */
const RECENCY_WINDOW_DAYS = 30;
/** Never fully zero an idea out on recency; keep it selectable. */
const RECENCY_FLOOR = 0.1;

/** ISO weekday 1..7 (Mon..Sun) for a `YYYY-MM-DD` string (UTC-based). */
function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd;
}

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * Recency penalty in [FLOOR, 1]: recently-used ideas are down-weighted, ideas
 * unused for `WINDOW`+ days (or never used) score at full strength.
 * @param {string|null} lastUsed `YYYY-MM-DD` or null @param {string} slotDate
 */
function recencyPenalty(lastUsed, slotDate) {
  if (!lastUsed) return 1;
  const since = daysBetween(lastUsed, slotDate);
  if (since >= RECENCY_WINDOW_DAYS) return 1;
  if (since <= 0) return RECENCY_FLOOR;
  return Math.max(RECENCY_FLOOR, since / RECENCY_WINDOW_DAYS);
}

/** Build one `planned` candidate shell (PRD §5 contract; no timestamps here). */
function shell({ id, slot_at, platform, format, idea, cg, producedBy }) {
  const pillar = idea.pillar || null;
  const link_utm =
    `https://getforevermore.co?utm_source=${platform}` +
    `&utm_medium=organic&utm_campaign=${pillar || 'none'}&utm_content=${id}`;
  return {
    id,
    slot_at,
    platform,
    format,
    idea_id: idea.id,
    series_key: null,
    pillar,
    risk: riskFor(idea),
    status: 'planned',
    candidate_group: cg,
    chosen: false,
    caption: null,
    hashtags: [],
    overlays: {},
    link_utm,
    assets: [],
    lint: null,
    dedupe: null,
    produced_by: producedBy || null,
    attempt: 1,
    regen_of: null,
  };
}

/**
 * @typedef {Object} PlanOptions
 * @property {Object[]} ideas
 * @property {Object<string,{last_used_at?:string, uses?:number}>} [usage]  Recency journal.
 * @property {Object} cadence   { instagram_per_day, tiktok_per_day, candidates_per_slot, quiet_days }
 * @property {Object<string,string>} slotTimes  { instagram:'17:30', tiktok:'19:00' }
 * @property {Object} [formatMix]  Per-platform, per-ISO-weekday format pattern
 *   (defaults to {@link DEFAULT_FORMAT_MIX}). The slot's format comes from HERE.
 * @property {string} timezone
 * @property {string} startDate  Run date T; slots are planned for T+1..T+horizon.
 * @property {number} [horizonDays]
 * @property {string|null} [producedBy]  Run id to stamp (null keeps output pure/testable).
 */

/**
 * Produce the week's planned candidate shells, deterministically.
 * @param {PlanOptions} opts @returns {import('../types.mjs').ContentItem[]}
 */
export function planWeek(opts) {
  const {
    ideas,
    usage = {},
    cadence,
    slotTimes,
    formatMix = DEFAULT_FORMAT_MIX,
    timezone,
    startDate,
    horizonDays = 7,
    producedBy = null,
  } = opts;

  const candPer = cadence.candidates_per_slot;
  const igPer = cadence.instagram_per_day;
  const ttPer = cadence.tiktok_per_day;
  const quiet = new Set(cadence.quiet_days || []);

  // Working recency map, seeded from the usage journal, then advanced as we
  // assign within this run so an idea picked early is penalized later the same
  // week. Pure + deterministic (a fold over slots in fixed order).
  /** @type {Record<string,string|null>} */
  const recency = {};
  for (const [id, u] of Object.entries(usage)) recency[id] = (u && u.last_used_at) || null;
  const usedThisRun = new Set();

  /** @type {import('../types.mjs').ContentItem[]} */
  const items = [];

  for (let d = 1; d <= horizonDays; d++) {
    const slotDate = addDays(startDate, d);
    const weekday = isoWeekday(slotDate);
    if (quiet.has(weekday)) continue;

    // Fixed slot order per day: Instagram then TikTok.
    const slots = [];
    for (let i = 0; i < igPer; i++) slots.push('instagram');
    for (let i = 0; i < ttPer; i++) slots.push('tiktok');

    for (const platform of slots) {
      const cg = candidateGroupId(slotDate, platform);
      // The slot's format comes from the format-mix pattern (AP-820), NOT from
      // the idea — this is what gives the week planned variety.
      const format = formatForSlot(platform, weekday, formatMix);
      const pool = ideas.filter((x) => x.active !== false && ideaEligibleFor(x, platform));

      const scored = pool
        .map((idea) => ({
          idea,
          rank: formatPreferenceRank(idea, format),
          s: baseScore(idea) * recencyPenalty(recency[idea.id], slotDate),
        }))
        // Deterministic order: format-preference tier first (so a carousel slot
        // prefers a purpose-built carousel idea), then score desc, then id asc.
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            b.s - a.s ||
            String(a.idea.id).localeCompare(String(b.idea.id)),
        );

      // Prefer ideas not yet used this week; fall back to reuse only if the
      // eligible pool is too small to fill the slot with fresh ideas.
      const chosen = [];
      for (const { idea } of scored) {
        if (usedThisRun.has(idea.id)) continue;
        chosen.push(idea);
        if (chosen.length >= candPer) break;
      }
      if (chosen.length < candPer) {
        for (const { idea } of scored) {
          if (chosen.includes(idea)) continue;
          chosen.push(idea);
          if (chosen.length >= candPer) break;
        }
      }

      chosen.forEach((idea, idx) => {
        const id = itemId(slotDate, platform, idx + 1);
        const slot_at = zonedISO(slotDate, slotTimes[platform], timezone);
        items.push(shell({ id, slot_at, platform, format, idea, cg, producedBy }));
        recency[idea.id] = slotDate;
        usedThisRun.add(idea.id);
      });
    }
  }

  return items;
}
