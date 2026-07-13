/**
 * @file Video adapter (AP-203 + AP-835/836). Renders a vertical reel into
 * `outbox/<id>/assets/final.mp4`. Every reel is Hook → [product act] → End;
 * the middle act is chosen by how well the item's world can be SHOWN:
 *
 *   - SHOWCASE — the world resolves to an active catalog entry with BOTH
 *     captured footage in `library/manifest.json` AND a staged poster in the
 *     studio's `public/template-thumbs/`: ShowcaseCard pops the poster
 *     ("their world") and a real in-experience still ("inside it"). The still
 *     is ffmpeg-extracted from the library master (`still_s` in the manifest
 *     entry overrides the default 60% mark).
 *   - SHELF — no footage for the world (or no world at all) but the studio
 *     has staged posters: WorldShelfCard pops a card grid of real world
 *     posters — the owner's "show a card layout of all the worlds" note. The
 *     item's own world leads the shelf when it has a poster.
 *   - HOOK — no posters staged at all (bare checkout): the original AP-203
 *     kinetic HookCard → EndCard, byte-for-byte.
 *
 * All parts concatenate via the ffmpeg concat demuxer with `-c copy` (stream
 * copy, NO re-encode). That is valid because every clip comes out of the SAME
 * Remotion CLI at identical codec/timebase/dimensions (H.264, 30fps,
 * 1080×1920). If the studio's render settings ever diverge between comps,
 * drop `-c copy` and re-encode instead.
 *
 * Heavy (spawns Chrome-headless-shell + ffmpeg). The unit suite injects a stub
 * `proc` (opts.proc) to assert routing + props without launching anything.
 */

import { promises as fsp, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../util/hash.mjs';
import * as realProc from './proc.mjs';
import { loadIdeas } from '../plan/ideas.mjs';
import { loadCatalog } from '../lint/catalog.mjs';

// Studio composition durations (frames) at 30fps — see 05-video-studio/src/Root.tsx.
const HOOK_FRAMES = 165;
const MIDDLE_FRAMES = 150; // ShowcaseCard and WorldShelfCard are both 150
const END_FRAMES = 120;
const FPS = 30;

/**
 * Explicit bundle-server port for `remotion render`. Remotion's free-port
 * probe checks IPv4 only; a dev server squatting [::1]:3000 (IPv6) passes the
 * probe and then resets Chrome's `localhost` connection (v4/v6 split —
 * ERR_CONNECTION_RESET, seen live 2026-07-13). A high pid-spread port keeps
 * renders clear of the 3000-4600 dev range; sequential renders in one adapter
 * call safely reuse it (each CLI run closes its server on exit).
 */
const RENDER_PORT = 34500 + (process.pid % 1000);

/** Gitignored dir (created at render time) under <videoStudio>/public/ that staticFile() reads. */
const CLIP_DIR = '__autopilot-clips';
/** Poster thumbnails staged in the studio (all 40+ worlds, committed with the kit). */
const THUMBS_DIR = 'template-thumbs';
/** A shelf needs at least this many posters to read as a shelf. */
const MIN_SHELF = 4;
/** Shelf leads: recognisable, high-contrast worlds first; the rest fill alphabetically. */
const SHELF_CURATION = [
  'gone-fishing', 'love-letters', 'prize-claw', 'blockheart-mine', 'passport',
  'pocket-pal', 'memory-garden', 'starlit-letter', 'keepsake-desk',
];

/* ------------------------- world + asset resolution ------------------------- *
 * Mirrors poster.mjs's catalog approach (idea.worlds[0] → catalog slug via
 * src/lint/catalog.mjs). The showcase gate is manifest footage + a staged
 * thumbnail. Caches hang off the config object (WeakMap) so production reuse
 * is cheap while tests with per-fixture configs stay hermetic.
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
    // Catalog moved in-repo with the §3.12 kit move (2026-07-13).
    const catalogPath = config.resolved.catalog;
    for (const r of loadCatalog(catalogPath)) {
      const rec = { slug: r.slug, name: r.name, tier: r.tier || 'standard', isActive: r.isActive !== false };
      for (const k of new Set([normKey(r.slug), normKey(r.name)].filter(Boolean))) c.catalog[k] = rec;
    }
  } catch {
    /* no catalog → showcase routing simply never fires */
  }
  return c.catalog;
}

