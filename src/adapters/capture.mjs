/**
 * @file Capture adapter (AP-203, PRD §7.2 "library-first").
 *
 * v0 reads a pre-recorded capture library (`library/manifest.json`, built by
 * ticket AP-204) and copies the matching world clip into the item's assets dir.
 * There is NO live capture path in v0: `--live` deliberately boots nothing and
 * errors with instructions, because live capture needs the experience dev
 * server + AP-204's recorder (owner ticket AP-906 records the b-roll once).
 *
 * Manifest shape (AP-204 contract, mirrored here):
 *   { clips: [ { world: "gone-fishing", path: "gone-fishing.mp4", dur_s: 62,
 *                w: 1080, h: 1920, beats: [...] }, ... ] }
 */

import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../util/hash.mjs';

function manifestPath(config) {
  return join(config.resolved.library, 'manifest.json');
}

async function readManifest(config) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(config), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Pick a clip for the item (by world hint), else the first clip. */
function pickClip(manifest, item) {
  const clips = (manifest && manifest.clips) || [];
  if (!clips.length) return null;
  const world = (item.overlays && item.overlays.world) || item.series_key || null;
  if (world) {
    const hit = clips.find((c) => c.world === world);
    if (hit) return hit;
  }
  return clips[0];
}

/**
 * @param {import('../types.mjs').ContentItem} item
 * @param {{config:Object, outDir:string, live?:boolean}} opts
 * @returns {Promise<import('../types.mjs').AssetRef[]>}
 */
export async function capture(item, { config, outDir, live = false }) {
  const manifest = await readManifest(config);

  if (!manifest) {
    if (live) {
      throw new Error(
        'capture --live is not available in v0: it would need the experience dev server ' +
          '(pnpm dev:experience) and the AP-204 capture-library recorder. Record the b-roll ' +
          'library first (AP-204 / owner ticket AP-906), then re-run without --live.',
      );
    }
    throw new Error(
      `no capture library at ${manifestPath(config)}. Build it with AP-204's ` +
        '`autopilot library build`, or pass --live once AP-204 lands.',
    );
  }

  const clip = pickClip(manifest, item);
  if (!clip) throw new Error('capture library manifest has no clips');

  const src = join(config.resolved.library, clip.path);
  if (!existsSync(src)) throw new Error(`capture clip missing on disk: ${src}`);

  await fsp.mkdir(outDir, { recursive: true });
  const outName = `${item.id}.mp4`;
  const dest = join(outDir, outName);
  await fsp.copyFile(src, dest);

  return [
    {
      kind: 'capture',
      path: `assets/${outName}`,
      w: clip.w || 1080,
      h: clip.h || 1920,
      dur_s: clip.dur_s,
      sha256: await sha256File(dest),
    },
  ];
}
