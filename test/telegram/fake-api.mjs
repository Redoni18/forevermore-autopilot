/**
 * @file A localhost fake Telegram Bot API for integration tests.
 *
 * Boots an http server on an ephemeral port that speaks just enough Bot API for
 * the daemon: getUpdates drains a queued list, send* capture their calls. Point
 * TelegramApi at its base URL. No network, no real bot.
 */

import http from 'node:http';

export class FakeTelegram {
  constructor() {
    this.updateQueue = [];
    this.sent = []; // {method, params}
    this._nextMsgId = 1000;
    this.server = null;
  }

  /** Queue updates the next getUpdates will return (once). */
  enqueue(...updates) {
    this.updateQueue.push(...updates);
  }

  /** Convenience: a text message from a chat. */
  message(chatId, text, extra = {}) {
    this.enqueue({ update_id: this._nextMsgId++, message: { chat: { id: chatId }, from: { id: chatId }, text, ...extra } });
  }

  /** Convenience: a callback_query (button tap). */
  callback(chatId, data, messageId = 1) {
    this.enqueue({
      update_id: this._nextMsgId++,
      callback_query: { id: `cb${this._nextMsgId}`, data, from: { id: chatId }, message: { chat: { id: chatId }, message_id: messageId } },
    });
  }

  sentOf(method) {
    return this.sent.filter((s) => s.method === method);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const method = req.url.split('/').pop().split('?')[0];
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        let params = {};
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try {
            params = JSON.parse(raw || '{}');
          } catch {
            params = {};
          }
        } else {
          params = { _multipart: true }; // media upload — body is FormData
        }
        this._respond(method, params, res);
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  _respond(method, params, res) {
    let result;
    if (method === 'getUpdates') {
      result = this.updateQueue;
      this.updateQueue = [];
    } else {
      this.sent.push({ method, params });
      result = { message_id: this._nextMsgId++ };
      if (method === 'answerCallbackQuery') result = true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
