#!/usr/bin/env node
/**
 * @file Render-parity proof (§3.9, AP-846). Re-renders one real poster item
 * (image/carousel → Brave path) and one real video item (reel/tiktok_video →
 * Remotion path) from the in-repo kit into a THROWAWAY temp dir — no outbox
 * or store writes — then runs the live brand lint over each item with its
 * fresh assets.
 *
 * PASS means: both renders produced non-empty assets AND each item's fresh
 * lint verdict matches the verdict stored on the item (parity — a bounced
 * item is allowed to fail lint again; a passed item failing now is drift).
 *
 * Run it on the Mac before provisioning, on the VPS before cutover (with
 * AUTOPILOT_REMOTION_GL=swangle there), and after any render-env change.
 *
 *   node bin/render-proof.mjs [--poster <id>] [--video <id>]
 */

import { promises as fsp } from 'node:fs';
import { statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createStore } from '../src/store/index.mjs';
import { renderPoster, renderVideo } from '../src/adapters/index.mjs';
import brandLint from '../src/drivers/brand-lint.mjs';

const POSTER_FORMATS = new Set(['image', 'carousel', 'story']);
const VIDEO_FORMATS = new Set(['reel', 'tiktok_video']);
/** Prefer items that already carry a stored lint verdict, newest slot first. */
const PICK_STATUSES = ['pending_review', 'approved', 'scheduled', 'rendered'];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

async function pick(store, formats) {
  const items = await store.listByStatus(PICK_STATUSES);
  return items
    .filter((i) => formats.has(i.format))
    .sort((a, b) => String(b.slot_at).localeCompare(String(a.slot_at)))[0] || null;
}

async function prove(kind, item, render, { config, store, root }) {
  const outDir = join(root, item.id, 'assets');
  const t0 = Date.now();
  const assets = await render(item, { config, outDir });
  const ms = Date.now() - t0;

  const files = assets.map((a) => {
    const p = join(root, item.id, a.path);
    return { path: a.path, w: a.w, h: a.h, bytes: statSync(p).size };
  });
  const empty = files.filter((f) => f.bytes === 0);

  const lint = await brandLint({ ...item, assets }, { config, store });
  const storedPassed = item.lint ? Boolean(item.lint.passed) : null;
  const parity = storedPassed === null ? true : lint.passed === storedPassed;

  const ok = assets.length > 0 && empty.length === 0 && parity;
  return {
    kind,
    id: item.id,
    format: item.format,
    renderMs: ms,
    files,
    lintPassed: lint.passed,
    storedLintPassed: storedPassed,
    violations: lint.violations,
    ok,
    ...(ok ? {} : { why: empty.length ? `empty assets: ${empty.map((f) => f.path).join(', ')}` : !assets.length ? 'no assets produced' : `lint parity broke (stored ${storedPassed}, now ${lint.passed})` }),
  };
}

const config = loadConfig();
const store = createStore(config);
const root = mkdtempSync(join(tmpdir(), 'autopilot-render-proof-'));
const results = [];
let exitCode = 0;

try {
  const posterId = argValue('--poster');
  const videoId = argValue('--video');
  const posterItem = posterId ? await store.getItem(posterId) : await pick(store, POSTER_FORMATS);
  const videoItem = videoId ? await store.getItem(videoId) : await pick(store, VIDEO_FORMATS);

  for (const [kind, item, render] of [
    ['poster', posterItem, renderPoster],
    ['video', videoItem, renderVideo],
  ]) {
    if (!item) {
      results.push({ kind, ok: false, why: `no ${kind} item found in ${PICK_STATUSES.join('/')}` });
      continue;
    }
    try {
      results.push(await prove(kind, item, render, { config, store, root }));
    } catch (e) {
      results.push({ kind, id: item.id, ok: false, why: `render threw: ${e.message}` });
    }
  }

  for (const r of results) {
    const badge = r.ok ? '✓' : '✗';
    const head = `${badge} ${r.kind.padEnd(6)} ${r.id || '—'}`;
    const tail = r.ok
      ? `${r.files.length} asset(s), lint ${r.lintPassed ? 'passed' : `failed (parity ok — stored verdict matches)`}, ${r.renderMs} ms`
      : r.why;
    console.log(`${head}  ${tail}`);
  }
  console.log(`\nartifacts: ${root}`);
  await fsp.writeFile(join(root, 'proof.json'), JSON.stringify({ at: new Date().toISOString(), remotionGl: config.remotionGl || null, results }, null, 2));

  exitCode = results.every((r) => r.ok) ? 0 : 1;
  console.log(exitCode === 0 ? '\n✓ render parity holds' : '\n✗ render parity FAILED');
} finally {
  await store.close();
}
process.exit(exitCode);
