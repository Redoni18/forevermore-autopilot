// AP-835/836: every reel is Hook → [product act] → End. planVideo picks the
// middle act — 'showcase' (world poster + real in-experience still) when the
// world has footage AND a staged thumbnail, 'shelf' (card grid of real world
// posters) when only posters exist, bare 'hook' when nothing is staged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planVideo,
  stillSeconds,
  hookProps,
  showcaseProps,
  shelfThumbs,
  renderVideo,
} from '../src/adapters/video.mjs';

const WORLD = { slug: 'blockheart-mine', name: 'The Blockheart Mine', tier: 'premium', isActive: true };
const FOOTAGE = { slug: 'blockheart-mine', file: 'blockheart-mine.mp4', dur_s: 46.6 };
const THUMB = 'template-thumbs/blockheart-mine.webp';
const SHELF = [
  'template-thumbs/gone-fishing.webp',
  'template-thumbs/love-letters.webp',
  'template-thumbs/prize-claw.webp',
  'template-thumbs/passport.webp',
];

function itemFixture() {
  return {
    id: 'ci_test_1',
    idea_id: 'F03',
    caption: 'he ignores me for minecraft.\nsecond line',
    overlays: { hook: 'he ignores me for minecraft, so i built our relationship somewhere he\'d look.', beats: ['b1'], cta: 'the blockheart mine · getforevermore.co' },
  };
}

test('stillSeconds: manifest still_s wins (end-clamped); default is the 60% mark; no-dur fallback', () => {
  assert.equal(stillSeconds({ dur_s: 46.6, still_s: 12 }), 12, 'explicit still_s wins');
  assert.equal(stillSeconds({ dur_s: 20, still_s: 500 }), 19, 'explicit is clamped a second short of the end');
  assert.equal(stillSeconds({ dur_s: 46.6 }), 28, '60% into the clip by default');
  assert.equal(stillSeconds({}), 15, 'no duration → sane fixed fallback');
});

test('planVideo: showcase > shelf > hook, by what can actually be shown', () => {
  const item = itemFixture();

  const showcase = planVideo(item, { world: WORLD, footage: FOOTAGE, thumb: THUMB, thumbs: SHELF });
  assert.equal(showcase.route, 'showcase', 'footage + thumbnail wins even when a shelf exists');
  assert.equal(showcase.middleComp, 'ShowcaseCard');
  assert.deepEqual(showcase.middleProps, showcaseProps(WORLD, THUMB, 'blockheart-mine'));
  assert.deepEqual(showcase.middleProps, {
    world: 'The Blockheart Mine',
    thumb: 'template-thumbs/blockheart-mine.webp',
    still: '__autopilot-clips/blockheart-mine-still.jpg',
  });
  assert.equal(showcase.stillAt, 28);
  assert.deepEqual(showcase.hookProps, hookProps(item), 'part 1 is the unchanged kinetic HookCard');

  const shelf = planVideo(item, { world: WORLD, footage: FOOTAGE, thumb: null, thumbs: SHELF });
  assert.equal(shelf.route, 'shelf', 'footage without the world\'s own poster → shelf');
  assert.equal(shelf.middleComp, 'WorldShelfCard');
  assert.deepEqual(shelf.middleProps.thumbs, SHELF);
  assert.equal(shelf.middleProps.kicker, 'pick their world');

  const noWorld = planVideo(item, { thumbs: SHELF });
  assert.equal(noWorld.route, 'shelf', 'off-list items still get a product act');

  const bare = planVideo(item, {});
  assert.equal(bare.route, 'hook', 'nothing staged → the original hook reel');
  assert.deepEqual(bare.props, hookProps(item));

  const thin = planVideo(item, { thumbs: SHELF.slice(0, 2) });
  assert.equal(thin.route, 'hook', 'fewer than 4 posters does not read as a shelf');
});

/** A fake platform+studio tree so renderVideo's resolution chain runs for real. */
function fakeEnv() {
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-video-test-'));
  const repoRoot = join(tmp, 'platform');
  const studio = join(repoRoot, 'marketing', '05-video-studio');
  const library = join(tmp, 'library');
  const outDir = join(tmp, 'out');

  const thumbsDir = join(studio, 'public', 'template-thumbs');
  mkdirSync(thumbsDir, { recursive: true });
  for (const slug of ['blockheart-mine', 'gone-fishing', 'love-letters', 'prize-claw', 'passport']) {
    writeFileSync(join(thumbsDir, `${slug}.webp`), 'webp');
  }
  mkdirSync(join(repoRoot, 'marketing', '_research'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'marketing', '_research', 'template-catalog.md'),
    '# catalog\n\n```json\n[{"slug":"blockheart-mine","name":"The Blockheart Mine","tier":"premium","isActive":true}]\n```\n',
  );
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'manifest.json'), JSON.stringify({
    'blockheart-mine': { file: 'blockheart-mine.mp4', dur_s: 46.6, still_s: 29 },
  }));
  writeFileSync(join(library, 'blockheart-mine.mp4'), 'not-really-video');
  const ideas = join(tmp, 'ideas.json');
  writeFileSync(ideas, JSON.stringify([{ id: 'F03', title: 'gamer wedge', worlds: ['The Blockheart Mine'] }]));

  const catalog = join(repoRoot, 'marketing', '_research', 'template-catalog.md');
  const config = { resolved: { repoRoot, videoStudio: studio, library, ideas, catalog, outbox: join(tmp, 'outbox') } };
  return { tmp, config, outDir, thumbsDir };
}

