/**
 * @file Raw Telegram Bot API client (zero-dep: global fetch + FormData + Blob).
 *
 * One thin method per Bot API call the bot uses. Base URL is injectable
 * (config.telegram.apiBase) so tests point it at a localhost fake. Handles 429
 * `retry_after` and transient network errors with bounded backoff; a persistent
 * failure throws (the caller decides whether it's fatal or ledger-retryable).
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export class TelegramApi {
  /**
   * @param {{token:string, apiBase?:string, fetch?:Function, maxRetries?:number,
   *          backoffMs?:number, sleep?:(ms:number)=>Promise<void>}} opts
   */
  constructor({ token, apiBase = 'https://api.telegram.org', fetch = globalThis.fetch, maxRetries = 4, backoffMs = 1000, sleep } = {}) {
    if (!token) throw new Error('TelegramApi: token required');
    this.token = token;
    this.base = `${apiBase.replace(/\/$/, '')}/bot${token}`;
    this._fetch = fetch;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** POST a JSON method, with 429/5xx/network backoff. Returns `result`. */
  async call(method, params = {}) {
    return this._request(method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  /** POST multipart (for media upload). `fields` values may include a Blob. */
  async callMultipart(method, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      form.append(k, typeof v === 'object' && v.blob ? v.blob : v, v && v.filename);
    }
    return this._request(method, { method: 'POST', body: form });
  }

  async _request(method, init) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this._fetch(`${this.base}/${method}`, init);
      } catch (err) {
        lastErr = err;
        await this._sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      let body;
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (res.ok && body.ok) return body.result;

      // 429 → honor retry_after; 5xx → backoff; other → throw (not retryable).
      if (res.status === 429) {
        const wait = (body.parameters?.retry_after ?? 1) * 1000;
        await this._sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`Telegram ${method} ${res.status}: ${body.description || ''}`);
        await this._sleep(this.backoffMs * 2 ** attempt);
        continue;
      }
      const err = new Error(`Telegram ${method} failed (${res.status}): ${body.description || 'unknown'}`);
      err.telegram = body;
      err.status = res.status;
      throw err;
    }
    throw lastErr || new Error(`Telegram ${method}: exhausted retries`);
  }

  /* ------------------------------- methods ------------------------------- */

  getUpdates({ offset, timeout = 50, allowedUpdates } = {}) {
    return this.call('getUpdates', {
      offset,
      timeout,
      allowed_updates: allowedUpdates || ['message', 'callback_query'],
    });
  }

  sendMessage(chatId, text, { keyboard, replyMarkup, forceReply, disablePreview = true } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: disablePreview,
      reply_markup: keyboard || replyMarkup || (forceReply ? { force_reply: true } : undefined),
    });
  }

  answerCallbackQuery(id, { text, showAlert = false } = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
  }

  editMessageReplyMarkup(chatId, messageId, keyboard) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
  }

  async sendVideo(chatId, filePath, { caption, keyboard } = {}) {
    return this._sendMedia('sendVideo', 'video', chatId, filePath, { caption, keyboard });
  }

  async sendPhoto(chatId, filePath, { caption, keyboard } = {}) {
    return this._sendMedia('sendPhoto', 'photo', chatId, filePath, { caption, keyboard });
  }

  async _sendMedia(method, field, chatId, filePath, { caption, keyboard } = {}) {
    const buf = await readFile(filePath);
    const blob = new Blob([buf]);
    return this.callMultipart(method, {
      chat_id: String(chatId),
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard ? JSON.stringify(keyboard) : undefined,
      [field]: { blob, filename: basename(filePath) },
    });
  }
}
