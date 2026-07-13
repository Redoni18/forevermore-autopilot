// AP-835: the showcase reel replaces the OverlayReel footage treatment.
// planVideo routes to 'showcase' only when the world can actually be SHOWN
// (active catalog world + library footage + staged thumbnail); renderVideo's
// showcase body stages a real still and concats Hook → Showcase → End.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planVideo,
  stillSeconds,
  hookProps,
  showcaseProps,
  renderVideo,
} from '../src/adapters/video.mjs';

const WORLD = { slug: 'blockheart-mine', name: 'The Blockheart Mine', tier: 'premium', isActive: true };
const FOOTAGE = { slug: 'blockheart-mine', file: 'blockheart-mine.mp4', dur_s: 46.6 };
const THUMB = 'template-thumbs/blockheart-mine.webp';

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

test('planVideo: hook route when the world cannot be shown', () => {
  const item = itemFixture();
  const noWorld = planVideo(item, {});
  assert.equal(noWorld.route, 'hook');
  assert.deepEqual(noWorld.props, hookProps(item));

  const noThumb = planVideo(item, { world: WORLD, footage: FOOTAGE, thumb: null });
  assert.equal(noThumb.route, 'hook', 'footage without a staged thumbnail still takes the hook path');

  const noFootage = planVideo(item, { world: WORLD, footage: null, thumb: THUMB });
  assert.equal(noFootage.route, 'hook', 'a thumbnail without footage still takes the hook path');
});

test('planVideo: showcase route carries both comps\' exact props', () => {
  const item = itemFixture();
  const plan = planVideo(item, { world: WORLD, footage: FOOTAGE, thumb: THUMB });
  assert.equal(plan.route, 'showcase');
  assert.equal(plan.slug, 'blockheart-mine');
  assert.equal(plan.clipFile, 'blockheart-mine.mp4');
  assert.equal(plan.stillAt, 28);
  assert.deepEqual(plan.hookProps, hookProps(item), 'part 1 is the unchanged kinetic HookCard');
  assert.deepEqual(plan.showcaseProps, showcaseProps(WORLD, THUMB, 'blockheart-mine'));
  assert.deepEqual(plan.showcaseProps, {
    world: 'The Blockheart Mine',
    thumb: 'template-thumbs/blockheart-mine.webp',
    still: '__autopilot-clips/blockheart-mine-still.jpg',
  });
});

/** A fake platform+studio tree so renderVideo's resolution chain runs for real. */
function fakeEnv() {
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-video-test-'));
  const repoRoot = join(tmp, 'platform');
  const studio = join(repoRoot, 'marketing', '05-video-studio');
  const library = join(tmp, 'library');
  const outDir = join(tmp, 'out');

  mkdirSync(join(studio, 'public', 'template-thumbs'), { recursive: true });
  writeFileSync(join(studio, 'public', 'template-thumbs', 'blockheart-mine.webp'), 'webp');
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

  const config = { resolved: { repoRoot, videoStudio: studio, library, ideas, outbox: join(tmp, 'outbox') } };
  return { tmp, config, outDir };
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

test('renderVideo hook body is untouched when the world has no staged thumbnail', async () => {
  const { config, outDir } = fakeEnv();
  // remove the thumbnail gate → hook path
  const { rmSync } = await import('node:fs');
  rmSync(join(config.resolved.videoStudio, 'public', 'template-thumbs', 'blockheart-mine.webp'));

  const P = stubProc();
  const assets = await renderVideo(itemFixture(), { config, outDir, proc: P });
  const renders = P.calls.filter((c) => c.kind === 'run').map((c) => c.args[2]);
  assert.deepEqual(renders, ['HookCard', 'EndCard']);
  assert.equal(assets[0].dur_s, 9.5);
});
