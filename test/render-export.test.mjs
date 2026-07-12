import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.mjs';

// render.mjs lives in the Forevermore platform checkout (standalone layout).
const { JOBS, SIZES, renderOne, renderJobs, serve } = await import(
  pathToFileURL(join(REPO_ROOT, 'marketing/04-assets/render.mjs')).href
);

// Guards the AP-203 refactor: importing render.mjs must be side-effect-free
// (no browser launch) and expose the programmatic API, while the 17 CLI JOBS
// stay intact.

test('render.mjs exposes the programmatic API', () => {
  assert.equal(typeof renderOne, 'function');
  assert.equal(typeof renderJobs, 'function');
  assert.equal(typeof serve, 'function');
});

test('the 17 CLI jobs are unchanged', () => {
  assert.equal(JOBS.length, 17);
  assert.deepEqual(SIZES.feed, [1080, 1350]);
  assert.deepEqual(SIZES.story, [1080, 1920]);
  assert.deepEqual(SIZES.og, [1200, 630]);
  // every job still has the fields the CLI + adapter rely on
  for (const j of JOBS) {
    assert.ok(j.out && j.page && j.params && j.size, `job ${JSON.stringify(j)} missing fields`);
  }
});

test('serve() boots the poster server (200 for a template, 404 for missing)', async () => {
  const server = await serve();
  const port = server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/quote-card.html`);
    assert.equal(ok.status, 200);
    const miss = await fetch(`http://127.0.0.1:${port}/does-not-exist.html`);
    assert.equal(miss.status, 404);
  } finally {
    server.close();
  }
});
