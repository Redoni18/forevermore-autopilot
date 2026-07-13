/**
 * @file Video adapter (AP-203 + AP-832). Renders a vertical reel into
 * `outbox/<id>/assets/final.mp4`, choosing one of two bodies by whether the
 * item's world has real captured footage in the library (AP-204/AP-832):
 *
 *   - FOOTAGE path — the item's world resolves to a slug present in
 *     `library/manifest.json`. The master clip is staged into the studio's
 *     `public/__autopilot-clips/<slug>.mp4` and the `OverlayReel` composition
 *     renders REAL world footage with the item's overlays (hook/beats/cta)
 *     laid over it. This is what makes a reel "show the template with real
 *     images / the actual flow" instead of text-only cards.
 *   - HOOK path — no footage for the world: the original kinetic `HookCard`
 *     (prop-driven) renders unchanged. This branch is byte-for-byte the AP-203
 *     behaviour.
 *
 * Both bodies concatenate the shared `EndCard` on the tail via the ffmpeg
 * concat demuxer with `-c copy` (stream copy, NO re-encode). That is valid
 * because BOTH clips come out of the SAME Remotion CLI at identical
 * codec/timebase/dimensions (H.264, 30fps, 1080×1920) — the OverlayReel's
 * OffthreadVideo source is recomposited, so its OUTPUT encode settings match
 * EndCard's exactly. If the studio's render settings ever diverge between
 * comps, drop `-c copy` and re-encode instead.
 *
 * Heavy (spawns Chrome-headless-shell + ffmpeg). The unit suite injects a stub
 * `proc` (opts.proc) to assert routing + props without launching anything.
 */

