/**
 * @file Poster adapter (AP-203 + AP-820). Renders an item to poster media into
 * `outbox/<id>/assets/`, producing the RIGHT set of assets per ap_format:
 *
 *   - `image`    → ONE poster. World-referencing ideas render `world-drop.html`
 *                  (name/tier/line); everything else renders `quote-card.html`
 *                  (line = hook, sub = first beat, mascot rotated by variant).
 *   - `carousel` → N ordered slide posters via `carousel-slide.html` variants:
 *                  slide 1 = the hook cover, an optional world slide, hook-style
 *                  text slides for the middle beats, and a final cta slide
 *                  (text from `overlays.cta`; a price chip only when the copy
 *                  states a price). Clamped to IG's 2..10 hard limit.
 *   - `story`    → story-size `quote-card` (a code path + TODO; not in the
 *                  default format mix — see DEFAULT_FORMAT_MIX).
 *   - other      → the legacy single `quote-card` (kept as a safe fallback).
 *
 * For Instagram image/carousel assets it emits a JPEG twin (the Graph API
 * requires JPEG) and lists the JPEG in `assets[]` so the AP-401 asset-specs
 * lint (which blocks non-JPEG IG image/carousel assets) passes. The PNG stays
 * on disk as the render source. Every listed asset is `{kind:'poster'}`, in
 * slide order, with w/h + sha256.
 *
 * It drives the refactored `renderJobs`/`renderOne` from
 * marketing/04-assets/render.mjs (loaded via the configured path so the adapter
 * is CWD-independent) and injects `chromium` resolved from the repo root.
 */

import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sha256File } from '../util/hash.mjs';
import { ffmpeg } from './proc.mjs';
import { loadIdeas } from '../plan/ideas.mjs';
import { loadCatalog } from '../lint/catalog.mjs';

/** IG carousel hard limits (Graph API: 2–10 children). */
const IG_MIN_SLIDES = 2;
const IG_MAX_SLIDES = 10;
/** Mascots that exist under posters/assets/mascot/ — rotated by candidate variant. */
const IMAGE_MASCOTS = ['gift', 'album', 'book'];

let _renderMod = null;
let _ideasIndex = null;
let _catalogIndex = null;

async function loadRenderModule(config) {
  if (!_renderMod) _renderMod = await import(pathToFileURL(config.resolved.render).href);
  return _renderMod;
}

/** Resolve playwright-core's chromium from the repo root (robust to CWD). */
function loadChromium(config) {
  const require = createRequire(join(config.resolved.repoRoot, 'package.json'));
  return require('playwright-core').chromium;
}

/* ----------------------------- idea + world lookup ---------------------------- */

/** id → idea payload, from the platform's ideas.json (lazy, tolerant). */
function ideasIndex(config) {
  if (_ideasIndex) return _ideasIndex;
  _ideasIndex = {};
  try {
    for (const i of loadIdeas(config.resolved.ideas)) _ideasIndex[i.id] = i;
  } catch {
    /* no ideas file → world heuristic simply never fires */
  }
  return _ideasIndex;
}

/** Normalise a world name/slug to a match key ("The Prize Claw" → "prizeclaw"). */
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** name/slug → {slug,name,tier,isActive,description}, from the template catalog. */
function catalogIndex(config) {
  if (_catalogIndex) return _catalogIndex;
  _catalogIndex = {};
  try {
    // Catalog moved in-repo with the §3.12 kit move (2026-07-13).
    const catalogPath = config.resolved.catalog;
    for (const r of loadCatalog(catalogPath)) {
      const rec = {
        slug: r.slug,
        name: r.name,
        tier: r.tier || 'standard',
        isActive: r.isActive !== false,
        description: r.description || '',
      };
      for (const k of new Set([normKey(r.slug), normKey(r.name)].filter(Boolean))) {
        _catalogIndex[k] = rec;
      }
    }
  } catch {
    /* no catalog → world slides are simply skipped */
  }
  return _catalogIndex;
}

/**
 * Resolve `idea.worlds[0]` → an ACTIVE catalog world that also has a rendered
 * thumbnail (the world/world-drop templates load `assets/thumbs/<slug>.webp`),
 * else null. Robust to worlds given as either a display name or a slug.
 */
function resolveWorld(config, idea) {
  if (!idea || !Array.isArray(idea.worlds) || !idea.worlds[0]) return null;
  const rec = catalogIndex(config)[normKey(idea.worlds[0])];
  if (!rec || !rec.isActive) return null;
  const thumb = join(config.resolved.posters, 'assets', 'thumbs', `${rec.slug}.webp`);
  if (!existsSync(thumb)) return null;
  return rec;
}

