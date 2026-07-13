/**
 * @file FileStore — the M0 file-mode implementation of the {@link Store}
 * contract (ticket AP-103).
 *
 * Layout (all under the resolved data root):
 *   outbox/<id>/item.json          the ContentItem (PRD §5 file-mode JSON)
 *   outbox/<id>/item.lock          O_EXCL lockfile guarding CAS transitions
 *   outbox/<id>/assets/*           rendered media (written by adapters)
 *   decisions/<id>-<ts>.json       one file per approval/rejection/edit
 *   runs/<runid>.json              one file per run (stage + transition runs)
 *   logs/<runid>.jsonl             structured per-run log lines
 *   settings.json                  kv settings (kill_switch, autonomy…)
 *
 * CAS: {@link FileStore#transition} acquires an exclusive lockfile via
 * `open(..., 'wx')` (O_CREAT|O_EXCL) — the atomic primitive — then compares the
 * on-disk status to the caller's `from` before writing. Two concurrent
 * transitions therefore serialise: one commits, the other reads the already-
 * advanced status and throws {@link CasConflictError}. Writes are atomic
 * (temp file + rename on the same filesystem).
 */

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CasConflictError, LockTimeoutError } from '../types.mjs';
import { nowISO } from '../util/time.mjs';
import { runId as makeRunId, approvalId as makeApprovalId } from '../util/ids.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FileStore {
  /** @param {ReturnType<import('../config.mjs').loadConfig>} config */
  constructor(config) {
    const r = config.resolved;
    this.dirs = {
      outbox: r.outbox,
      decisions: r.decisions,
      runs: r.runs,
      logs: r.logs,
      state: r.state,
    };
    this.settingsPath = r.settings;
    /** Active-rule source for brain injection (AP-831): a JSON array in the data
     *  root, sibling to settings.json. Absent file → no rules (empty default). */
    this.playbookPath = r.playbook || join(dirname(r.settings), 'playbook.json');
    /** lock acquisition tuning (bounded wait so a wedged lock still errors). */
    this.lock = { retries: 200, delayMs: 15 };
  }

  /**
   * Lifecycle parity with PostgresStore (which closes its connection pool).
   * FileStore holds no long-lived handles, so this is a no-op — but callers
   * (CLI, review server) can `await store.close()` uniformly for both modes.
   */
  async close() {
    /* nothing to release in file mode */
  }

  /* ------------------------------ paths ------------------------------ */
  itemDir(id) {
    return join(this.dirs.outbox, id);
  }
  itemPath(id) {
    return join(this.itemDir(id), 'item.json');
  }
  itemLock(id) {
    return join(this.itemDir(id), 'item.lock');
  }

  /* --------------------------- fs primitives --------------------------- */
  async #ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  /** Atomic JSON write: temp file in the same dir, then rename over the target. */
  async #writeJsonAtomic(path, obj) {
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, path);
  }

  async #readJson(path) {
    try {
      return JSON.parse(await fsp.readFile(path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Acquire an exclusive lockfile (O_EXCL). Bounded retry, then throws. */
  async #acquireLock(lockPath) {
    for (let i = 0; i < this.lock.retries; i++) {
      try {
        const fh = await fsp.open(lockPath, 'wx');
        await fh.writeFile(`${process.pid} ${nowISO()}\n`);
        await fh.close();
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        await sleep(this.lock.delayMs);
      }
    }
    throw new LockTimeoutError(lockPath);
  }

  async #releaseLock(lockPath) {
    await fsp.rm(lockPath, { force: true });
  }

  /* ------------------------------ items ------------------------------ */
  /** @param {string} id @returns {Promise<import('../types.mjs').ContentItem|null>} */
  async getItem(id) {
    return this.#readJson(this.itemPath(id));
  }

  /**
   * Create or overwrite an item. Stamps created_at/updated_at when absent.
   * @param {import('../types.mjs').ContentItem} item
   */
  async putItem(item) {
    if (!item || !item.id) throw new Error('putItem: item.id required');
    await this.#ensureDir(this.itemDir(item.id));
    const now = nowISO();
    const record = {
      created_at: now,
      ...item,
      updated_at: now,
    };
    await this.#writeJsonAtomic(this.itemPath(item.id), record);
    return record;
  }

  /**
   * Compare-and-swap transition. Only mutates if the on-disk status equals
   * `from`. @see file-level docs for the locking model.
   * @param {string} id @param {string} from @param {string} to @param {Object} [patch]
   */
  async transition(id, from, to, patch = {}) {
    const dir = this.itemDir(id);
    // The item must already exist to be transitioned.
    const exists = await this.getItem(id);
    if (!exists) throw new Error(`transition: no such item ${id}`);
    await this.#ensureDir(dir);
    const lockPath = this.itemLock(id);
    await this.#acquireLock(lockPath);
    try {
      const item = await this.getItem(id);
      if (!item) throw new Error(`transition: item ${id} vanished under lock`);
      if (item.status !== from) throw new CasConflictError(id, from, item.status);
      const updated = { ...item, ...patch, status: to, updated_at: nowISO() };
      await this.#writeJsonAtomic(this.itemPath(id), updated);
      return updated;
    } finally {
      await this.#releaseLock(lockPath);
    }
  }

  /** @param {(i:import('../types.mjs').ContentItem)=>boolean} [filter] */
  async listItems(filter) {
    let entries;
    try {
      entries = await fsp.readdir(this.dirs.outbox, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const item = await this.getItem(ent.name);
      if (item && (!filter || filter(item))) out.push(item);
    }
    // Stable order: by slot_at then id (deterministic listings/tests).
    out.sort((a, b) => String(a.slot_at).localeCompare(String(b.slot_at)) || a.id.localeCompare(b.id));
    return out;
  }

  /** @param {string|string[]} status */
  async listByStatus(status) {
    const set = new Set(Array.isArray(status) ? status : [status]);
    return this.listItems((i) => set.has(i.status));
  }

  /* ------------------------------ runs ------------------------------ */
  /** @param {Partial<import('../types.mjs').Run>} run */
  async appendRun(run) {
    await this.#ensureDir(this.dirs.runs);
    const id = run.id || makeRunId(run.stage || 'run');
    const record = { id, status: 'running', started_at: nowISO(), ...run };
    if (!record.log_path) record.log_path = join(this.dirs.logs, `${id}.jsonl`);
    await this.#writeJsonAtomic(join(this.dirs.runs, `${id}.json`), record);
    return record;
  }

  /** @param {string} id @param {Partial<import('../types.mjs').Run>} patch */
  async updateRun(id, patch) {
    const path = join(this.dirs.runs, `${id}.json`);
    const cur = (await this.#readJson(path)) || { id };
    const record = { ...cur, ...patch };
    await this.#writeJsonAtomic(path, record);
    return record;
  }

  /**
   * Fetch one run by id (the producing-run join behind item.provenance, AP-831).
   * Missing run file → null (graceful; the review station shows no provenance).
   * @param {string} id @returns {Promise<import('../types.mjs').Run|null>}
   */
  async getRun(id) {
    if (!id) return null;
    return this.#readJson(join(this.dirs.runs, `${id}.json`));
  }

  /** @param {string} runId @param {Object} entry */
  async appendLog(runId, entry) {
    await this.#ensureDir(this.dirs.logs);
    const line = `${JSON.stringify({ ts: nowISO(), ...entry })}\n`;
    await fsp.appendFile(join(this.dirs.logs, `${runId}.jsonl`), line, 'utf8');
  }

  /* ---------------------------- approvals ---------------------------- */
  /** @param {Partial<import('../types.mjs').Approval>} approval */
  async appendApproval(approval) {
    if (!approval.content_item_id) throw new Error('appendApproval: content_item_id required');
    await this.#ensureDir(this.dirs.decisions);
    const id = approval.id || makeApprovalId();
    const record = { id, decided_at: nowISO(), via: 'cli', ...approval };
    const ts = record.decided_at.replace(/[-:.]/g, '').replace('Z', '');
    const file = `${approval.content_item_id}-${ts}-${randomBytes(2).toString('hex')}.json`;
    await this.#writeJsonAtomic(join(this.dirs.decisions, file), record);
    return record;
  }

  /** @param {string} itemId */
  async listApprovals(itemId) {
    let files;
    try {
      files = await fsp.readdir(this.dirs.decisions);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const f of files) {
      if (!f.startsWith(`${itemId}-`) || !f.endsWith('.json')) continue;
      const rec = await this.#readJson(join(this.dirs.decisions, f));
      if (rec) out.push(rec);
    }
    out.sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)));
    return out;
  }

  /* -------------------------- playbook rules -------------------------- */
  /**
   * Active (or other-status) learned rules for brain injection (PRD §8.1),
   * weight-desc. Sourced from `<dataRoot>/playbook.json` (a plain JSON array);
   * an absent/malformed file yields no rules — file mode's empty default.
   * @param {string} [status='active'] @returns {Promise<import('../brain/schema.mjs').PlaybookRule[]>}
   */
  async listPlaybookRules(status = 'active') {
    const raw = await this.#readJson(this.playbookPath);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r === 'object' && (r.status ?? 'active') === status)
      .sort(
        (a, b) =>
          (b.weight ?? 5) - (a.weight ?? 5) ||
          String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
          String(a.id ?? a.rule ?? '').localeCompare(String(b.id ?? b.rule ?? '')),
      );
  }

  /* ----------------------------- settings ----------------------------- */
  async getSettings() {
    return (await this.#readJson(this.settingsPath)) || {};
  }

  /** @param {string} key */
  async getSetting(key) {
    const s = await this.getSettings();
    return s[key];
  }

  /**
   * Read-modify-write a single setting under an exclusive lock so concurrent
   * `setSetting` calls don't clobber each other.
   * @param {string} key @param {*} value
   */
  async setSetting(key, value) {
    await this.#ensureDir(dirname(this.settingsPath));
    const lockPath = `${this.settingsPath}.lock`;
    await this.#acquireLock(lockPath);
    try {
      const s = (await this.#readJson(this.settingsPath)) || {};
      s[key] = value;
      s.updated_at = nowISO();
      await this.#writeJsonAtomic(this.settingsPath, s);
    } finally {
      await this.#releaseLock(lockPath);
    }
  }
}
