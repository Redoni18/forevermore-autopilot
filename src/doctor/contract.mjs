/**
 * @file Kit/platform contract checks (WAVE2 §4 Phase 2 pre-work, AP-845).
 *
 * After the §3.12 kit move, the render pipeline's inputs live in two places:
 * the in-repo kit/ (templates, studio comps, brand guide, catalog) and the
 * residual FOREVERMORE_ROOT seam (platform checkout for brain cwd + thumbnail
 * upstream) plus the local capture library. Any of these can drift silently —
 * a deleted template, a renamed comp, a brand guide missing the sections the
 * lint rules encode — and the first symptom would otherwise be a failed render
 * hours later, or worse, on the VPS after cutover.
 *
 * Two consumers:
 *   - `autopilot doctor` runs the DEEP variant (imports render.mjs and
 *     verifies its exports) and prints every check.
 *   - the tick sweep runs the fast variant before each sweep and, when the
 *     set of critical failures CHANGES, appends one failed `doctor:contract`
 *     run row — which the bot scanner already turns into a Discord alert.
 *     Fingerprint-gating keeps a persistent drift at one alert, not one per
 *     tick (48/day).
 *
 * Check shape matches cmdDoctor's: { name, ok, level, detail } with level
 * 'critical' | 'warn'. Only critical failures enter the fingerprint.
 */

import { promises as fsp, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCatalog } from '../lint/catalog.mjs';

/** Poster templates renderPoster routes to (src/adapters/poster.mjs). */
const POSTER_TEMPLATES = ['quote-card.html', 'carousel-slide.html', 'world-drop.html'];
/** Mascots the image path rotates through (IMAGE_MASCOTS in poster.mjs). */
const POSTER_MASCOTS = ['gift.png', 'album.png', 'book.png'];
/** Comps the video adapter renders by id (src/adapters/video.mjs routes). */
const STUDIO_COMPS = ['HookCard', 'ShowcaseCard', 'WorldShelfCard', 'EndCard'];
/** Brand-guide headings the lint rules encode (rules cite these sections). */
const BRAND_SECTIONS = ['## 1. What we are', '## 2. Claims & price law', '## 3. Voice'];
/** template-thumbs floor: 44 committed today; alert well before "too few". */
const THUMBS_FLOOR = 30;

function check(name, ok, level, detail) {
  return { name, ok: Boolean(ok), level, detail };
}

