/**
 * @file Subprocess helpers for the renderer adapters. Uses the ffmpeg bundled
 * inside the Remotion studio (same approach as marketing/04-assets/capture-world.mjs)
 * so there are no extra installs.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Path to the studio's `remotion` bin (also exposes `remotion ffmpeg`). */
export function remotionBin(config) {
  return join(config.resolved.videoStudio, 'node_modules', '.bin', 'remotion');
}

/**
 * Run a command, inheriting nothing (captured), throwing a helpful error on
 * non-zero exit. @returns {{stdout:string, stderr:string}}
 */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (res.error) throw new Error(`${cmd} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').split('\n').slice(-12).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}:\n${tail}`);
  }
  return { stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** Run `remotion ffmpeg <args...>` via the studio's bundled ffmpeg. */
export function ffmpeg(config, args) {
  return run(remotionBin(config), ['ffmpeg', ...args], { cwd: config.resolved.videoStudio });
}
