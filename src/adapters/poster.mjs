/**
 * @file Poster adapter (AP-203). Renders an item to a PNG (and, for Instagram
 * images, a JPEG twin the Graph API requires) into `outbox/<id>/assets/`.
 *
 * It drives the refactored `renderOne`/`renderJobs` from
 * marketing/04-assets/render.mjs (loaded via the configured path so the adapter
 * is CWD-independent) and injects `chromium` resolved from the repo root, so it
 * works regardless of where the runner process was launched.
 *
 * v0 item→job mapping is a documented placeholder: a single `quote-card.html`
 * with the item's hook. Picking the right template per item is the art-director's
 * job (AP-301/AP-402); this seam just needs to produce a spec-correct asset.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sha256File } from '../util/hash.mjs';
import { ffmpeg } from './proc.mjs';

let _renderMod = null;
async function loadRenderModule(config) {
  if (!_renderMod) _renderMod = await import(pathToFileURL(config.resolved.render).href);
  return _renderMod;
}

/** Resolve playwright-core's chromium from the repo root (robust to CWD). */
function loadChromium(config) {
  const require = createRequire(join(config.resolved.repoRoot, 'package.json'));
  return require('playwright-core').chromium;
}

/** v0: map an item to a render job for render.mjs. */
function itemToJob(item, outName) {
  const size = item.format === 'story' ? 'story' : 'feed';
  const line = (item.overlays && item.overlays.hook) || (item.caption || '').split('\n')[0] || 'Give them a whole world.';
  return {
    out: outName,
    page: 'quote-card.html',
    params: { line, hl: '', mascot: 'gift', sub: '' },
    size,
  };
}

/** Instagram image formats need a JPEG (Graph API requirement, PRD §7.1/§9.1). */
function needsJpeg(item) {
  return item.platform === 'instagram' && ['image', 'carousel', 'story'].includes(item.format);
}

/**
 * @param {import('../types.mjs').ContentItem} item
 * @param {{config:Object, outDir:string}} opts
 * @returns {Promise<import('../types.mjs').AssetRef[]>}
 */
export async function renderPoster(item, { config, outDir }) {
  await fsp.mkdir(outDir, { recursive: true });
  const { renderJobs, SIZES } = await loadRenderModule(config);
  const chromium = loadChromium(config);

  const pngName = `${item.id}.png`;
  const job = itemToJob(item, pngName);
  const [w, h] = SIZES[job.size] || SIZES.feed;

  await renderJobs([job], { chromium, outDir, quiet: true, brave: config.brave });

  const pngPath = join(outDir, pngName);
  /** @type {import('../types.mjs').AssetRef[]} */
  const assets = [{ kind: 'poster', path: `assets/${pngName}`, w, h, sha256: await sha256File(pngPath) }];

  if (needsJpeg(item)) {
    const jpgName = `${item.id}.jpg`;
    const jpgPath = join(outDir, jpgName);
    ffmpeg(config, ['-y', '-i', pngPath, '-q:v', '3', jpgPath]);
    assets.push({ kind: 'poster', path: `assets/${jpgName}`, w, h, sha256: await sha256File(jpgPath) });
  }

  return assets;
}