/** First sentence of a world's catalog description, trimmed to ~90 chars. */
function worldLine(rec, fallback) {
  const first = String(rec.description || '').split(/(?<=\.)\s/)[0].trim();
  const line = first || String(fallback || '').trim();
  return line.length > 96 ? `${line.slice(0, 93).trim()}…` : line;
}

/* ----------------------------- item helpers ---------------------------- */

/** Candidate index (0-based) from the item id's `_N` suffix. */
function variantOf(item) {
  const tail = Number(String(item.id).split('_').pop());
  return Number.isFinite(tail) && tail > 0 ? tail - 1 : 0;
}

function overlayHook(item) {
  return (item.overlays && item.overlays.hook) || firstOf(item.caption) || 'Give them a whole world.';
}

function firstOf(s) {
  return String(s || '').split('\n')[0].trim();
}

function firstBeat(item) {
  const beats = (item.overlays && item.overlays.beats) || [];
  return Array.isArray(beats) && beats[0] ? String(beats[0]).trim() : '';
}

/** Does the copy state a price? (Only then may a cta slide carry a price chip.) */
function priceInCopy(item) {
  const hay = [item.caption, item.overlays && item.overlays.cta, ...((item.overlays && item.overlays.beats) || [])]
    .filter(Boolean)
    .join(' ');
  return /(from\s*)?\$\s?(15|45|250)\b/i.test(hay);
}

/** The exact-language price chip implied by the copy. */
function priceChip(item) {
  const hay = [item.caption, item.overlays && item.overlays.cta, ...((item.overlays && item.overlays.beats) || [])]
    .filter(Boolean)
    .join(' ');
  if (/\$\s?45\b/.test(hay)) return '$45 per gift';
  if (/from\s*\$\s?250\b/i.test(hay)) return 'from $250';
  return '$15 per gift';
}

/** Instagram image/carousel assets must be JPEG (Graph API / AP-401 asset-specs). */
function needsJpeg(item) {
  return item.platform === 'instagram' && ['image', 'carousel'].includes(item.format);
}

/* ------------------------------- job planning (pure) ------------------------------- */

/**
 * Plan the ordered carousel slide jobs for an item. Pure + deterministic so it
 * is unit-testable without a browser. Order:
 *   1. hook cover (overlays.beats[0], else the hook)
 *   2. world slide (only when `world` is provided)
 *   3. hook-style text slides for the middle beats (beats[1 … n-2])
 *   4. cta slide (text = overlays.cta; price chip only when the copy states a price)
 * Clamped to IG's {@link IG_MIN_SLIDES}..{@link IG_MAX_SLIDES}; over-long decks
 * drop trailing middle slides (never the cover or cta) and record a warning.
 *
 * @returns {{ jobs: Object[], warnings: string[] }}
 */
export function planCarouselJobs(item, { world = null } = {}) {
  const beats = Array.isArray(item.overlays && item.overlays.beats)
    ? item.overlays.beats.map((b) => String(b || '').trim()).filter(Boolean)
    : [];
  const ctaText = (item.overlays && item.overlays.cta) || 'getforevermore.co';

  /** @type {Object[]} */
  const specs = [];
  specs.push({ slide: 'hook', line: beats[0] || overlayHook(item), hl: '' });
  if (world) {
    specs.push({ slide: 'world', world: world.slug, name: world.name, tier: world.tier, line: worldLine(world, beats[1]) });
  }
  // Middle body = beats between the cover (index 0) and the trailing cta line
  // (last index, which the cta slide represents).
  const middle = beats.slice(1, Math.max(1, beats.length - 1));
  for (const b of middle) specs.push({ slide: 'hook', line: b, hl: '' });
  const cta = { slide: 'cta', line: ctaText, cta: 'open their world' };
  if (priceInCopy(item)) cta.pricechip = priceChip(item);
  specs.push(cta);

  const warnings = [];
  let ordered = specs;
  if (specs.length > IG_MAX_SLIDES) {
    // Keep the cover + everything up to the limit, always preserving the cta.
    const ctaSpec = specs[specs.length - 1];
    ordered = [...specs.slice(0, IG_MAX_SLIDES - 1), ctaSpec];
    warnings.push(
      `carousel ${item.id}: ${specs.length} slides exceeds the IG limit of ${IG_MAX_SLIDES}; trimmed to ${IG_MAX_SLIDES}`,
    );
  }
  // (A hook + cta always yields >= IG_MIN_SLIDES, so no min-pad is needed.)

  const n = ordered.length;
  const jobs = ordered.map((spec, i) => ({
    out: `${item.id}-s${i + 1}.png`,
    page: 'carousel-slide.html',
    size: 'feed',
    params: { ...spec, n: `${i + 1}/${n}` },
  }));
  return { jobs, warnings };
}

/**
 * Plan the single image job for an item: a world-drop poster when the idea
 * references an active world, else a quote-card with the hook as the line.
 * Pure + deterministic. @returns {Object} a render job.
 */
