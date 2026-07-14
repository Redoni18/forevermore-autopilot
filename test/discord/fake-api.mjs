/**
 * @file A localhost fake Discord REST API for integration tests.
 *
 * Speaks just enough v10 REST for the daemon: channel message create (JSON +
 * multipart), message PATCH (component edits), interaction callbacks. Point
 * DiscordApi's apiBase at its base URL. Inbound (gateway) events don't come
 * through here — tests call the router/toNeutralEvent directly or inject a
 * stub gateway.
 */

import http from 'node:http';

export class FakeDiscord {
  constructor() {
    this.sent = []; // { method, path, kind, body }
    this._nextId = 5000_0000_0000_0000_000n; // snowflake-sized (> 2^53)
    this.server = null;
  }

  nextId() {
    this._nextId += 1n;
    return this._nextId.toString();
  }

  /** All captured message-create calls (JSON + multipart). */
  messages() {
    return this.sent.filter((s) => s.kind === 'message.create');
  }

  edits() {
    return this.sent.filter((s) => s.kind === 'message.edit');
  }

  interactionResponses() {
    return this.sent.filter((s) => s.kind === 'interaction.callback');
  }

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = Buffer.alloc(0);
      req.on('data', (d) => (raw = Buffer.concat([raw, d])));
      req.on('end', () => {
        const ct = req.headers['content-type'] || '';
        let body = null;
        if (ct.includes('application/json')) {
          try {
            body = JSON.parse(raw.toString('utf8') || 'null');
          } catch {
            body = null;
          }
        } else if (ct.includes('multipart/form-data')) {
          // Enough parsing to recover payload_json for assertions.
          const text = raw.toString('latin1');
          const m = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
          body = { multipart: true, payload: m ? JSON.parse(m[1]) : null };
        }

        const { pathname } = new URL(req.url, 'http://localhost');
        let kind = 'other';
        let result = {};
        if (/^\/channels\/\d+\/messages$/.test(pathname) && req.method === 'POST') {
          kind = 'message.create';
          result = { id: this.nextId(), channel_id: pathname.split('/')[2] };
        } else if (/^\/channels\/\d+\/messages\/\d+$/.test(pathname) && req.method === 'PATCH') {
          kind = 'message.edit';
          result = { id: pathname.split('/')[4] };
        } else if (/^\/interactions\//.test(pathname) && req.method === 'POST') {
          kind = 'interaction.callback';
          res.writeHead(204).end();
          this.sent.push({ method: req.method, path: pathname, kind, body });
          return;
        } else if (pathname === '/gateway/bot') {
          kind = 'gateway';
          result = { url: 'wss://gateway.invalid' };
        }
        this.sent.push({ method: req.method, path: pathname, kind, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
