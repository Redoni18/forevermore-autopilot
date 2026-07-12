// autopilot/src/lint/rules/asset-specs.mjs
//
// TICKETS.md AP-401: dims per format (reel/tiktok_video/story 1080x1920;
// image/carousel 1080x1350 or 1080x1080), duration 6-90s for video, JPEG
// required for instagram image/carousel kinds, file exists + sha256 matches
// "if present". The file-exists/sha256 checks are soft: they only run when
// the caller opts in with `config.assetsBaseDir` (a real filesystem to
// check against), so unit/dry-run items with logical/virtual paths never
// spuriously block.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VIDEO_DIMS = { w: 1080, h: 1920 };
const IMAGE_DIMS_OPTIONS = [
  { w: 1080, h: 1350 },
  { w: 1080, h: 1080 },
];
const VIDEO_FORMATS = new Set(['reel', 'tiktok_video', 'story']);
const IMAGE_FORMATS = new Set(['image', 'carousel']);
const MIN_DURATION_S = 6;
const MAX_DURATION_S = 90;
const IMAGE_ASSET_KINDS = new Set(['poster', 'image', undefined, null]);

function dimsMatch(asset, expectedList) {
  return expectedList.some((d) => asset.w === d.w && asset.h === d.h);
}

function checkDims(label, format, asset, violations) {
  if (typeof asset.w !== 'number' || typeof asset.h !== 'number') return;
  if (VIDEO_FORMATS.has(format)) {
    if (!dimsMatch(asset, [VIDEO_DIMS])) {
      violations.push({
        rule: 'asset-specs:dims',
        severity: 'block',
        excerpt: `${label}: ${asset.w}x${asset.h} does not match required ${VIDEO_DIMS.w}x${VIDEO_DIMS.h} for format "${format}"`,
      });
    }
  } else if (IMAGE_FORMATS.has(format)) {
    if (!dimsMatch(asset, IMAGE_DIMS_OPTIONS)) {
      const opts = IMAGE_DIMS_OPTIONS.map((d) => `${d.w}x${d.h}`).join(' or ');
      violations.push({
        rule: 'asset-specs:dims',
        severity: 'block',
        excerpt: `${label}: ${asset.w}x${asset.h} does not match required ${opts} for format "${format}"`,
      });
    }
  }
}

function checkDuration(label, format, asset, violations) {
  if (!VIDEO_FORMATS.has(format) || typeof asset.dur_s !== 'number') return;
  if (asset.dur_s < MIN_DURATION_S || asset.dur_s > MAX_DURATION_S) {
    violations.push({
      rule: 'asset-specs:duration',
      severity: 'block',
      excerpt: `${label}: duration ${asset.dur_s}s outside the ${MIN_DURATION_S}-${MAX_DURATION_S}s bounds`,
    });
  }
}

function checkJpegForInstagram(label, item, format, asset, violations) {
  if (item.platform !== 'instagram' || !IMAGE_FORMATS.has(format)) return;
  if (!IMAGE_ASSET_KINDS.has(asset.kind)) return;
  if (asset.path && !/\.jpe?g$/i.test(asset.path)) {
    violations.push({
      rule: 'asset-specs:jpeg-required',
      severity: 'block',
      excerpt: `${label}: Instagram ${format} assets must be JPEG (Graph API requirement), got "${asset.path}"`,
    });
  }
}

function checkFileAndHash(label, asset, assetsBaseDir, violations) {
  if (!asset.path || !assetsBaseDir) return; // soft check — opt-in only
  const resolved = path.isAbsolute(asset.path) ? asset.path : path.resolve(assetsBaseDir, asset.path);
  if (!fs.existsSync(resolved)) {
    violations.push({
      rule: 'asset-specs:file-missing',
      severity: 'block',
      excerpt: `${label}: file not found at ${resolved}`,
    });
    return;
  }
  if (asset.sha256) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    if (actual !== asset.sha256) {
      violations.push({
        rule: 'asset-specs:sha256-mismatch',
        severity: 'block',
        excerpt: `${label}: sha256 mismatch (expected ${asset.sha256}, got ${actual})`,
      });
    }
  }
}

export function checkAssetSpecs(item, ctx = {}) {
  const violations = [];
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const format = item.format;
  const assetsBaseDir = ctx.config?.assetsBaseDir || null;

  assets.forEach((asset, i) => {
    const label = `assets[${i}]${asset.path ? ` (${asset.path})` : ''}`;
    checkDims(label, format, asset, violations);
    checkDuration(label, format, asset, violations);
    checkJpegForInstagram(label, item, format, asset, violations);
    checkFileAndHash(label, asset, assetsBaseDir, violations);
  });

  return violations;
}
