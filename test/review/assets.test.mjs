// Tests for GET /assets/<item>/<file>: correct mime types and byte-range
// streaming (the mechanism <video> scrubbing depends on), plus basic
// not-found and path-traversal defense checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

import { setupReviewTest } from './helpers.mjs';

function rawGet(baseUrl, path) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(baseUrl);
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /assets: serves a PNG with the correct mime type and full content', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const items = await h.getItems();
  const tt1 = items.body.groups.flatMap((g) => g.items).find((i) => i.id === 'ci_20260714_tt_1');
  const asset = tt1.assets[0];

  const res = await h.fetchAsset(`/assets/${tt1.id}/${asset.path}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, Number(res.headers.get('content-length')));
  assert.ok(buf.length > 0);
});

test('GET /assets: serves an MP4 with Accept-Ranges and video mime', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const items = await h.getItems();
  const ig1 = items.body.groups.flatMap((g) => g.items).find((i) => i.id === 'ci_20260713_ig_1');
  const asset = ig1.assets[0];

  const res = await h.fetchAsset(`/assets/${ig1.id}/${asset.path}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('GET /assets: honors byte-range requests for video scrubbing (206 Partial Content)', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const items = await h.getItems();
  const ig1 = items.body.groups.flatMap((g) => g.items).find((i) => i.id === 'ci_20260713_ig_1');
  const asset = ig1.assets[0];
  const assetUrl = `/assets/${ig1.id}/${asset.path}`;

  const full = await h.fetchAsset(assetUrl);
  const fullBuf = Buffer.from(await full.arrayBuffer());

  // bounded range
  const bounded = await h.fetchAsset(assetUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(bounded.status, 206);
  assert.equal(bounded.headers.get('content-range'), `bytes 0-99/${fullBuf.length}`);
  assert.equal(bounded.headers.get('content-length'), '100');
  const boundedBuf = Buffer.from(await bounded.arrayBuffer());
  assert.equal(boundedBuf.length, 100);
  assert.deepEqual(boundedBuf, fullBuf.subarray(0, 100));

  // open-ended range (start-to-EOF, what a scrubbing seek typically sends)
  const tail = await h.fetchAsset(assetUrl, { headers: { Range: `bytes=${fullBuf.length - 50}-` } });
  assert.equal(tail.status, 206);
  const tailBuf = Buffer.from(await tail.arrayBuffer());
  assert.equal(tailBuf.length, 50);
  assert.deepEqual(tailBuf, fullBuf.subarray(fullBuf.length - 50));

  // unsatisfiable range -> 416
  const bad = await h.fetchAsset(assetUrl, { headers: { Range: `bytes=${fullBuf.length + 10}-${fullBuf.length + 20}` } });
  assert.equal(bad.status, 416);
});

test('GET /assets: 404s for an unknown item or missing file', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res1 = await h.fetchAsset('/assets/ci_does_not_exist/assets/final.mp4');
  assert.equal(res1.status, 404);

  const res2 = await h.fetchAsset('/assets/ci_20260713_ig_1/assets/nope.mp4');
  assert.equal(res2.status, 404);
});

test('GET /assets: rejects literal path-traversal segments before touching the filesystem', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  // sent as a raw HTTP request line so the '..' segments reach our route
  // parser literally, instead of being resolved away by a URL constructor.
  const res = await rawGet(h.baseUrl, '/assets/ci_20260713_ig_1/../../../../../../../../etc/passwd');
  assert.notEqual(res.status, 200);
  assert.ok(!res.body.includes('root:'));
});

test('GET /assets: static UI is served at /', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.fetchAsset('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const body = await res.text();
  assert.match(body, /autopilot/i);
});