import { promises as fsp, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../util/hash.mjs';
import * as realProc from './proc.mjs';
import { loadIdeas } from '../plan/ideas.mjs';
import { loadCatalog } from '../lint/catalog.mjs';

// Studio composition durations (frames) at 30fps — see 05-video-studio/src/Root.tsx.
const HOOK_FRAMES = 165;
const END_FRAMES = 120;
const FPS = 30;

/** OverlayReel length is clip-capped into this window (kept in sync with Root.tsx). */
const MAX_REEL_S = 28;
const MIN_REEL_S = 6;
/** Brand domain shown in the OverlayReel url pill. */
const BRAND_URL = 'getforevermore.co';
/** Gitignored dir (created at render time) under <videoStudio>/public/ that staticFile() reads. */
const CLIP_DIR = '__autopilot-clips';

/* ------------------------- world + footage resolution ------------------------- *
 * Mirrors poster.mjs's catalog approach (idea.worlds[0] → catalog slug via
 * src/lint/catalog.mjs), but the footage gate is `library/manifest.json`, not a
 * rendered thumbnail. Caches hang off the config object (WeakMap) so production
 * reuse is cheap while tests with per-fixture configs stay hermetic.
 * ------------------------------------------------------------------------------ */

const _cache = new WeakMap();
function caches(config) {
  let c = _cache.get(config);
  if (!c) {
    c = {};
    _cache.set(config, c);
  }
  return c;
}

/** Normalise a world name/slug to a match key ("The Blockheart Mine" → "blockheartmine"). */
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** id → idea payload, from the platform's ideas.json (lazy, tolerant). */
function ideasIndex(config) {
  const c = caches(config);
  if (c.ideas) return c.ideas;
  c.ideas = {};
  try {
    for (const i of loadIdeas(config.resolved.ideas)) c.ideas[i.id] = i;
  } catch {
    /* no ideas file → world heuristic simply never fires */
  }
  return c.ideas;
}

/** normKey(name|slug) → {slug,name,tier,isActive}, from the template catalog. */
function catalogIndex(config) {
  const c = caches(config);
  if (c.catalog) return c.catalog;
  c.catalog = {};
  try {
    const catalogPath = join(config.resolved.repoRoot, 'marketing', '_research', 'template-catalog.md');
    for (const r of loadCatalog(catalogPath)) {
      const rec = { slug: r.slug, name: r.name, tier: r.tier || 'standard', isActive: r.isActive !== false };
      for (const k of new Set([normKey(r.slug), normKey(r.name)].filter(Boolean))) c.catalog[k] = rec;
    }
  } catch {
    /* no catalog → footage routing simply never fires */
  }
  return c.catalog;
}

/** slug → { file, dur_s, ... }, from library/manifest.json (lazy, tolerant). */
function manifest(config) {
  const c = caches(config);
  if (c.manifest) return c.manifest;
  c.manifest = {};
  try {
    const raw = JSON.parse(readFileSync(join(config.resolved.library, 'manifest.json'), 'utf8'));
    if (raw && typeof raw === 'object') c.manifest = raw;
  } catch {
    /* no manifest → every item takes the hook path */
  }
  return c.manifest;
}

/**
 * Resolve the item's world → an ACTIVE catalog rec, robust to worlds given as a
 * display name or a slug. Source order matches poster.mjs: the idea's
 * `worlds[0]`, then an explicit `overlays.world` fallback for off-list items.
 * @returns {{slug:string,name:string,tier:string,isActive:boolean}|null}
 */
export function resolveVideoWorld(config, item) {
  const idea = ideasIndex(config)[item.idea_id];
  const w = (idea && Array.isArray(idea.worlds) && idea.worlds[0]) || (item.overlays && item.overlays.world) || null;
  if (!w) return null;
  const rec = catalogIndex(config)[normKey(w)];
  return rec && rec.isActive ? rec : null;
}

/**
 * Footage descriptor for a resolved world, or null when the library has none.
 * @returns {{slug:string,file:string,dur_s?:number}|null}
 */
export function footageFor(config, world) {
  if (!world) return null;
  const man = manifest(config);
  const entry = man[world.slug] || man[normKey(world.slug)];
  return entry && entry.file ? { slug: world.slug, ...entry } : null;
}

/* ------------------------------- prop planning (pure) ------------------------------- */

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** Clamp a clip's seconds into the reel window; a bad/absent value falls back to the cap. */
export function reelSeconds(clipDurS) {
  const d = Number(clipDurS);
  if (!Number.isFinite(d) || d <= 0) return MAX_REEL_S;
  return Math.max(MIN_REEL_S, Math.min(MAX_REEL_S, Math.round(d)));
}

/** HookCard props from the item's copy (unchanged from AP-203). */
export function hookProps(item) {
  const line = (item.overlays && item.overlays.hook) || firstLine(item.caption) || "Store-bought says 'I remembered.'";
  return {
    kicker: (item.overlays && item.overlays.kicker) || 'made, not generated',
    line,
    hl: (item.overlays && item.overlays.hl) || '',
    mascot: (item.overlays && item.overlays.mascot) || 'gift',
  };
}

/** OverlayReel props — the item's overlays passed straight through, plus clip + length. */
export function overlayProps(item, { slug, durS }) {
  const o = item.overlays || {};
  return {
    clip: `${CLIP_DIR}/${slug}.mp4`,
    overlays: {
      hook: o.hook || firstLine(item.caption) || '',
      beats: Array.isArray(o.beats) ? o.beats.map((b) => String(b || '').trim()).filter(Boolean) : [],
      cta: o.cta || '',
    },
    url: BRAND_URL,
    dur_s: durS,
  };
}

/**
 * Pure routing decision: footage reel when `footage` is present, else the hook
 * reel. Returns the chosen comp's render props so tests can assert both the
 * decision and the exact props without spawning Remotion.
 * @param {import('../types.mjs').ContentItem} item
 * @param {{footage?: {slug:string,file:string,dur_s?:number}|null}} [ctx]
 */
export function planVideo(item, { footage = null } = {}) {
  if (footage && footage.file) {
    const durS = reelSeconds(footage.dur_s);
    return {
      route: 'footage',
      slug: footage.slug,
      clipFile: footage.file,
      overlaySeconds: durS,
      props: overlayProps(item, { slug: footage.slug, durS }),
    };
  }
  return { route: 'hook', props: hookProps(item) };
}

/* ------------------------------- rendering ------------------------------- */

/** A single final.mp4 AssetRef. */
function finalAsset(durS, sha256) {
  return { kind: 'video', path: 'assets/final.mp4', w: 1080, h: 1920, dur_s: durS, sha256 };
}

/**
 * Stage the master clip into <videoStudio>/public/__autopilot-clips/<slug>.mp4
 * so staticFile() can read it. The dir is created here and kept OUT of the
 * platform repo's git (its own `.gitignore` ignores everything); stale mp4s are
 * cleared first so it only ever holds the current render's clip.
 */
async function stageClip(config, slug, clipFile) {
  const src = join(config.resolved.library, clipFile);
  const destDir = join(config.resolved.videoStudio, 'public', CLIP_DIR);
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(join(destDir, '.gitignore'), '*\n', 'utf8').catch(() => {});
  for (const f of await fsp.readdir(destDir).catch(() => [])) {
    if (f.endsWith('.mp4')) await fsp.rm(join(destDir, f), { force: true }).catch(() => {});
  }
  await fsp.copyFile(src, join(destDir, `${slug}.mp4`));
  return join(destDir, `${slug}.mp4`);
}

/** FOOTAGE body: OverlayReel(real clip + overlays) → EndCard → stream-copy concat. */
async function renderFootageReel(item, plan, { config, studio, outDir, P }) {
  const overlayMp4 = join(outDir, 'overlay.mp4');
  const endMp4 = join(outDir, 'end.mp4');
  const finalMp4 = join(outDir, 'final.mp4');
  const propsFile = join(outDir, 'overlay.props.json');
  const listFile = join(outDir, 'concat.txt');
  const bin = P.remotionBin(config);

  await stageClip(config, plan.slug, plan.clipFile);
  await fsp.writeFile(propsFile, JSON.stringify(plan.props), 'utf8');

  P.run(bin, ['render', 'src/index.ts', 'OverlayReel', overlayMp4, `--props=${propsFile}`], { cwd: studio });
  P.run(bin, ['render', 'src/index.ts', 'EndCard', endMp4], { cwd: studio });

  const list = `file '${overlayMp4}'\nfile '${endMp4}'\n`;
  await fsp.writeFile(listFile, list, 'utf8');
  P.ffmpeg(config, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalMp4]);

  const durS = (Math.round(plan.overlaySeconds * FPS) + END_FRAMES) / FPS;
  return [finalAsset(durS, await sha256File(finalMp4))];
}

