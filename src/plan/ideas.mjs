/**
 * @file Idea loading + the mapping from ideas.json's free-form platform/format
 * onto the strict PRD §5 enums.
 *
 * ideas.json `platform` values observed: both | tiktok | reels | ig-carousel |
 * ig-story. The PRD content-item enums are platform∈{instagram,tiktok} and
 * format∈{reel,carousel,image,story,tiktok_video}. The mapping below is the
 * deterministic v0 contract (documented in README + surfaced to Fable for PRD
 * reconciliation).
 */

import { readFileSync } from 'node:fs';

/** Load and parse ideas.json. @param {string} path @returns {Object[]} */
export function loadIdeas(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`ideas file ${path} is not a JSON array`);
  return raw;
}

/** ideas.json platforms that can fill an Instagram slot. */
const IG_PLATFORMS = new Set(['both', 'reels', 'ig-carousel', 'ig-story']);
/** ideas.json platforms that can fill a TikTok slot. */
const TT_PLATFORMS = new Set(['both', 'tiktok']);

/**
 * Is this idea eligible for a slot on `platform`?
 * @param {Object} idea @param {'instagram'|'tiktok'} platform
 */
export function ideaEligibleFor(idea, platform) {
  const p = idea && idea.platform;
  if (platform === 'instagram') return IG_PLATFORMS.has(p);
  if (platform === 'tiktok') return TT_PLATFORMS.has(p);
  return false;
}

/**
 * Map an idea to the concrete ap_format for a given slot platform.
 * TikTok → tiktok_video. Instagram → carousel/story if the idea declares that
 * IG sub-format, else reel (the default vertical video).
 *
 * NOTE (AP-820): the PLANNER no longer derives a slot's format from the idea —
 * it reads the format from the config `format_mix` pattern (see
 * {@link DEFAULT_FORMAT_MIX} + `formatPreferenceRank`) so a week gets planned
 * variety instead of every IG slot collapsing to `reel` (the 137-idea DB is
 * dominated by `both`/`tiktok` platforms, which this used to map to `reel`).
 * This helper is kept for back-compat callers + the mapping contract test.
 * @param {Object} idea @param {'instagram'|'tiktok'} platform
 * @returns {'reel'|'carousel'|'image'|'story'|'tiktok_video'}
 */
export function formatFor(idea, platform) {
  if (platform === 'tiktok') return 'tiktok_video';
  if (idea.platform === 'ig-carousel') return 'carousel';
  if (idea.platform === 'ig-story') return 'story';
  return 'reel';
}

/**
 * Default per-platform, per-ISO-weekday format pattern (AP-820). Keyed by
 * ISO weekday (1=Mon … 7=Sun). The planner reads a slot's format from HERE,
 * not from the idea, so Instagram gets a deliberate mix of reels, images, and
 * multi-slide carousels across the week.
 *
 * `'story'` IS a legal format value but is intentionally ABSENT from these
 * defaults: stories need manual sticker + swipe-up/link-CTA placement the
 * pipeline can't yet author, so we never auto-schedule one. Add it to a
 * platform's map in `autopilot.config.json` only once that's handled by hand.
 * TikTok is always `tiktok_video` (its only non-IG format).
 */
export const DEFAULT_FORMAT_MIX = Object.freeze({
  instagram: Object.freeze({ 1: 'reel', 2: 'carousel', 3: 'reel', 4: 'image', 5: 'carousel', 6: 'reel', 7: 'reel' }),
  tiktok: Object.freeze({ 1: 'tiktok_video', 2: 'tiktok_video', 3: 'tiktok_video', 4: 'tiktok_video', 5: 'tiktok_video', 6: 'tiktok_video', 7: 'tiktok_video' }),
});

/**
 * The format a slot on `platform` should carry on ISO `weekday` (1..7), per the
 * `formatMix` pattern. Falls back to the platform's natural default when a
 * platform or weekday is unconfigured, so a partial override never yields an
 * undefined format.
 * @param {'instagram'|'tiktok'} platform
 * @param {number} weekday ISO weekday 1..7
 * @param {Object} [formatMix]
 * @returns {'reel'|'carousel'|'image'|'story'|'tiktok_video'}
 */
export function formatForSlot(platform, weekday, formatMix = DEFAULT_FORMAT_MIX) {
  const map = (formatMix && formatMix[platform]) || DEFAULT_FORMAT_MIX[platform] || {};
  // Config-file keys are strings ("1".."7"); numeric index coerces to match.
  const f = map[weekday] != null ? map[weekday] : map[String(weekday)];
  if (f) return f;
  return platform === 'tiktok' ? 'tiktok_video' : 'reel';
}

/**
 * Preference tier (0 = most preferred) of an idea for a target ap_format, used
 * as the PRIMARY sort key in slot idea-selection so a carousel slot prefers a
 * purpose-built `ig-carousel` idea, an image slot prefers a low-effort
 * `both`/`reels` idea, etc. — while still filling from wider tiers when the
 * preferred pool is too small. Lower rank wins; ties fall through to the
 * existing score × recency ordering, so selection stays deterministic.
 * @param {Object} idea @param {string} format
 * @returns {number}
 */
export function formatPreferenceRank(idea, format) {
  const p = idea && idea.platform;
  const lowEffort = idea && idea.effort === 'S';
  switch (format) {
    case 'carousel':
      // Prefer ideas authored AS carousels, then the flexible `both`.
      if (p === 'ig-carousel') return 0;
      if (p === 'both') return 1;
      return 2;
    case 'image':
      // A static image is a quick, low-effort statement — prefer `both`/`reels`
      // ideas marked S-effort, then any `both`/`reels`.
      if ((p === 'both' || p === 'reels') && lowEffort) return 0;
      if (p === 'both' || p === 'reels') return 1;
      return 2;
    case 'story':
      if (p === 'ig-story') return 0;
      if (p === 'both') return 1;
      return 2;
    case 'reel':
      // As before: vertical-video-native ideas lead, IG sub-format ideas trail.
      if (p === 'reels' || p === 'both') return 0;
      return 1;
    case 'tiktok_video':
      return 0; // the TikTok pool is already filtered to eligible ideas
    default:
      return 0;
  }
}

/** Keywords that flag an idea as `sensitive` risk (never auto-post; PRD §5). */
const SENSITIVE_RE = /\b(memorial|memoriam|grief|grieving|loss|passed away|funeral|kids?|child|children|baby|newborn)\b/i;

/**
 * v0 risk heuristic: `sensitive` when title/occasions/worlds mention
 * memorial/kids topics, else `standard`. AP-401 + owner refine this.
 * @param {Object} idea @returns {'evergreen'|'standard'|'sensitive'}
 */
export function riskFor(idea) {
  const hay = [idea.title, ...(idea.occasions || []), ...(idea.worlds || []), idea.notes]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE_RE.test(hay) ? 'sensitive' : 'standard';
}

/**
 * Base desirability score for planning. Prefers the pre-computed ideas.json
 * `score`; falls back to impact×confidence×10 so the fixture never divides by
 * an undefined score.
 * @param {Object} idea @returns {number}
 */
export function baseScore(idea) {
  if (typeof idea.score === 'number') return idea.score;
  const impact = Number(idea.impact) || 1;
  const confidence = Number(idea.confidence) || 1;
  return impact * confidence * 10;
}
