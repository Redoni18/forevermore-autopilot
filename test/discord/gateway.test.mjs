// Gateway handshake unit test with a stub WebSocket (no network): HELLO →
// IDENTIFY, heartbeat on interval, READY resolves start(), DISPATCH surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordGateway } from '../../src/discord/gateway.mjs';

/** Minimal EventTarget-shaped fake WebSocket the gateway drives. */
class StubWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this._listeners = {};
    StubWS.last = this;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) fn(ev);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this._emit('close', {});
  }
  /** Simulate the server pushing a frame. */
  server(frame) {
    this._emit('message', { data: JSON.stringify(frame) });
  }
}

test('HELLO triggers IDENTIFY with the right intents; READY resolves start()', async () => {
  const dispatched = [];
  const gw = new DiscordGateway({
    token: 'tok',
    WebSocketImpl: StubWS,
    onDispatch: (t, d) => dispatched.push([t, d]),
  });
  const started = gw.start();
  const ws = StubWS.last;

  ws.server({ op: 10, d: { heartbeat_interval: 45000 } }); // HELLO
  const identify = ws.sent.find((f) => f.op === 2);
  assert.ok(identify, 'IDENTIFY sent after HELLO');
  assert.equal(identify.d.token, 'tok');
  // GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | MESSAGE_CONTENT(1<<15) = 1 + 512 + 32768
  assert.equal(identify.d.intents, 1 + 512 + 32768);

  ws.server({ op: 0, t: 'READY', s: 1, d: { session_id: 's' } });
  await started; // resolves on READY

  ws.server({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { content: 'hi' } });
  assert.deepEqual(dispatched.at(-1), ['MESSAGE_CREATE', { content: 'hi' }]);
  gw.stop();
});

test('a server heartbeat request (op 1) is answered immediately', async () => {
  const gw = new DiscordGateway({ token: 't', WebSocketImpl: StubWS, onDispatch: () => {} });
  gw.start();
  const ws = StubWS.last;
  ws.server({ op: 10, d: { heartbeat_interval: 999999 } });
  ws.server({ op: 1, s: 7 }); // server asks for a heartbeat
  const hb = ws.sent.filter((f) => f.op === 1);
  assert.ok(hb.length >= 1, 'responded with op 1 heartbeat');
  assert.equal(hb.at(-1).d, 7, 'heartbeat carries the last seq');
  gw.stop();
});

test('stop() prevents reconnect after close', async () => {
  const gw = new DiscordGateway({ token: 't', WebSocketImpl: StubWS, onDispatch: () => {}, sleep: () => Promise.resolve() });
  gw.start();
  const first = StubWS.last;
  gw.stop();
  first.close();
  // No new socket should have been created after stop().
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(StubWS.last, first, 'no reconnect socket created after stop()');
});
