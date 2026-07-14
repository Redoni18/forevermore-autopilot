/**
 * @file Discord Gateway client (zero-dep: Node ≥22's global WebSocket).
 *
 * The minimum viable gateway: connect → HELLO (op 10) → IDENTIFY (op 2) →
 * heartbeat on the given interval (op 1 / ack op 11) → surface DISPATCH
 * (op 0) events to the caller. On close/error/op 7/op 9 it reconnects with a
 * fresh IDENTIFY after backoff (no RESUME in v1 — outbound state lives in the
 * DB-driven scanner, so missed gateway events during a gap cost nothing; an
 * inbound message sent during a gap just needs re-sending).
 *
 * Intents: GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT (privileged — toggle it
 * on in the developer portal; unverified bots under 100 servers may).
 */

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;

const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT

export class DiscordGateway {
  /**
   * @param {Object} opts
   * @param {string} opts.token
   * @param {string} [opts.url]  wss gateway url (from /gateway/bot)
   * @param {(event:string, data:Object)=>void} opts.onDispatch
   * @param {(err:Error)=>void} [opts.onError]
   * @param {typeof WebSocket} [opts.WebSocketImpl]  test seam
   * @param {(ms:number)=>Promise<void>} [opts.sleep]
   */
  constructor({ token, url = 'wss://gateway.discord.gg', onDispatch, onError, WebSocketImpl, sleep } = {}) {
    if (!token) throw new Error('DiscordGateway: token required');
    this.token = token;
    this.url = `${url}/?v=10&encoding=json`;
    this.onDispatch = onDispatch || (() => {});
    this.onError = onError || (() => {});
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._ws = null;
    this._seq = null;
    this._hb = null;
    this._stopped = false;
    this._backoff = 1000;
    this.ready = false;
  }

  /** Connect and keep reconnecting until stop(). Resolves on first READY. */
  start() {
    return new Promise((resolveReady) => {
      const connect = () => {
        if (this._stopped) return;
        let ws;
        try {
          ws = new this.WS(this.url);
        } catch (err) {
          this.onError(err);
          this._scheduleReconnect(connect);
          return;
        }
        this._ws = ws;

        ws.addEventListener('message', (ev) => {
          let frame;
          try {
            frame = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (frame.s != null) this._seq = frame.s;

          switch (frame.op) {
            case OP_HELLO: {
              this._startHeartbeat(frame.d.heartbeat_interval);
              this._send({
                op: OP_IDENTIFY,
                d: {
                  token: this.token,
                  intents: INTENTS,
                  properties: { os: process.platform, browser: 'autopilot', device: 'autopilot' },
                },
              });
              break;
            }
            case OP_DISPATCH: {
              if (frame.t === 'READY') {
                this.ready = true;
                this._backoff = 1000;
                resolveReady();
              }
              try {
                this.onDispatch(frame.t, frame.d);
              } catch (err) {
                this.onError(err);
              }
              break;
            }
            case OP_HEARTBEAT: {
              this._send({ op: OP_HEARTBEAT, d: this._seq });
              break;
            }
            case OP_HEARTBEAT_ACK:
              break;
            case OP_RECONNECT:
            case OP_INVALID_SESSION: {
              try {
                ws.close();
              } catch {
                /* closing */
              }
              break;
            }
            default:
              break;
          }
        });

        ws.addEventListener('close', () => {
          this._clearHeartbeat();
          this.ready = false;
          this._scheduleReconnect(connect);
        });
        ws.addEventListener('error', (ev) => {
          this.onError(ev.error || new Error('gateway websocket error'));
          // 'close' follows and drives the reconnect.
        });
      };
      connect();
    });
  }

  _scheduleReconnect(connect) {
    if (this._stopped) return;
    const wait = this._backoff;
    this._backoff = Math.min(this._backoff * 2, 60000);
    this._sleep(wait).then(() => connect());
  }

  _startHeartbeat(intervalMs) {
    this._clearHeartbeat();
    this._hb = setInterval(() => this._send({ op: OP_HEARTBEAT, d: this._seq }), intervalMs);
    if (this._hb.unref) this._hb.unref();
  }

  _clearHeartbeat() {
    if (this._hb) clearInterval(this._hb);
    this._hb = null;
  }

  _send(frame) {
    try {
      this._ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.onError(err);
    }
  }

  stop() {
    this._stopped = true;
    this._clearHeartbeat();
    try {
      this._ws?.close();
    } catch {
      /* already closed */
    }
  }
}