/** HOOK body: the original AP-203 kinetic HookCard → EndCard → stream-copy concat. */
async function renderHookReel(item, plan, { config, studio, outDir, P }) {
  const hookMp4 = join(outDir, 'hook.mp4');
  const endMp4 = join(outDir, 'end.mp4');
  const finalMp4 = join(outDir, 'final.mp4');
  const propsFile = join(outDir, 'hook.props.json');
  const listFile = join(outDir, 'concat.txt');
  const bin = P.remotionBin(config);

  await fsp.writeFile(propsFile, JSON.stringify(plan.props), 'utf8');

  // 1) HookCard with props, 2) EndCard. cwd = studio so `src/index.ts` resolves.
  P.run(bin, ['render', 'src/index.ts', 'HookCard', hookMp4, `--props=${propsFile}`], { cwd: studio });
  P.run(bin, ['render', 'src/index.ts', 'EndCard', endMp4], { cwd: studio });

  // 3) stream-copy concat (no re-encode). Absolute paths + -safe 0.
  const list = `file '${hookMp4}'\nfile '${endMp4}'\n`;
  await fsp.writeFile(listFile, list, 'utf8');
  P.ffmpeg(config, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalMp4]);

  const durS = (HOOK_FRAMES + END_FRAMES) / FPS; // 9.5s (fixed comp durations)
  return [finalAsset(durS, await sha256File(finalMp4))];
}

/**
 * @param {import('../types.mjs').ContentItem} item
 * @param {{config:Object, outDir:string, log?:Function, proc?:Object}} opts
 *   `proc` (defaults to the real subprocess helpers) is injected by tests.
 * @returns {Promise<import('../types.mjs').AssetRef[]>}
 */
export async function renderVideo(item, opts) {
  const { config, outDir, log } = opts;
  const P = opts.proc || realProc;
  await fsp.mkdir(outDir, { recursive: true });
  const studio = config.resolved.videoStudio;

  const world = resolveVideoWorld(config, item);
  const footage = footageFor(config, world);
  const plan = planVideo(item, { footage });

  if (typeof log === 'function') {
    await log({ event: 'video.route', id: item.id, route: plan.route, world: world ? world.slug : null });
  }

  return plan.route === 'footage'
    ? renderFootageReel(item, plan, { config, studio, outDir, P })
    : renderHookReel(item, plan, { config, studio, outDir, P });
}
