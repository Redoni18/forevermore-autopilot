/**
 * @file Hashing helpers. Runs on the Node runner (Mac/GHA), NOT on CF Workers,
 * so `node:crypto` is safe here (the Workers `createHash` notImplemented gotcha
 * does not apply — see MEMORY: cloudflare-workers-runtime-gotchas).
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 hex of a string or Buffer. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 hex of a file, streamed. @param {string} filePath */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Stable SHA-256 of a JSON-serialisable value (sorted keys). */
export function sha256Json(value) {
  return sha256(stableStringify(value));
}

/** Deterministic JSON.stringify with lexicographically sorted object keys. */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
