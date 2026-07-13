/**
 * Poster render harness (AP-203 contract, RECONSTRUCTED 2026-07-13 after the
 * kit loss — owner review pending).
 *
 * Exports (the autopilot adapter + test/render-export.test.mjs contract):
 *   - SIZES        named viewport/PNG sizes
 *   - JOBS         the 17 CLI poster jobs (batch brand posters)
 *   - serve()      boot a static server over posters/ (ephemeral port)
 *   - renderOne(job, opts) / renderJobs(jobs, opts)
 *                  screenshot job.page with job.params at SIZES[job.size]
 *
 * Importing this module is SIDE-EFFECT-FREE (no browser launch, no server) —
 * the CLI only runs under `node render.mjs`. The browser is playwright-core's
 * chromium API driving a real Brave/Chromium binary: callers (the poster
 * adapter) inject `chromium` + `brave`; the CLI resolves them itself.
 *
 * Templates read their params from the query string and set
 * `window.__READY = true` once fonts + images have settled; renderJobs waits
 * on that flag before screenshotting.
 */

import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const POSTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'posters');

/** Named sizes: [width, height] px. */
export const SIZES = {
  feed: [1080, 1350],
  story: [1080, 1920],
  og: [1200, 630],
};

/* ----------------------------------- JOBS ---------------------------------- */

// Approved brand verbatims (kit/00-brand/brand-guide.md) as batch posters.
const TAGLINES = [
  { key: 'one-message', line: 'Someone you love is one message away.', sub: '' },
  { key: 'whole-world', line: 'Give them a whole world.', sub: 'not a card. a place.' },
  { key: 'theirs-forever', line: "Pay once. It's theirs forever.", sub: 'no app. no account. no download.' },
  { key: 'camera-roll', line: "it's 6pm. dinner is at 10. you have $15 and a camera roll.", sub: '' },
];
// Flagship worlds with committed thumbs (assets/thumbs/<slug>.webp).
const FLAGSHIP_WORLDS = [
  { slug: 'blockheart-mine', name: 'The Blockheart Mine', tier: 'premium' },
  { slug: 'gone-fishing', name: 'Gone Fishing', tier: 'standard' },
  { slug: 'love-letters', name: 'Love Letters', tier: 'standard' },
  { slug: 'prize-claw', name: 'The Prize Claw', tier: 'standard' },
];

/** The 17 CLI jobs: 4 taglines × (feed+story) + 1 og + 4 worlds × (feed+story). */
export const JOBS = [
  ...TAGLINES.flatMap(({ key, line, sub }, i) => [
    {
      out: `quote-${key}-feed.png`,
      page: 'quote-card.html',
      size: 'feed',
      params: { line, sub, hl: '', mascot: ['gift', 'album', 'book'][i % 3] },
    },
    {
      out: `quote-${key}-story.png`,
      page: 'quote-card.html',
      size: 'story',
      params: { line, sub, hl: '', mascot: ['gift', 'album', 'book'][i % 3] },
    },
  ]),
  {
    out: 'quote-one-message-og.png',
    page: 'quote-card.html',
    size: 'og',
    params: { line: 'Someone you love is one message away.', sub: '', hl: '', mascot: 'gift' },
  },
  ...FLAGSHIP_WORLDS.flatMap(({ slug, name, tier }) => [
    {
      out: `world-${slug}-feed.png`,
      page: 'world-drop.html',
      size: 'feed',
      params: { world: slug, name, tier, line: 'built for one person. theirs to keep.' },
    },
    {
      out: `world-${slug}-story.png`,
      page: 'world-drop.html',
      size: 'story',
      params: { world: slug, name, tier, line: 'built for one person. theirs to keep.' },
    },
  ]),
];

/* ---------------------------------- serve ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * Static file server over posters/. Resolves on `listening`; caller closes.
 * @param {{port?: number}} [opts]
 * @returns {Promise<import('node:http').Server>}
 */
export function serve({ port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      const file = join(POSTERS_DIR, rel);
      if (!file.startsWith(POSTERS_DIR) || rel.includes('..')) {
        res.writeHead(403).end();
        return;
      }
      const body = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/* --------------------------------- rendering -------------------------------- */

/**
 * Render jobs into PNGs.
 * @param {Array<{out:string,page:string,params:Object,size:string}>} jobs
 * @param {{chromium:Object, outDir:string, quiet?:boolean, brave?:string}} opts
 *   `chromium` is playwright-core's chromium; `brave` the browser binary path.
 */
export async function renderJobs(jobs, { chromium, outDir, quiet = false, brave } = {}) {
  if (!chromium) throw new Error('renderJobs: opts.chromium (playwright-core chromium) is required');
  if (!outDir) throw new Error('renderJobs: opts.outDir is required');
  await fsp.mkdir(outDir, { recursive: true });

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({
    headless: true,
    ...(brave ? { executablePath: brave } : {}),
    args: ['--force-color-profile=srgb', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    for (const job of jobs) {
      const [width, height] = SIZES[job.size] || SIZES.feed;
      await page.setViewportSize({ width, height });
      const qs = new URLSearchParams(
        Object.entries(job.params || {}).filter(([, v]) => v !== undefined && v !== null),
      );
      await page.goto(`http://127.0.0.1:${port}/${job.page}?${qs}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__READY === true', undefined, { timeout: 15000 });
      await page.screenshot({ path: join(outDir, job.out) });
      if (!quiet) console.log(`✓ ${job.out} (${width}×${height})`);
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

/** Render a single job. */
export function renderOne(job, opts) {
  return renderJobs([job], opts);
}

/* ------------------------------------ CLI ----------------------------------- */

async function cliMain() {
  const outDir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'renders');
  const { chromium } = await import('playwright-core');
  const brave =
    process.env.AUTOPILOT_BRAVE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  console.log(`rendering ${JOBS.length} jobs → ${outDir}`);
  await renderJobs(JOBS, { chromium, outDir, brave });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