/** slug → { file, dur_s, still_s?, ... }, from library/manifest.json (lazy, tolerant). */
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
 * @returns {{slug:string,file:string,dur_s?:number,still_s?:number}|null}
 */
export function footageFor(config, world) {
  if (!world) return null;
  const man = manifest(config);
  const entry = man[world.slug] || man[normKey(world.slug)];
  return entry && entry.file ? { slug: world.slug, ...entry } : null;
}

/**
 * staticFile-relative thumbnail path for a resolved world, or null when the
 * studio has no staged poster for it.
 */
export function thumbFor(config, world) {
  if (!world) return null;
  const rel = `${THUMBS_DIR}/${world.slug}.webp`;
  return existsSync(join(config.resolved.videoStudio, 'public', rel)) ? rel : null;
}

/**
 * The shelf: up to 9 staged posters, deterministic order — the item's own
 * world first (when it has a poster), then the curated leads, then the rest
 * alphabetically. Empty array when the studio has no posters staged.
 * @returns {string[]} staticFile-relative paths
 */
export function shelfThumbs(config, world) {
  let slugs;
  try {
    slugs = readdirSync(join(config.resolved.videoStudio, 'public', THUMBS_DIR))
      .filter((f) => f.endsWith('.webp'))
      .map((f) => f.slice(0, -'.webp'.length))
      .sort();
  } catch {
    return []; // no posters staged → shelf never fires
  }
  const have = new Set(slugs);
  const ordered = [];
  const push = (slug) => {
    if (have.has(slug) && !ordered.includes(slug)) ordered.push(slug);
  };
  if (world) push(world.slug);
  for (const slug of SHELF_CURATION) push(slug);
  for (const slug of slugs) push(slug);
  return ordered.slice(0, 9).map((slug) => `${THUMBS_DIR}/${slug}.webp`);
}

/* ------------------------------- prop planning (pure) ------------------------------- */

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/**
 * The timestamp (seconds) to pull the in-experience still from. An explicit
 * `still_s` in the manifest entry wins; otherwise 60% into the clip — past the
 * opening ritual, into the world's "meat". Clamped a second short of the end.
 */
export function stillSeconds(footage) {
  const dur = Number(footage && footage.dur_s);
  const explicit = Number(footage && footage.still_s);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Number.isFinite(dur) && dur > 1 ? Math.min(explicit, Math.floor(dur - 1)) : explicit;
  }
  if (!Number.isFinite(dur) || dur <= 0) return 15;
  return Math.max(1, Math.round(dur * 0.6));
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

/** ShowcaseCard props — the world's name, its poster art, and the still to come. */
export function showcaseProps(world, thumb, slug) {
  return {
    world: world.name || world.slug,
    thumb,
    still: `${CLIP_DIR}/${slug}-still.jpg`,
  };
}

/**
 * Pure routing decision: showcase when the world has BOTH footage (for the
 * still) and a staged thumbnail; else the world-shelf when enough posters are
 * staged; else the bare hook reel. Returns each comp's render props so tests
 * can assert the decision and the exact props without spawning Remotion.
 * @param {import('../types.mjs').ContentItem} item
 * @param {{world?:Object|null, footage?:Object|null, thumb?:string|null, thumbs?:string[]}} [ctx]
 */
