/**
 * @file Video adapter (AP-203). Renders a kinetic reel — a prop-driven HookCard
 * with the EndCard concatenated on the tail — into `outbox/<id>/assets/final.mp4`.
 *
 * Pipeline:
 *   1. `remotion render src/index.ts HookCard hook.mp4 --props=<file>` (cwd = studio)
 *   2. `remotion render src/index.ts EndCard  end.mp4`
 *   3. concat via the ffmpeg concat demuxer with `-c copy` (stream copy, NO
 *      re-encode). This is only valid because both clips come out of Remotion
 *      with identical codec/timebase/dimensions (H.264, 30fps, 1080×1920) — the
 *      documented constraint for `-c copy`. If the studio's render settings ever
 *      diverge between comps, drop `-c copy` and re-encode instead.
 *
 * Heavy (spawns Chrome-headless-shell + ffmpeg); the unit suite does not call
 * this — the AP-203 golden test does, guarded on the binaries being present.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../util/hash.mjs';
import { run, ffmpeg, remotionBin } from './proc.mjs';

// Studio composition durations (frames) at 30fps — see 05-video-studio/src/Root.tsx.
const HOOK_FRAMES = 165;
const END_FRAMES = 120;
const FPS = 30;

/** Build HookCard props from the item's copy. */
function hookProps(item) {
  const line = (item.overlays && item.overlays.hook) || (item.caption || '').split('\n')[0] || "Store-bought says 'I remembered.'";
  return {
    kicker: (item.overlays && item.overlays.kicker) || 'made, not generated',
    line,
    hl: (item.overlays && item.overlays.hl) || '',
    mascot: (item.overlays && item.overlays.mascot) || 'gift',
  };
}

/**
 * @param {import('../types.mjs').ContentItem} item
 * @param {{config:Object, outDir:string}} opts
 * @returns {Promise<import('../types.mjs').AssetRef[]>}
 */
export async function renderVideo(item, { config, outDir }) {
  await fsp.mkdir(outDir, { recursive: true });
  const bin = remotionBin(config);
  const studio = config.resolved.videoStudio;

  const hookMp4 = join(outDir, 'hook.mp4');
  const endMp4 = join(outDir, 'end.mp4');
  const finalMp4 = join(outDir, 'final.mp4');
  const propsFile = join(outDir, 'hook.props.json');
  const listFile = join(outDir, 'concat.txt');

  await fsp.writeFile(propsFile, JSON.stringify(hookProps(item)), 'utf8');

  // 1) HookCard with props, 2) EndCard. cwd = studio so `src/index.ts` resolves.
  run(bin, ['render', 'src/index.ts', 'HookCard', hookMp4, `--props=${propsFile}`], { cwd: studio });
  run(bin, ['render', 'src/index.ts', 'EndCard', endMp4], { cwd: studio });

  // 3) stream-copy concat (no re-encode). Absolute paths + -safe 0.
  const list = `file '${hookMp4}'\nfile '${endMp4}'\n`;
  await fsp.writeFile(listFile, list, 'utf8');
  ffmpeg(config, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalMp4]);

  const durS = (HOOK_FRAMES + END_FRAMES) / FPS; // 9.5s (fixed comp durations)
  return [
    {
      kind: 'video',
      path: 'assets/final.mp4',
      w: 1080,
      h: 1920,
      dur_s: durS,
      sha256: await sha256File(finalMp4),
    },
  ];
}
