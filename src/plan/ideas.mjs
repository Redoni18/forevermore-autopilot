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
 * @param {Object} idea @param {'instagram'|'tiktok'} platform
 * @returns {'reel'|'carousel'|'image'|'story'|'tiktok_video'}
 */
export function formatFor(idea, platform) {
  if (platform === 'tiktok') return 'tiktok_video';
  if (idea.platform === 'ig-carousel') return 'carousel';
  if (idea.platform === 'ig-story') return 'story';
  return 'reel';
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