export function planVideo(item, { world = null, footage = null, thumb = null, thumbs = [] } = {}) {
  if (world && footage && footage.file && thumb) {
    return {
      route: 'showcase',
      middleComp: 'ShowcaseCard',
      middleProps: showcaseProps(world, thumb, world.slug),
      slug: world.slug,
      clipFile: footage.file,
      stillAt: stillSeconds(footage),
      hookProps: hookProps(item),
    };
  }
  if (Array.isArray(thumbs) && thumbs.length >= MIN_SHELF) {
    return {
      route: 'shelf',
      middleComp: 'WorldShelfCard',
      middleProps: { kicker: 'pick their world', thumbs: thumbs.slice(0, 9) },
      hookProps: hookProps(item),
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
 * Extract the in-experience still from the library master into
 * <videoStudio>/public/__autopilot-clips/<slug>-still.jpg so staticFile() can
 * read it. The dir is created here and kept OUT of the platform repo's git
 * (its own `.gitignore` ignores everything); stale artefacts are cleared
 * first so it only ever holds the current render's inputs.
 */
async function stageStill(config, plan, P) {
  const src = join(config.resolved.library, plan.clipFile);
  const destDir = join(config.resolved.videoStudio, 'public', CLIP_DIR);
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(join(destDir, '.gitignore'), '*\n', 'utf8').catch(() => {});
  for (const f of await fsp.readdir(destDir).catch(() => [])) {
    if (f.endsWith('.mp4') || f.endsWith('.jpg')) await fsp.rm(join(destDir, f), { force: true }).catch(() => {});
  }
  const dest = join(destDir, `${plan.slug}-still.jpg`);
  P.ffmpeg(config, ['-y', '-ss', String(plan.stillAt), '-i', src, '-frames:v', '1', '-q:v', '2', dest]);
  return dest;
}

/** SHOWCASE/SHELF body: HookCard → middle product act → EndCard, stream-copy concat. */
async function renderMiddleReel(item, plan, { config, studio, outDir, P }) {
  const hookMp4 = join(outDir, 'hook.mp4');
  const middleMp4 = join(outDir, 'middle.mp4');
  const endMp4 = join(outDir, 'end.mp4');
  const finalMp4 = join(outDir, 'final.mp4');
  const hookPropsFile = join(outDir, 'hook.props.json');
  const middlePropsFile = join(outDir, 'middle.props.json');
  const listFile = join(outDir, 'concat.txt');
  const bin = P.remotionBin(config);

  if (plan.route === 'showcase') await stageStill(config, plan, P);
  await fsp.writeFile(hookPropsFile, JSON.stringify(plan.hookProps), 'utf8');
  await fsp.writeFile(middlePropsFile, JSON.stringify(plan.middleProps), 'utf8');

  P.run(bin, ['render', 'src/index.ts', 'HookCard', hookMp4, `--props=${hookPropsFile}`, `--port=${RENDER_PORT}`], { cwd: studio });
  P.run(bin, ['render', 'src/index.ts', plan.middleComp, middleMp4, `--props=${middlePropsFile}`, `--port=${RENDER_PORT}`], { cwd: studio });
  P.run(bin, ['render', 'src/index.ts', 'EndCard', endMp4, `--port=${RENDER_PORT}`], { cwd: studio });

  const list = `file '${hookMp4}'\nfile '${middleMp4}'\nfile '${endMp4}'\n`;
  await fsp.writeFile(listFile, list, 'utf8');
  P.ffmpeg(config, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalMp4]);

  const durS = (HOOK_FRAMES + MIDDLE_FRAMES + END_FRAMES) / FPS; // 14.5s (fixed comp durations)
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
  P.run(bin, ['render', 'src/index.ts', 'HookCard', hookMp4, `--props=${propsFile}`, `--port=${RENDER_PORT}`], { cwd: studio });
  P.run(bin, ['render', 'src/index.ts', 'EndCard', endMp4, `--port=${RENDER_PORT}`], { cwd: studio });

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
  const thumb = thumbFor(config, world);
  const thumbs = shelfThumbs(config, world);
  const plan = planVideo(item, { world, footage, thumb, thumbs });

  if (typeof log === 'function') {
    await log({ event: 'video.route', id: item.id, route: plan.route, world: world ? world.slug : null });
  }

  return plan.route === 'hook'
    ? renderHookReel(item, plan, { config, studio, outDir, P })
    : renderMiddleReel(item, plan, { config, studio, outDir, P });
}
