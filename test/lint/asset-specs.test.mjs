import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkAssetSpecs } from '../../src/lint/rules/asset-specs.mjs';

function rules(item, ctx = {}) {
  return checkAssetSpecs(item, ctx).map((v) => v.rule);
}

test('asset-specs: reel with correct 1080x1920 dims passes', () => {
  const item = { format: 'reel', platform: 'instagram', assets: [{ kind: 'video', w: 1080, h: 1920 }] };
  assert.equal(rules(item).includes('asset-specs:dims'), false);
});

test('asset-specs: reel with wrong dims blocks', () => {
  const item = { format: 'reel', assets: [{ kind: 'video', w: 1080, h: 1080 }] };
  assert.ok(rules(item).includes('asset-specs:dims'));
});

test('asset-specs: tiktok_video and story also require 1080x1920', () => {
  for (const format of ['tiktok_video', 'story']) {
    const item = { format, assets: [{ kind: 'video', w: 720, h: 1280 }] };
    assert.ok(rules(item).includes('asset-specs:dims'), `expected ${format} to require 1080x1920`);
  }
});

test('asset-specs: image/carousel accepts EITHER 1080x1350 OR 1080x1080', () => {
  for (const dims of [{ w: 1080, h: 1350 }, { w: 1080, h: 1080 }]) {
    const item = { format: 'image', assets: [{ kind: 'poster', ...dims }] };
    assert.equal(rules(item).includes('asset-specs:dims'), false, `expected ${dims.w}x${dims.h} to pass`);
  }
});

test('asset-specs: image with unsupported dims blocks', () => {
  const item = { format: 'carousel', assets: [{ kind: 'poster', w: 1200, h: 1200 }] };
  assert.ok(rules(item).includes('asset-specs:dims'));
});

test('asset-specs: video duration within 6-90s passes', () => {
  const item = { format: 'reel', assets: [{ kind: 'video', dur_s: 45 }] };
  assert.equal(rules(item).includes('asset-specs:duration'), false);
});

test('asset-specs: video duration under 6s blocks', () => {
  const item = { format: 'reel', assets: [{ kind: 'video', dur_s: 3 }] };
  assert.ok(rules(item).includes('asset-specs:duration'));
});

test('asset-specs: video duration over 90s blocks', () => {
  const item = { format: 'tiktok_video', assets: [{ kind: 'video', dur_s: 120 }] };
  assert.ok(rules(item).includes('asset-specs:duration'));
});

test('asset-specs: duration bounds are not enforced on non-video formats', () => {
  const item = { format: 'image', assets: [{ kind: 'poster', dur_s: 500 }] };
  assert.equal(rules(item).includes('asset-specs:duration'), false);
});

test('asset-specs: Instagram image asset must be JPEG', () => {
  const item = { format: 'image', platform: 'instagram', assets: [{ kind: 'poster', path: 'final.png' }] };
  assert.ok(rules(item).includes('asset-specs:jpeg-required'));
});

test('asset-specs: Instagram image asset as .jpg or .jpeg passes', () => {
  for (const ext of ['final.jpg', 'final.jpeg', 'FINAL.JPG']) {
    const item = { format: 'image', platform: 'instagram', assets: [{ kind: 'poster', path: ext }] };
    assert.equal(rules(item).includes('asset-specs:jpeg-required'), false, `expected ${ext} to pass`);
  }
});

test('asset-specs: JPEG requirement does not apply outside Instagram image/carousel', () => {
  const item = { format: 'image', platform: 'tiktok', assets: [{ kind: 'poster', path: 'final.png' }] };
  assert.equal(rules(item).includes('asset-specs:jpeg-required'), false);
});

test('asset-specs: file-exists/sha256 checks are skipped without an assetsBaseDir configured (soft check)', () => {
  const item = { format: 'image', assets: [{ kind: 'poster', path: 'nonexistent/file.jpg' }] };
  assert.equal(rules(item, {}).includes('asset-specs:file-missing'), false);
});

test('asset-specs: with assetsBaseDir configured, a missing file blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap401-asset-'));
  const item = { format: 'image', assets: [{ kind: 'poster', path: 'missing.jpg' }] };
  const violations = checkAssetSpecs(item, { config: { assetsBaseDir: tmpDir } });
  assert.ok(violations.some((v) => v.rule === 'asset-specs:file-missing'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('asset-specs: with assetsBaseDir configured, a matching sha256 passes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap401-asset-'));
  const filePath = path.join(tmpDir, 'real.jpg');
  fs.writeFileSync(filePath, 'hello forevermore');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

  const item = { format: 'image', assets: [{ kind: 'poster', path: 'real.jpg', sha256 }] };
  const violations = checkAssetSpecs(item, { config: { assetsBaseDir: tmpDir } });
  assert.equal(violations.some((v) => v.rule.startsWith('asset-specs:file') || v.rule.includes('sha256')), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('asset-specs: with assetsBaseDir configured, a mismatched sha256 blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap401-asset-'));
  const filePath = path.join(tmpDir, 'real.jpg');
  fs.writeFileSync(filePath, 'hello forevermore');

  const item = { format: 'image', assets: [{ kind: 'poster', path: 'real.jpg', sha256: 'deadbeef'.repeat(8) }] };
  const violations = checkAssetSpecs(item, { config: { assetsBaseDir: tmpDir } });
  assert.ok(violations.some((v) => v.rule === 'asset-specs:sha256-mismatch'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('asset-specs: item with no assets produces no violations', () => {
  assert.deepEqual(checkAssetSpecs({ format: 'reel' }, {}), []);
});
