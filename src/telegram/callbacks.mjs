/**
 * @file Inline-keyboard callback_data codec (pure).
 *
 * Telegram caps callback_data at 64 BYTES. We encode a decision as
 * `d:<itemId>:<a|c|s>` — even a 36-char uuid id yields ~40 bytes, well under
 * the limit, so raw ids are safe here (WAVE2 Phase 1 decision: no link_nonces;
 * the chat is owner-allowlisted and decide()'s CAS 409 gives double-tap
 * safety). Parsing is strict: anything malformed returns null (ignored + logged
 * by the router) rather than throwing.
 */

/** decision button → single-char code embedded in callback_data. */
const ACTION_CODE = { approve: 'a', changes: 'c', skip: 's' };
const CODE_ACTION = { a: 'approve', c: 'changes', s: 'skip' };

/** Bytes a callback_data string will occupy (UTF-8). */
export function callbackByteLength(data) {
  return Buffer.byteLength(String(data), 'utf8');
}

/**
 * Build callback_data for a decision button.
 * @param {string} itemId  content-item id (slug or uuid)
 * @param {'approve'|'changes'|'skip'} action
 * @returns {string}
 * @throws if the result would exceed Telegram's 64-byte limit.
 */
export function encodeDecision(itemId, action) {
  const code = ACTION_CODE[action];
  if (!code) throw new Error(`encodeDecision: unknown action "${action}"`);
  if (typeof itemId !== 'string' || !itemId) throw new Error('encodeDecision: itemId required');
  const data = `d:${itemId}:${code}`;
  if (callbackByteLength(data) > 64) {
    throw new Error(`callback_data exceeds 64 bytes (${callbackByteLength(data)}): ${data}`);
  }
  return data;
}

/**
 * Parse callback_data back into a decision.
 * @param {string} data
 * @returns {{itemId:string, action:'approve'|'changes'|'skip'}|null}
 */
export function parseCallback(data) {
  if (typeof data !== 'string') return null;
  // Split into exactly 3 parts — the id itself never contains ':' (slugs are
  // ci_<date>_<platform>_<n>; uuids use '-'), so a strict 3-field split is safe.
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'd') return null;
  const [, itemId, code] = parts;
  const action = CODE_ACTION[code];
  if (!itemId || !action) return null;
  return { itemId, action };
}
