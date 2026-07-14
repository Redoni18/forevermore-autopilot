/**
 * @file Raw Discord REST client (zero-dep: global fetch + FormData + Blob).
 *
 * Speaks just enough of the v10 REST API for the control channel: channel
 * messages (text, attachments, components), message edits, and interaction
 * callbacks. Base URL injectable (config.discord.apiBase) so tests point it at
 * a localhost fake. Handles 429 rate limits (retry_after) and 5xx/network with
 * bounded backoff.
 *
 * IDs are Discord snowflakes (~19 digits > 2^53) — they are STRINGS everywhere
 * in JS; never Number() them (precision loss corrupts the reply-to-card
 * mapping). The ledger's bigint columns take the strings fine.
 *
 * The send* methods mirror the transport interface the scanner (control/
 * notify.mjs) expects: sendMessage/sendVideo/sendPhoto(channelId, …) →
 * {message_id}. Buttons come in as the neutral {label, itemId, action}|{label,
 * url} list from control/cards.mjs and become component rows here.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { encodeDecision } from '../control/callbacks.mjs';

const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_LINK = 5;

/** Neutral button list → Discord component rows (≤5 buttons per row). */
export function toComponents(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const items = buttons.map((b) =>
    b.url
      ? { type: 2, style: BUTTON_STYLE_LINK, label: b.label, url: b.url }
      : { type: 2, style: BUTTON_STYLE_SECONDARY, label: b.label, custom_id: encodeDecision(b.itemId, b.action) },
  );
  const rows = [];
  for (let i = 0; i < items.length; i += 5) rows.push({ type: 1, components: items.slice(i, i + 5) });
  return rows;
}

export class DiscordApi {
  /**
   * @param {{token:string, apiBase?:string, fetch?:Function, maxRetries?:number,
   *          backoffMs?:number, sleep?:(ms:number)=>Promise<void>}} opts
   */
  constructor({ token, apiBase = 'https://discord.com/api/v10', fetch = globalThis.fetch, maxRetries = 4, backoffMs = 1000, sleep } = {}) {
    if (!token) throw new Error('DiscordApi: token required');
    this.token = token;
    this.base = apiBase.replace(/\/$/, '');
    this._fetch = fetch;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async _request(method, path, { json, form, auth = true } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this._fetch(`${this.base}${path}`, {
          method,
          headers: {
            ...(auth ? { authorization: `Bot ${this.token}` } : {}),
            ...(json ? { 'content-type': 'application/json' } : {}),
          },
          body: json ? JSON.stringify(json) : form,
        });
      } catch (err) {
        lastErr = err;
        await this._sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return null;
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.ok) return body;

      if (res.status === 429) {
        const wait = Math.ceil(((body && body.retry_after) || 1) * 1000);
        await this._sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`Discord ${method} ${path} ${res.status}`);
        await this._sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      const err = new Error(`Discord ${method} ${path} failed (${res.status}): ${body ? body.message : 'unknown'}`);
      err.status = res.status;
      err.discord = body;
      throw err;
    }
    throw lastErr || new Error(`Discord ${method} ${path}: exhausted retries`);
  }

  /* --------------------------- transport interface --------------------------- */

  /** Send a text message (+ buttons). Returns {message_id} (string snowflake). */
  async sendMessage(channelId, text, { buttons, replyToMessageId } = {}) {
    const msg = await this._request('POST', `/channels/${channelId}/messages`, {
      json: {
        content: text,
        components: toComponents(buttons),
        ...(replyToMessageId ? { message_reference: { message_id: String(replyToMessageId) } } : {}),
        allowed_mentions: { parse: [] },
      },
    });
    return { message_id: String(msg.id) };
  }

  sendVideo(channelId, filePath, opts = {}) {
    return this._sendAttachment(channelId, filePath, opts);
  }

  sendPhoto(channelId, filePath, opts = {}) {
    return this._sendAttachment(channelId, filePath, opts);
  }

  async _sendAttachment(channelId, filePath, { caption, buttons } = {}) {
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content: caption || '',
        components: toComponents(buttons),
        attachments: [{ id: 0, filename: basename(filePath) }],
        allowed_mentions: { parse: [] },
      }),
    );
    form.append('files[0]', new Blob([buf]), basename(filePath));
    const msg = await this._request('POST', `/channels/${channelId}/messages`, { form });
    return { message_id: String(msg.id) };
  }

  /** Replace a message's components (freeze buttons after a decision). */
  editMessageComponents(channelId, messageId, buttons) {
    return this._request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      json: { components: toComponents(buttons) ?? [] },
    });
  }

  /**
   * Acknowledge an interaction (button tap) with an ephemeral text response.
   * type 4 = CHANNEL_MESSAGE_WITH_SOURCE; flags 64 = ephemeral.
   */
  respondToInteraction(interactionId, interactionToken, text) {
    return this._request('POST', `/interactions/${interactionId}/${interactionToken}/callback`, {
      json: { type: 4, data: { content: text, flags: 64 } },
      auth: false, // interaction callbacks authenticate via the token in the path
    });
  }

  /** The gateway websocket URL (cacheable; falls back to the well-known host). */
  async getGatewayUrl() {
    try {
      const res = await this._request('GET', '/gateway/bot', {});
      return res.url;
    } catch {
      return 'wss://gateway.discord.gg';
    }
  }
}