/** Every .ts/.tsx source under the studio's src/, concatenated (small dir). */
async function studioSource(videoStudio) {
  const dir = join(videoStudio, 'src');
  let out = '';
  const walk = async (d) => {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.tsx?$/.test(ent.name)) out += await fsp.readFile(p, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

/**
 * Run the contract checks.
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @param {{deep?: boolean}} [opts]  deep = also import render.mjs and verify
 *   its exports (doctor CLI); the tick uses the fast, filesystem-only variant.
 * @returns {Promise<Array<{name:string, ok:boolean, level:string, detail:string}>>}
 */
export async function contractChecks(config, { deep = false } = {}) {
  const r = config.resolved;
  const checks = [];

  // kit: poster renderer
  if (deep && existsSync(r.render)) {
    try {
      const mod = await import(pathToFileURL(r.render).href);
      const ok = typeof mod.renderOne === 'function' && typeof mod.renderJobs === 'function';
      checks.push(check('kit render.mjs exports', ok, 'critical', ok ? 'renderOne + renderJobs' : 'renderOne/renderJobs missing — adapters/poster.mjs depends on both'));
    } catch (e) {
      checks.push(check('kit render.mjs exports', false, 'critical', `import failed: ${e.message}`));
    }
  } else {
    checks.push(check('kit render.mjs', existsSync(r.render), 'critical', r.render));
  }

  const missingTpl = POSTER_TEMPLATES.filter((t) => !existsSync(join(r.posters, t)));
  checks.push(check('kit poster templates', missingTpl.length === 0, 'critical',
    missingTpl.length ? `missing: ${missingTpl.join(', ')}` : `${POSTER_TEMPLATES.length} present`));

  const missingMascot = POSTER_MASCOTS.filter((m) => !existsSync(join(r.posters, 'assets', 'mascot', m)));
  checks.push(check('kit poster mascots', missingMascot.length === 0, 'critical',
    missingMascot.length ? `missing: ${missingMascot.join(', ')}` : `${POSTER_MASCOTS.length} present`));

  // kit: video studio comps (registered by id somewhere under src/)
  let src = null;
  try {
    src = await studioSource(r.videoStudio);
  } catch { /* handled below as missing */ }
  if (src === null) {
    checks.push(check('kit studio comps', false, 'critical', `no studio source at ${join(r.videoStudio, 'src')}`));
  } else {
    const missingComp = STUDIO_COMPS.filter((c) => !src.includes(c));
    checks.push(check('kit studio comps', missingComp.length === 0, 'critical',
      missingComp.length ? `missing: ${missingComp.join(', ')}` : STUDIO_COMPS.join(' ')));
  }

  // kit: committed template thumbnails (video shelf/showcase inputs)
  let thumbs = 0;
  try {
    thumbs = readdirSync(join(r.videoStudio, 'public', 'template-thumbs')).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)).length;
  } catch { /* stays 0 */ }
  checks.push(check('kit template thumbs', thumbs >= THUMBS_FLOOR, 'warn', `${thumbs} (floor ${THUMBS_FLOOR})`));

  // kit: brand guide carries the sections the lint rules encode
  if (!existsSync(r.brandGuide)) {
    checks.push(check('kit brand guide', false, 'critical', r.brandGuide));
  } else {
    const guide = await fsp.readFile(r.brandGuide, 'utf8');
    const missingSec = BRAND_SECTIONS.filter((s) => !guide.includes(s));
    checks.push(check('kit brand guide', missingSec.length === 0, 'critical',
      missingSec.length ? `missing sections: ${missingSec.join(' | ')}` : `${BRAND_SECTIONS.length} sections present`));
  }

  // kit: world/template catalog parses (lint + video world resolution input)
  try {
    const catalog = loadCatalog(r.catalog);
    checks.push(check('kit catalog', catalog.length > 0, 'critical', `${catalog.length} entries`));
  } catch (e) {
    checks.push(check('kit catalog', false, 'critical', e.message));
  }

  // FOREVERMORE_ROOT residual seam (brain cwd, thumbnail upstream) — warn:
  // the pipeline plans/generates without it; renders that need it fail loudly.
  const rootOk = existsSync(r.repoRoot) && statSync(r.repoRoot).isDirectory();
  checks.push(check('platform root (FOREVERMORE_ROOT)', rootOk, 'warn', r.repoRoot));

  // capture library: manifest parses and every clip file exists
  const manifest = join(r.library, 'manifest.json');
  if (!existsSync(manifest)) {
    checks.push(check('capture library', false, 'warn', `no manifest at ${manifest}`));
  } else {
    try {
      // Canonical shape (video.mjs footageFor): an object keyed by world slug,
      // each entry carrying at least { file }.
      const m = JSON.parse(await fsp.readFile(manifest, 'utf8'));
      const clips = Object.values(m).filter((v) => v && typeof v === 'object' && v.file);
      const gone = clips.filter((c) => !existsSync(join(r.library, c.file))).map((c) => c.file);
      const ok = clips.length > 0 && gone.length === 0;
      checks.push(check('capture library', ok, 'warn',
        gone.length ? `missing clips: ${gone.join(', ')}` : `${clips.length} clips`));
    } catch (e) {
      checks.push(check('capture library', false, 'warn', `manifest unreadable: ${e.message}`));
    }
  }

  return checks;
}

/**
 * Stable fingerprint of the CRITICAL failures (name+detail). Empty string when
 * the contract holds — the tick alerts only when this value changes.
 */
export function contractFingerprint(checks) {
  const broken = checks
    .filter((c) => c.level === 'critical' && !c.ok)
    .map((c) => `${c.name}|${c.detail}`)
    .sort();
  if (!broken.length) return '';
  return createHash('sha256').update(broken.join('\n')).digest('hex').slice(0, 16);
}
