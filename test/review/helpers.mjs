// Shared test scaffolding for the review-station HTTP tests. Not a test file
// itself (no top-level `test()` calls) — Node's test runner will still load
// it once because it lives under a directory named `test/`, which is
// harmless: it registers zero subtests and reports as a trivial pass.
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReviewServer } from '../../review/lib/app.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createStore } from '../../src/store/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_OUTBOX = join(HERE, '..', '..', 'fixtures', 'outbox-sample');
const PUBLIC_DIR = join(HERE, '..', '..', 'review', 'public');

/** Copies the committed fixture outbox into a fresh OS temp dir so tests
 * never mutate the committed sample and can run fully in parallel. */
export async function copyFixtureOutbox() {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-review-test-'));
  const outboxDir = join(root, 'outbox');
  await cp(FIXTURE_OUTBOX, outboxDir, { recursive: true });
  return {
    root,
    outboxDir,
    decisionsDir: join(root, 'decisions'),
    settingsPath: join(root, 'settings.json'),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Boots a real review-station HTTP server on an ephemeral port against the
 * given (already-copied) outbox tree, and returns fetch-ready helpers. The
 * server runs in file mode over a FileStore rooted at the copied fixture — the
 * same Store abstraction postgres mode uses. */
export async function startTestServer(paths) {
  const dataRoot = dirname(paths.outboxDir);
  const config = loadConfig({
    configPath: join(dataRoot, 'no-config.json'),
    env: { AUTOPILOT_ROOT: dataRoot, AUTOPILOT_STORE: 'file' },
  });
  const store = createStore(config);

  const server = createReviewServer({
    store,
    outboxDir: paths.outboxDir,
    settingsPath: paths.settingsPath,
    publicDir: PUBLIC_DIR,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    async getItems() {
      const res = await fetch(`${baseUrl}/api/items`);
      return { status: res.status, body: await res.json() };
    },
    async decide(payload) {
      const res = await fetch(`${baseUrl}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    async fetchAsset(path, init) {
      return fetch(`${baseUrl}${path}`, init);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close?.();
    },
  };
}

/** Convenience: copies the fixture + boots a server, returns everything plus
 * a single teardown() that closes the server and removes the temp dir. */
export async function setupReviewTest() {
  const paths = await copyFixtureOutbox();
  const harness = await startTestServer(paths);
  return {
    ...harness,
    paths,
    async teardown() {
      await harness.close();
      await paths.cleanup();
    },
  };
}
