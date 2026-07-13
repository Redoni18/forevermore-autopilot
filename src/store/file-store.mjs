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
import { nowISO, localDayRange } from '../util/time.mjs';
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
    /** Owner suggestion inbox (AP-834): a JSON array sibling to playbook.json. */
    this.ownerNotesPath = r.ownerNotes || join(dirname(r.settings), 'owner-notes.json');
    /** Telegram send-ledger (Phase 1): a JSON object keyed by dedup_key, sibling
     *  to settings.json. Single-writer by design (the one bot daemon claims +
     *  marks-sent); reads are lock-free, writes go through the shared lockfile. */
    this.telegramMessagesPath = r.telegramMessages || join(dirname(r.settings), 'telegram-messages.json');
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

  /** Read-modify-write the playbook array under an exclusive lock. */
  async #mutatePlaybook(mutate) {
    await this.#ensureDir(dirname(this.playbookPath));
    const lockPath = `${this.playbookPath}.lock`;
    await this.#acquireLock(lockPath);
    try {
      const raw = await this.#readJson(this.playbookPath);
      const rules = Array.isArray(raw) ? raw : [];
      const result = mutate(rules);
      await this.#writeJsonAtomic(this.playbookPath, rules);
      return result;
    } finally {
      await this.#releaseLock(lockPath);
    }
  }

  /**
   * Insert one playbook rule (AP-834: the review station's "teach the
   * autopilot" composer). Owner rules default to ACTIVE — they take effect at
   * the very next generate run and get cited by id in each draft's rationale.
   * @param {{rule:string, category?:string, weight?:number, status?:string, source?:string, evidence?:*}} input
   */
  async insertPlaybookRule(input = {}) {
    if (!input.rule || !String(input.rule).trim()) throw new Error('insertPlaybookRule: rule text required');
    const now = nowISO();
    const status = input.status ?? 'active';
    const record = {
      id: `pr_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`,
      rule: String(input.rule).trim(),
      category: input.category ?? 'caption',
      status,
      source: input.source ?? 'owner',
      evidence: input.evidence ?? null,
      weight: input.weight ?? 6,
      created_at: now,
      decided_at: status === 'proposed' ? null : now,
    };
    await this.#mutatePlaybook((rules) => rules.push(record));
    return record;
  }

  /**
   * Move a rule between statuses (active ⇄ retired, proposed → active).
   * @param {string} id @param {string} status @returns updated rule or null
   */
  async setPlaybookRuleStatus(id, status) {
    return this.#mutatePlaybook((rules) => {
      const rule = rules.find((r) => r && r.id === id);
      if (!rule) return null;
      rule.status = status;
      rule.decided_at = nowISO();
      return { ...rule };
    });
  }

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

  /* ---------------------------- owner notes ---------------------------- */

  /**
   * Drop a free-form owner suggestion into the inbox (AP-834). Notes are the
   * unstructured channel — the reflect stage parses them into proposed rules;
   * until then they're at least captured, visible, and timestamped.
   * @param {string} text
   */
  async insertOwnerNote(text) {
    if (!text || !String(text).trim()) throw new Error('insertOwnerNote: text required');
    const now = nowISO();
    const record = {
      id: `on_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`,
      text: String(text).trim(),
      applies_from: null,
      processed: false,
      processed_at: null,
      created_at: now,
    };
    await this.#ensureDir(dirname(this.ownerNotesPath));
    const lockPath = `${this.ownerNotesPath}.lock`;
    await this.#acquireLock(lockPath);
    try {
      const raw = await this.#readJson(this.ownerNotesPath);
      const notes = Array.isArray(raw) ? raw : [];
      notes.push(record);
      await this.#writeJsonAtomic(this.ownerNotesPath, notes);
    } finally {
      await this.#releaseLock(lockPath);
    }
    return record;
  }

  /** Owner notes, newest first. @param {number} [limit=50] */
  async listOwnerNotes(limit = 50) {
    const raw = await this.#readJson(this.ownerNotesPath);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((n) => n && typeof n === 'object')
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, limit);
  }

  /* ----------------------------- run listing ----------------------------- */

  /**
   * Recent runs, newest first, for the review station's activity feed
   * (AP-834). Transition audit rows are excluded by default — they narrate
   * every status hop and would drown the stage-level story.
   * @param {{limit?:number, excludeStages?:string[]}} [opts]
   */
  async listRuns(opts = {}) {
    const { limit = 50, excludeStages = ['transition'] } = opts;
    let files;
    try {
      files = await fsp.readdir(this.dirs.runs);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const excluded = new Set(excludeStages);
    const runs = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rec = await this.#readJson(join(this.dirs.runs, f));
      if (!rec || typeof rec !== 'object') continue;
      const base = String(rec.stage || '').split(':')[0];
      if (excluded.has(base) || String(rec.stage || '').includes('transition')) continue;
      runs.push(rec);
    }
    runs.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
    return runs.slice(0, limit);
  }

  /* ------------------------- telegram send-ledger ------------------------- */

  /** Read-modify-write the dedup_key→record map under an exclusive lock. */
  async #mutateTelegram(mutate) {
    await this.#ensureDir(dirname(this.telegramMessagesPath));
    const lockPath = `${this.telegramMessagesPath}.lock`;
    await this.#acquireLock(lockPath);
    try {
      const raw = await this.#readJson(this.telegramMessagesPath);
      const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const result = mutate(map);
      await this.#writeJsonAtomic(this.telegramMessagesPath, map);
      return result;
    } finally {
      await this.#releaseLock(lockPath);
    }
  }

  /**
   * Claim a ledger slot for an outbound event (Phase 1 §1 "claim-then-send").
   * Atomic insert-or-conflict on dedup_key: the FIRST caller for a key claims
   * it (message_id null = not yet sent) and gets {claimed:true}; any later
   * caller for the same key gets {claimed:false} and the EXISTING record (so a
   * scanner can see whether it was already sent). Single-writer assumption: the
   * lone bot daemon is the only writer, and the lockfile serialises even it.
   * item_id is the file-mode SLUG verbatim (file mode is slug-native).
   * @param {{kind:string, dedup_key:string, item_id?:string|null, item_status?:string|null,
   *   attempt?:number|null, chat_id:number, payload?:*}} record
   * @returns {Promise<{claimed:boolean, record:Object}>}
   */
  async tgClaim(record = {}) {
    if (!record.dedup_key) throw new Error('tgClaim: dedup_key required');
    if (record.chat_id == null) throw new Error('tgClaim: chat_id required');
    const now = nowISO();
    return this.#mutateTelegram((map) => {
      const existing = map[record.dedup_key];
      if (existing) return { claimed: false, record: existing };
      const row = {
        id: `tg_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`,
        kind: record.kind,
        dedup_key: record.dedup_key,
        item_id: record.item_id ?? null,
        item_status: record.item_status ?? null,
        attempt: record.attempt ?? null,
        chat_id: record.chat_id,
        message_id: null,
        payload: record.payload ?? null,
        sent_at: null,
        created_at: now,
      };
      map[record.dedup_key] = row;
      return { claimed: true, record: row };
    });
  }

  /**
   * Mark a claimed row as sent (records the Telegram message_id + send time).
   * @param {string} dedupKey @param {{message_id:number, sent_at?:string}} sent
   * @returns {Promise<Object|null>} the updated record, or null if unknown key.
   */
  async tgMarkSent(dedupKey, { message_id, sent_at } = {}) {
    return this.#mutateTelegram((map) => {
      const row = map[dedupKey];
      if (!row) return null;
      row.message_id = message_id ?? null;
      row.sent_at = sent_at ?? nowISO();
      return { ...row };
    });
  }

  /**
   * Resolve a Telegram (chat_id, message_id) back to its ledger record — the
   * reply-to-card lookup. Returns the record (item_id is the slug) or null.
   * @param {number} chatId @param {number} messageId
   */
  async tgFindByMessage(chatId, messageId) {
    const raw = await this.#readJson(this.telegramMessagesPath);
    if (!raw || typeof raw !== 'object') return null;
    for (const row of Object.values(raw)) {
      if (row && row.chat_id === chatId && row.message_id === messageId) return { ...row };
    }
    return null;
  }

  /**
   * Claimed-but-unsent records (message_id null) older than the threshold — the
   * crash-safe resend queue (a claim that died mid-send). Sorted created_at asc.
   * @param {{olderThanMs?:number, now?:number|Date}} [opts]
   */
  async tgListUnsent({ olderThanMs = 0, now = Date.now() } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const cutoff = new Date(nowMs - olderThanMs).toISOString();
    const raw = await this.#readJson(this.telegramMessagesPath);
    if (!raw || typeof raw !== 'object') return [];
    return Object.values(raw)
      .filter((r) => r && r.message_id == null && String(r.created_at) < cutoff)
      .map((r) => ({ ...r }))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  /* ------------------------------ daily spend ------------------------------ */

  /**
   * Total `cost_usd` across all runs whose `started_at` falls on the given
   * LOCAL calendar date (`YYYY-MM-DD`) — the spend-cap accounting. A run belongs
   * to the date iff its start instant is within that local day (see
   * {@link localDayRange}); null costs count as 0. @param {string} dateIso
   */
  async dailySpend(dateIso) {
    const { start, end } = localDayRange(dateIso);
    let files;
    try {
      files = await fsp.readdir(this.dirs.runs);
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
    let total = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rec = await this.#readJson(join(this.dirs.runs, f));
      if (!rec || typeof rec !== 'object' || rec.started_at == null) continue;
      const started = new Date(rec.started_at).toISOString();
      if (started >= start && started < end && typeof rec.cost_usd === 'number') total += rec.cost_usd;
    }
    return total;
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
