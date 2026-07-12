// HTTP layer for the local review station: wires store.mjs (file-mode data)
// and settings.mjs to routes, plus static UI + outbox asset serving.
// `createReviewServer()` returns an unstarted http.Server so tests can bind
// it to an ephemeral port instead of the CLI's fixed default.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, sep } from 'node:path';

import { getMimeType } from './mime.mjs';
import { listGroupedItems, decide, VALID_DECISIONS, REASON_REQUIRED_DECISIONS } from './store.mjs';
import { readSettings } from './settings.mjs';

const MAX_BODY_BYTES = 1_000_000; // 1MB is generous for a caption edit + note

export function createReviewServer({ outboxDir, decisionsDir, settingsPath, publicDir }) {
  if (!outboxDir || !decisionsDir || !settingsPath || !publicDir) {
    throw new Error('createReviewServer requires outboxDir, decisionsDir, settingsPath, publicDir');
  }
  const ctx = { outboxDir, decisionsDir, settingsPath, publicDir };
  return createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      console.error('[autopilot-review] unhandled error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'Unexpected server error.' });
      else res.end();
    });
  });
}

async function handleRequest(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/items') return handleGetItems(req, res, ctx);
  if (req.method === 'POST' && pathname === '/api/decide') return handlePostDecide(req, res, ctx);
  if (req.method === 'GET' && pathname.startsWith('/assets/')) return serveAsset(req, res, ctx.outboxDir, pathname);

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'not_found', message: `No route for ${req.method} ${pathname}` });
  }
  if (req.method === 'GET') return serveStatic(res, ctx.publicDir, pathname);

  send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
}

// --------------------------------------------------------------- responses

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

// -------------------------------------------------------------- /api/items

async function handleGetItems(req, res, ctx) {
  const [{ groups, pending_count }, settings] = await Promise.all([
    listGroupedItems({ outboxDir: ctx.outboxDir, decisionsDir: ctx.decisionsDir }),
    readSettings(ctx.settingsPath),
  ]);
  sendJson(res, 200, { generated_at: new Date().toISOString(), pending_count, settings, groups });
}

// ------------------------------------------------------------- /api/decide

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handlePostDecide(req, res, ctx) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'bad_request', message: err.message });
  }

  const { itemId, decision, reasonTags, note, captionAfter } = body || {};

  if (!itemId || typeof itemId !== 'string') {
    return sendJson(res, 400, { error: 'bad_request', message: 'itemId is required.' });
  }
  if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision)) {
    return sendJson(res, 400, {
      error: 'bad_request',
      message: `decision must be one of: ${[...VALID_DECISIONS].join(', ')}.`,
    });
  }
  const tags = Array.isArray(reasonTags) ? reasonTags.filter((t) => typeof t === 'string' && t.trim()) : [];
  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : null;
  if (REASON_REQUIRED_DECISIONS.has(decision) && tags.length === 0 && !trimmedNote) {
    return sendJson(res, 400, {
      error: 'bad_request',
      message: `"${decision}" requires at least one reason tag or a note.`,
    });
  }

  const result = await decide({
    outboxDir: ctx.outboxDir,
    decisionsDir: ctx.decisionsDir,
    itemId,
    decision,
    reasonTags: tags,
    note: trimmedNote,
    captionAfter: typeof captionAfter === 'string' ? captionAfter : null,
    via: 'local-station',
  });

  if (!result.ok) return sendJson(res, result.status, { error: result.error, message: result.message });
  return sendJson(res, 200, { item: result.item, decision: result.decision, autoSkipped: result.autoSkipped });
}

// ----------------------------------------------------------------- /assets

async function serveAsset(req, res, outboxDir, pathname) {
  const rest = pathname.slice('/assets/'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return send(res, 400, 'text/plain; charset=utf-8', 'bad asset path');

  const itemId = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  if (!itemId || !relPath || itemId.includes('..') || relPath.includes('..')) {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad asset path');
  }

  const itemRoot = normalize(join(outboxDir, itemId));
  const filePath = normalize(join(itemRoot, relPath));
  if (filePath !== itemRoot && !filePath.startsWith(itemRoot + sep)) {
    return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
  if (!stats.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'not found');

  const mime = getMimeType(filePath);
  const range = req.headers.range;

  if (range) return serveRange(res, filePath, stats, mime, range);

  res.writeHead(200, {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': stats.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

function serveRange(res, filePath, stats, mime, range) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const hasStart = match && match[1] !== '';
  const hasEnd = match && match[2] !== '';

  if (!match || (!hasStart && !hasEnd)) {
    res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
    return res.end();
  }

  let start;
  let end;
  if (hasStart && hasEnd) {
    start = parseInt(match[1], 10);
    end = parseInt(match[2], 10);
  } else if (hasStart) {
    start = parseInt(match[1], 10);
    end = stats.size - 1;
  } else {
    const suffixLength = parseInt(match[2], 10);
    start = Math.max(stats.size - suffixLength, 0);
    end = stats.size - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= stats.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Range': `bytes ${start}-${end}/${stats.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

// ------------------------------------------------------------- static UI

async function serveStatic(res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.includes('..')) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');

  const root = normalize(publicDir);
  const filePath = normalize(join(publicDir, rel));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  }

  try {
    const body = await readFile(filePath);
    send(res, 200, getMimeType(filePath), body);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
}