export function planImageJob(item, { world = null } = {}) {
  const out = `${item.id}.png`;
  if (world) {
    return {
      out,
      page: 'world-drop.html',
      size: 'feed',
      params: { world: world.slug, name: world.name, tier: world.tier, line: worldLine(world, firstBeat(item)) },
    };
  }
  const mascot = IMAGE_MASCOTS[variantOf(item) % IMAGE_MASCOTS.length];
  return {
    out,
    page: 'quote-card.html',
    size: 'feed',
    params: { line: overlayHook(item), hl: '', mascot, sub: firstBeat(item) },
  };
}

/* ------------------------------- rendering ------------------------------- */

/** Render every job into `outDir` with one Brave launch. */
async function renderJobsInto(config, outDir, jobs) {
  const { renderJobs, SIZES } = await loadRenderModule(config);
  const chromium = loadChromium(config);
  await renderJobs(jobs, { chromium, outDir, quiet: true, brave: config.brave });
  return SIZES;
}

/**
 * Turn rendered PNGs into ordered AssetRefs, emitting a JPEG twin for Instagram
 * image/carousel assets and listing the platform-correct file. Order preserved.
 */
async function pngsToAssets(config, item, outDir, pngNames, [w, h]) {
  /** @type {import('../types.mjs').AssetRef[]} */
  const assets = [];
  for (const pngName of pngNames) {
    const pngPath = join(outDir, pngName);
    if (needsJpeg(item)) {
      const jpgName = pngName.replace(/\.png$/, '.jpg');
      const jpgPath = join(outDir, jpgName);
      ffmpeg(config, ['-y', '-i', pngPath, '-q:v', '3', jpgPath]);
      assets.push({ kind: 'poster', path: `assets/${jpgName}`, w, h, sha256: await sha256File(jpgPath) });
    } else {
      assets.push({ kind: 'poster', path: `assets/${pngName}`, w, h, sha256: await sha256File(pngPath) });
    }
  }
  return assets;
}

async function renderCarousel(item, { config, outDir, log }) {
  const idea = ideasIndex(config)[item.idea_id];
  const world = resolveWorld(config, idea);
  const { jobs, warnings } = planCarouselJobs(item, { world });
  for (const w of warnings) {
    if (typeof log === 'function') await log({ event: 'render.warn', id: item.id, warn: w });
    else console.warn(`[poster] ${w}`);
  }
  const SIZES = await renderJobsInto(config, outDir, jobs);
  return pngsToAssets(config, item, outDir, jobs.map((j) => j.out), SIZES.feed || [1080, 1350]);
}

async function renderImage(item, { config, outDir }) {
  const idea = ideasIndex(config)[item.idea_id];
  const world = resolveWorld(config, idea);
  const job = planImageJob(item, { world });
  const SIZES = await renderJobsInto(config, outDir, [job]);
  return pngsToAssets(config, item, outDir, [job.out], SIZES.feed || [1080, 1350]);
}

async function renderStory(item, { config, outDir }) {
  // TODO(AP-820): stories need manual sticker + link/CTA placement, so `story`
  // is not in the default format mix. This path renders a story-size quote-card
  // so the format is producible when an operator opts a slot into it by hand.
  const job = {
    out: `${item.id}.png`,
    page: 'quote-card.html',
    size: 'story',
    params: { line: overlayHook(item), hl: '', mascot: IMAGE_MASCOTS[variantOf(item) % IMAGE_MASCOTS.length], sub: firstBeat(item) },
  };
  const SIZES = await renderJobsInto(config, outDir, [job]);
  return pngsToAssets(config, item, outDir, [job.out], SIZES.story || [1080, 1920]);
}

/** Legacy single quote-card (pre-AP-820 shape) — a safe fallback for any other format. */
async function renderSingle(item, { config, outDir }) {
  const job = {
    out: `${item.id}.png`,
    page: 'quote-card.html',
    size: item.format === 'story' ? 'story' : 'feed',
    params: { line: overlayHook(item), hl: '', mascot: 'gift', sub: '' },
  };
  const SIZES = await renderJobsInto(config, outDir, [job]);
  const size = item.format === 'story' ? SIZES.story : SIZES.feed;
  return pngsToAssets(config, item, outDir, [job.out], size || [1080, 1350]);
}

/**
 * @param {import('../types.mjs').ContentItem} item
 * @param {{config:Object, outDir:string, log?:Function}} opts
 * @returns {Promise<import('../types.mjs').AssetRef[]>}
 */
export async function renderPoster(item, opts) {
  await fsp.mkdir(opts.outDir, { recursive: true });
  switch (item.format) {
    case 'carousel':
      return renderCarousel(item, opts);
    case 'image':
      return renderImage(item, opts);
    case 'story':
      return renderStory(item, opts);
    default:
      return renderSingle(item, opts);
  }
}