/** Records every subprocess the adapter would spawn. The concat "produces"
 * its output file so the adapter's sha256File(final.mp4) has bytes to hash. */
function stubProc() {
  const calls = [];
  return {
    calls,
    remotionBin: () => '/fake/remotion',
    run(cmd, args, opts) { calls.push({ kind: 'run', cmd, args, cwd: opts?.cwd }); return { stdout: '', stderr: '' }; },
    ffmpeg(config, args) {
      calls.push({ kind: 'ffmpeg', args });
      if (args.includes('concat')) writeFileSync(args.at(-1), 'fake-final-mp4');
      return { stdout: '', stderr: '' };
    },
  };
}

test('shelfThumbs: the item\'s world leads, curation follows, capped at 9, staticFile-relative', () => {
  const { config } = fakeEnv();
  const list = shelfThumbs(config, WORLD);
  assert.equal(list[0], 'template-thumbs/blockheart-mine.webp', 'own world first');
  assert.deepEqual(
    list.slice(1),
    ['template-thumbs/gone-fishing.webp', 'template-thumbs/love-letters.webp', 'template-thumbs/prize-claw.webp', 'template-thumbs/passport.webp'],
    'then the curated order',
  );
  assert.deepEqual(shelfThumbs({ resolved: { videoStudio: '/nope' } }, WORLD), [], 'no staged posters → empty');
});

test('renderVideo showcase body: still extraction + Hook/Showcase/End renders + 3-part concat', async () => {
  const { config, outDir } = fakeEnv();
  const P = stubProc();
  const events = [];

  const assets = await renderVideo(itemFixture(), { config, outDir, proc: P, log: async (e) => events.push(e) });

  assert.deepEqual(events[0], { event: 'video.route', id: 'ci_test_1', route: 'showcase', world: 'blockheart-mine' });

  // 1) the still is pulled from the library master at the manifest's still_s
  const extract = P.calls.find((c) => c.kind === 'ffmpeg' && c.args.includes('-frames:v'));
  assert.ok(extract, 'an ffmpeg frame extraction ran');
  assert.equal(extract.args[extract.args.indexOf('-ss') + 1], '29', 'manifest still_s drives the timestamp');
  assert.ok(extract.args.at(-1).endsWith('__autopilot-clips/blockheart-mine-still.jpg'), 'still staged into the studio clips dir');

  // 2) all three comps render, in order
  const renders = P.calls.filter((c) => c.kind === 'run').map((c) => c.args[2]);
  assert.deepEqual(renders, ['HookCard', 'ShowcaseCard', 'EndCard']);

  // 3) the concat covers all three parts, stream-copy
  const concat = P.calls.find((c) => c.kind === 'ffmpeg' && c.args.includes('concat'));
  assert.ok(concat && concat.args.includes('-c') && concat.args.includes('copy'));

  // 4) asset contract: fixed 14.5s (165+150+120 frames @30fps)
  assert.equal(assets.length, 1);
  assert.equal(assets[0].dur_s, 14.5);
  assert.equal(assets[0].path, 'assets/final.mp4');
});

test('renderVideo shelf body: no world poster → WorldShelfCard grid, no still extraction', async () => {
  const { config, outDir, thumbsDir } = fakeEnv();
  // The world's own poster is gone but four others remain → shelf.
  rmSync(join(thumbsDir, 'blockheart-mine.webp'));

  const P = stubProc();
  const events = [];
  const assets = await renderVideo(itemFixture(), { config, outDir, proc: P, log: async (e) => events.push(e) });

  assert.equal(events[0].route, 'shelf');
  const renders = P.calls.filter((c) => c.kind === 'run').map((c) => c.args[2]);
  assert.deepEqual(renders, ['HookCard', 'WorldShelfCard', 'EndCard']);
  assert.ok(!P.calls.some((c) => c.kind === 'ffmpeg' && c.args.includes('-frames:v')), 'no still extraction on the shelf path');
  assert.equal(assets[0].dur_s, 14.5);
});

test('renderVideo hook body survives as the bare fallback (nothing staged at all)', async () => {
  const { config, outDir, thumbsDir } = fakeEnv();
  rmSync(thumbsDir, { recursive: true, force: true });

  const P = stubProc();
  const assets = await renderVideo(itemFixture(), { config, outDir, proc: P });
  const renders = P.calls.filter((c) => c.kind === 'run').map((c) => c.args[2]);
  assert.deepEqual(renders, ['HookCard', 'EndCard']);
  assert.equal(assets[0].dur_s, 9.5);
});

test('renderVideo passes --gl only when remotionGl is configured (§3.9)', async () => {
  const bare = fakeEnv();
  let P = stubProc();
  await renderVideo(itemFixture(), { config: bare.config, outDir: bare.outDir, proc: P });
  for (const c of P.calls.filter((c) => c.kind === 'run')) {
    assert.ok(!c.args.some((a) => String(a).startsWith('--gl=')), 'no --gl by default (macOS)');
  }

  const linux = fakeEnv();
  linux.config.remotionGl = 'swangle';
  P = stubProc();
  await renderVideo(itemFixture(), { config: linux.config, outDir: linux.outDir, proc: P });
  const renders = P.calls.filter((c) => c.kind === 'run');
  assert.ok(renders.length >= 2);
  for (const c of renders) {
    assert.ok(c.args.includes('--gl=swangle'), `--gl=swangle on every render: ${c.args.join(' ')}`);
  }
});
