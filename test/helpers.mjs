/**
 * @file Test helpers: hermetic temp config/store, a small ideas fixture, and
 * stub brain/adapters/lint so the whole pipeline runs without Brave, Remotion,
 * or the claude CLI.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createStore } from '../src/store/index.mjs';

/** Small, varied ideas fixture (enough IG- and TikTok-eligible ideas to fill slots). */
export const IDEAS_FIXTURE = [
  { id: 'I01', title: 'both a', pillar: 'P1', platform: 'both', score: 100, hook: 'hook a', beats: ['b1', 'b2'], cta: 'cta a', worlds: ['Gone Fishing'], occasions: ['anniversary'] },
  { id: 'I02', title: 'both b', pillar: 'P2', platform: 'both', score: 90, hook: 'hook b', beats: ['b1'], cta: 'cta b', worlds: ['Love Letters'], occasions: [] },
  { id: 'I03', title: 'tiktok a', pillar: 'P3', platform: 'tiktok', score: 80, hook: 'hook c', beats: [], cta: 'cta c', worlds: [], occasions: [] },
  { id: 'I04', title: 'tiktok b', pillar: 'P4', platform: 'tiktok', score: 70, hook: 'hook d', beats: [], cta: 'cta d', worlds: [], occasions: [] },
  { id: 'I05', title: 'carousel a', pillar: 'P5', platform: 'ig-carousel', score: 60, hook: 'hook e', beats: [], cta: 'cta e', worlds: [], occasions: [] },
  { id: 'I06', title: 'story a', pillar: 'P6', platform: 'ig-story', score: 50, hook: 'hook f', beats: [], cta: 'cta f', worlds: [], occasions: [] },
  { id: 'I07', title: 'reels a', pillar: 'P7', platform: 'reels', score: 95, hook: 'hook g', beats: [], cta: 'cta g', worlds: [], occasions: [] },
  { id: 'I08', title: 'both c', pillar: 'P1', platform: 'both', score: 85, hook: 'hook h', beats: [], cta: 'cta h', worlds: [], occasions: [] },
  { id: 'I09', title: 'tiktok c', pillar: 'P2', platform: 'tiktok', score: 75, hook: 'hook i', beats: [], cta: 'cta i', worlds: [], occasions: [] },
  { id: 'I10', title: 'carousel b', pillar: 'P3', platform: 'ig-carousel', score: 65, hook: 'hook j', beats: [], cta: 'cta j', worlds: [], occasions: [] },
];

/** Make a hermetic temp data root + config + store. */
export function mkEnv(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-test-'));
  const ideasPath = join(tmp, 'ideas.json');
  writeFileSync(ideasPath, JSON.stringify(overrides.ideas || IDEAS_FIXTURE));
  // Non-existent config path → pure DEFAULTS; env points data root at tmp.
  const config = loadConfig({
    configPath: join(tmp, 'no-config.json'),
    env: { AUTOPILOT_ROOT: tmp, ...(overrides.env || {}) },
  });
  config.resolved.ideas = ideasPath;
  if (overrides.cadence) config.cadence = { ...config.cadence, ...overrides.cadence };
  const store = createStore(config);
  return { tmp, config, store, ideasPath };
}

/** A deterministic stub brain driver. */
export const brainStub = {
  name: 'stub',
  async complete(req) {
    return {
      caption: `caption for ${req.item.id}`,
      hashtags: ['forevermore', 'giftideas'],
      overlays: { hook: `hook for ${req.item.id}` },
      meta: { driver: 'stub', cost_usd: 0 },
    };
  },
};

/** Stub renderer adapters that record assets without touching Brave/Remotion. */
export const adapterStub = {
  async poster(item) {
    return [{ kind: 'poster', path: `assets/${item.id}.png`, w: 1080, h: 1350, sha256: 'stub' }];
  },
  async video(item) {
    return [{ kind: 'video', path: `assets/${item.id}.mp4`, w: 1080, h: 1920, dur_s: 9.5, sha256: 'stub' }];
  },
  async capture(item) {
    return [{ kind: 'capture', path: `assets/${item.id}.mp4`, w: 1080, h: 1920, dur_s: 60, sha256: 'stub' }];
  },
};

export const lintPass = () => ({ passed: true, violations: [] });
export const lintFail = () => ({ passed: false, violations: [{ rule: 'banned-word', severity: 'block', excerpt: 'x' }] });

/** A minimal planned item for state-machine/store unit tests. */
export function plannedItem(id = 'ci_20260714_ig_1') {
  return {
    id,
    slot_at: '2026-07-14T17:30:00+02:00',
    platform: 'instagram',
    format: 'reel',
    idea_id: 'I01',
    series_key: null,
    pillar: 'P1',
    risk: 'standard',
    status: 'planned',
    candidate_group: 'cg_20260714_ig',
    chosen: false,
    caption: null,
    hashtags: [],
    overlays: {},
    link_utm: null,
    assets: [],
    lint: null,
    dedupe: null,
    produced_by: null,
    attempt: 1,
    regen_of: null,
  };
}
