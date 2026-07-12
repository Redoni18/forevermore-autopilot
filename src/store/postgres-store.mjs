/**
 * @file PostgresStore — the DB-backed implementation of the {@link Store}
 * contract (ticket AP-812), replacing the M1 SupabaseStore stub. It talks
 * directly to Autopilot's OWN control-plane Postgres (never the platform's
 * database — ADR-001) via the pure-JS `postgres` (porsager) driver, and is
 * behaviourally identical to {@link FileStore}: same method signatures, same
 * CAS semantics, same error shapes (CasConflictError on a status mismatch).
 *
 * ── The slug ↔ uuid bridge ────────────────────────────────────────────────
 * The live schema (db/migrations/0001) keys content_items / runs / approvals
 * on `uuid`, and content_items.candidate_group / produced_by / regen_of are
 * uuids too. The file-mode contract (src/types.mjs, the outbox, the review
 * station, the importer) uses DETERMINISTIC SLUG ids instead
 * ("ci_20260714_ig_1", "cg_20260714_ig", "run_…"). To keep the file-mode
 * contract roundtripping faithfully through the uuid-keyed schema — the whole
 * point of the FileStore→PostgresStore swap being "a config flip, not a
 * rewrite" — this store:
 *
 *   • derives the uuid primary key deterministically as uuid5(slug) when the
 *     caller-supplied id is not already a uuid, so putItem/importer re-runs
 *     upsert idempotently onto the same row;
 *   • persists the ORIGINAL slug ids (id / candidate_group / produced_by /
 *     regen_of, whichever are slugs) in a reserved `overlays.__fileids`
 *     envelope, and strips that envelope on read so callers only ever see a
 *     pristine ContentItem while getItem/listByStatus still return the slug
 *     ids that the outbox dir (outbox/<slug>/assets…) and the review station
 *     depend on.
 *
 * FK-referenced uuid columns that would point at rows that may not exist
 * (produced_by → runs, regen_of → content_items) are stored NULL in the
 * column (the true slug is preserved in the envelope) to avoid a foreign-key
 * violation on import of historical file-mode provenance. candidate_group has
 * no FK, so its uuid5 IS written to the column too (siblings share a slug →
 * share a uuid5), keeping DB-side grouping meaningful.
 *
 * ── On-disk artefacts ─────────────────────────────────────────────────────
 * Assets stay ON DISK under outbox/<slug>/assets exactly as in file mode; the
 * DB row only carries the assets[] descriptors (relative paths). Per-run logs
 * likewise stay on disk under the logs dir. The store takes {dbUrl, outboxDir,
 * logsDir} so anything that needs to locate media/logs still can.
 */

import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { CasConflictError } from '../types.mjs';
import { nowISO } from '../util/time.mjs';

/* ------------------------------- uuid5 bridge ------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed namespace for deriving stable uuid5 keys from Autopilot file-mode slug ids. */
const FILE_ID_NAMESPACE = '9f2b1c74-3e5a-4d81-b6c2-0e1a2b3c4d5e';

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToUuid(b) {
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const NS_BYTES = uuidToBytes(FILE_ID_NAMESPACE);

/** RFC-4122 v5 (SHA-1) uuid from a name in the Autopilot file-id namespace. */
function uuid5(name) {
  const hash = createHash('sha1')
    .update(Buffer.concat([NS_BYTES, Buffer.from(String(name), 'utf8')]))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  return bytesToUuid(bytes);
}

/** Is `s` already a canonical uuid? (Then we store it verbatim; else uuid5 it.) */
function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Map a caller id (slug OR uuid) to its uuid primary/foreign key. */
function toPk(idLike) {
  return isUuid(idLike) ? idLike.toLowerCase() : uuid5(idLike);
}

/* ------------------------------ value coercion ----------------------------- */

/** timestamptz Date (postgres.js) or string → ISO string; null → null. */
function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

const JSONB_COLS = new Set(['overlays', 'assets', 'lint', 'dedupe']);
const UUID_COLS = new Set(['candidate_group', 'produced_by', 'regen_of']);
const ENUM_COLS = { platform: 'ap_platform', format: 'ap_format', risk: 'ap_risk', status: 'ap_status' };
/** content_items columns a `transition` patch is allowed to set (id/created_at excluded). */
const UPDATABLE = new Set([
  'slot_at', 'platform', 'format', 'idea_id', 'series_key', 'pillar', 'risk', 'status',
  'candidate_group', 'chosen', 'caption', 'hashtags', 'overlays', 'link_utm', 'assets',
  'lint', 'dedupe', 'produced_by', 'attempt', 'regen_of', 'regen_count', 'publish_attempts',
  'next_attempt_at',
]);
/** runs columns (everything else on a Run object — item_id/from/to/note/parent_run/… — has no home here). */
const RUN_COLS = new Set([
  'stage', 'status', 'driver', 'model', 'prompt_sha', 'tokens_in', 'tokens_out',
  'cost_usd', 'started_at', 'finished_at', 'error', 'log_path',
]);
/** runs.stage CHECK vocabulary (db/migrations/0001). */
const RUN_STAGES = new Set([
  'plan', 'generate', 'render', 'qa', 'digest', 'publish', 'metrics', 'reflect', 'report', 'transition',
]);

/**
 * Normalise a stage label to satisfy the runs.stage CHECK. The state machine
 * writes compound labels for audit rows ("approve:transition", "regen:transition",
 * "transition:transition"); those all collapse to the canonical 'transition'.
 */
function normalizeStage(stage) {
  const s = String(stage || '').trim();
  if (RUN_STAGES.has(s)) return s;
  const base = s.split(':')[0];
  if (RUN_STAGES.has(base)) return base;
  return 'transition';
}

export class PostgresStore {
  /** @param {ReturnType<import('../config.mjs').loadConfig>} config */
  constructor(config) {
    const r = config.resolved || {};
    this.dbUrl = r.dbUrl || config.dbUrl || process.env.AUTOPILOT_DB_URL || null;
    if (!this.dbUrl) {
      throw new Error(
        'PostgresStore: no database URL. Set config "dbUrl" or env AUTOPILOT_DB_URL ' +
          '(store="postgres" needs Autopilot\'s own control-plane Postgres — never the platform DB).',
      );
    }
    this.outboxDir = r.outbox || null; // assets live on disk here (review streaming)
    this.logsDir = r.logs || null; // per-run JSONL logs live on disk here
    this.sql = postgres(this.dbUrl, { max: 5, onnotice: () => {}, prepare: true });
  }

  /* --------------------------------- items --------------------------------- */

  /** @param {string} id @returns {Promise<import('../types.mjs').ContentItem|null>} */
  async getItem(id) {
    const rows = await this.sql`select * from autopilot.content_items where id = ${toPk(id)}`;
    return rows.count ? this.#rowToItem(rows[0], id) : null;
  }

  /**
   * Create or overwrite an item (upsert on the uuid PK). Stamps created_at /
   * updated_at when absent, matching FileStore.
   * @param {import('../types.mjs').ContentItem} item
   */
  async putItem(item) {
    if (!item || !item.id) throw new Error('putItem: item.id required');
    const now = nowISO();
    const pk = toPk(item.id);

    // Build the reserved slug envelope (only the non-uuid ids need preserving).
    const fileids = {};
    if (!isUuid(item.id)) fileids.id = item.id;
    if (item.candidate_group && !isUuid(item.candidate_group)) fileids.candidate_group = item.candidate_group;
    if (item.produced_by && !isUuid(item.produced_by)) fileids.produced_by = item.produced_by;
    if (item.regen_of && !isUuid(item.regen_of)) fileids.regen_of = item.regen_of;

    const overlays = { ...(item.overlays || {}) };
    delete overlays.__fileids;
    if (Object.keys(fileids).length) overlays.__fileids = fileids;
    // feedback rides the same reserved-envelope pattern (no dedicated column;
    // the review station's changes_requested patch must survive postgres mode
    // so the regen path can inject it into the brain — AP-815 fix).
    delete overlays.__feedback;
    if (item.feedback != null) overlays.__feedback = item.feedback;

    const candidateGroup = item.candidate_group ? toPk(item.candidate_group) : null;
    // FK columns: keep null when the reference is a file-mode slug (true value
    // preserved in the envelope) so we never violate the runs/content_items FKs.
    const producedBy = isUuid(item.produced_by) ? item.produced_by : null;
    const regenOf = isUuid(item.regen_of) ? item.regen_of : null;

    const hashtags = Array.isArray(item.hashtags) ? item.hashtags : [];
    const assets = Array.isArray(item.assets) ? item.assets : [];
    const lint = item.lint == null ? null : item.lint;
    const dedupe = item.dedupe == null ? null : item.dedupe;

    const [row] = await this.sql`
      insert into autopilot.content_items (
        id, slot_at, platform, format, idea_id, series_key, pillar, risk, status,
        candidate_group, chosen, caption, hashtags, overlays, link_utm, assets, lint, dedupe,
        produced_by, attempt, regen_of, regen_count, publish_attempts, next_attempt_at,
        created_at, updated_at
      ) values (
        ${pk}, ${item.slot_at}, ${item.platform}::autopilot.ap_platform, ${item.format}::autopilot.ap_format,
        ${item.idea_id ?? null}, ${item.series_key ?? null}, ${item.pillar ?? null},
        ${item.risk ?? 'standard'}::autopilot.ap_risk, ${item.status ?? 'planned'}::autopilot.ap_status,
        ${candidateGroup}, ${Boolean(item.chosen)}, ${item.caption ?? null}, ${hashtags},
        ${this.sql.json(overlays)}, ${item.link_utm ?? null}, ${this.sql.json(assets)},
        ${lint === null ? null : this.sql.json(lint)}, ${dedupe === null ? null : this.sql.json(dedupe)},
        ${producedBy}, ${item.attempt ?? 1}, ${regenOf}, ${item.regen_count ?? 0},
        ${item.publish_attempts ?? 0}, ${item.next_attempt_at ?? null},
        ${item.created_at ?? now}, ${item.updated_at ?? now}
      )
      on conflict (id) do update set
        slot_at = excluded.slot_at, platform = excluded.platform, format = excluded.format,
        idea_id = excluded.idea_id, series_key = excluded.series_key, pillar = excluded.pillar,
        risk = excluded.risk, status = excluded.status, candidate_group = excluded.candidate_group,
        chosen = excluded.chosen, caption = excluded.caption, hashtags = excluded.hashtags,
        overlays = excluded.overlays, link_utm = excluded.link_utm, assets = excluded.assets,
        lint = excluded.lint, dedupe = excluded.dedupe, produced_by = excluded.produced_by,
        attempt = excluded.attempt, regen_of = excluded.regen_of, regen_count = excluded.regen_count,
        publish_attempts = excluded.publish_attempts, next_attempt_at = excluded.next_attempt_at,
        updated_at = ${now}
      returning *`;
    return this.#rowToItem(row, item.id);
  }

  /**
   * Compare-and-swap transition: a single conditional UPDATE guarded on the
   * current status. 0 rows updated → the row exists but moved on (CAS conflict)
   * or is missing — mirroring FileStore's error shapes exactly. Postgres
   * row-level locking replaces FileStore's lockfile: concurrent identical
   * transitions serialise, exactly one commits, the rest see 0 rows.
   * @param {string} id @param {string} from @param {string} to @param {Object} [patch]
   */
  async transition(id, from, to, patch = {}) {
    const sql = this.sql;
    const pk = toPk(id);
    const sets = [sql`status = ${to}::autopilot.ap_status`, sql`updated_at = now()`];
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'feedback') {
        // No dedicated column: feedback lives in the reserved overlays
        // envelope. jsonb_set against the CURRENT row so a feedback-only
        // patch never clobbers overlays (AP-815 fix).
        sets.push(
          v == null
            ? sql`overlays = (coalesce(overlays, '{}'::jsonb) - '__feedback')`
            : sql`overlays = jsonb_set(coalesce(overlays, '{}'::jsonb), '{__feedback}', ${sql.json(v)})`,
        );
        continue;
      }
      if (k === 'status' || !UPDATABLE.has(k)) continue; // drop status (handled) + file-mode-only annotations
      if (k === 'overlays') {
        // Replacing overlays must PRESERVE the reserved __fileids envelope on
        // the existing row (slug-id items would otherwise lose their identity
        // mapping on regen re-drafts — latent bug found at AP-815). A fresh
        // overlays write deliberately consumes/clears __feedback.
        sets.push(
          sql`overlays = ${sql.json(v || {})}::jsonb || jsonb_strip_nulls(jsonb_build_object('__fileids', overlays -> '__fileids'))`,
        );
        continue;
      }
      if (JSONB_COLS.has(k)) {
        sets.push(v === null ? sql`${sql(k)} = null` : sql`${sql(k)} = ${sql.json(v)}`);
      } else if (ENUM_COLS[k]) {
        sets.push(sql`${sql(k)} = ${v}::${sql.unsafe(`autopilot.${ENUM_COLS[k]}`)}`);
      } else if (UUID_COLS.has(k)) {
        sets.push(sql`${sql(k)} = ${v == null ? null : toPk(v)}`);
      } else {
        sets.push(sql`${sql(k)} = ${v}`);
      }
    }
    const setFrag = sets.reduce((acc, frag, i) => (i ? sql`${acc}, ${frag}` : frag));
    const rows = await sql`
      update autopilot.content_items set ${setFrag}
      where id = ${pk} and status = ${from}::autopilot.ap_status
      returning *`;
    if (rows.count === 1) return this.#rowToItem(rows[0], id);

    const cur = await sql`select status from autopilot.content_items where id = ${pk}`;
    if (cur.count === 0) throw new Error(`transition: no such item ${id}`);
    throw new CasConflictError(id, from, cur[0].status);
  }

  /** @param {(i:import('../types.mjs').ContentItem)=>boolean} [filter] */
  async listItems(filter) {
    const rows = await this.sql`select * from autopilot.content_items order by slot_at asc, id asc`;
    const out = [];
    for (const row of rows) {
      const item = this.#rowToItem(row);
      if (!filter || filter(item)) out.push(item);
    }
    return out;
  }

  /** @param {string|string[]} status */
  async listByStatus(status) {
    const statuses = Array.isArray(status) ? status : [status];
    const rows = await this.sql`
      select * from autopilot.content_items
      where status::text = any(${statuses})
      order by slot_at asc, id asc`;
    return rows.map((r) => this.#rowToItem(r));
  }

  /* Map a content_items row back to the file-mode ContentItem shape. */
  #rowToItem(row, overrideId) {
    const rawOverlays = row.overlays && typeof row.overlays === 'object' ? row.overlays : {};
    const env = (rawOverlays.__fileids && typeof rawOverlays.__fileids === 'object') ? rawOverlays.__fileids : {};
    const feedback = rawOverlays.__feedback ?? null;
    const overlays = { ...rawOverlays };
    delete overlays.__fileids;
    delete overlays.__feedback;
    return {
      ...(feedback != null ? { feedback } : {}),
      id: overrideId ?? env.id ?? row.id,
      slot_at: iso(row.slot_at),
      platform: row.platform,
      format: row.format,
      idea_id: row.idea_id ?? null,
      series_key: row.series_key ?? null,
      pillar: row.pillar ?? null,
      risk: row.risk,
      status: row.status,
      candidate_group: env.candidate_group ?? row.candidate_group ?? null,
      chosen: row.chosen,
      caption: row.caption ?? null,
      hashtags: row.hashtags ?? [],
      overlays,
      link_utm: row.link_utm ?? null,
      assets: row.assets ?? [],
      lint: row.lint ?? null,
      dedupe: row.dedupe ?? null,
      produced_by: env.produced_by ?? row.produced_by ?? null,
      attempt: row.attempt,
      regen_of: env.regen_of ?? row.regen_of ?? null,
      regen_count: row.regen_count,
      publish_attempts: row.publish_attempts,
      next_attempt_at: iso(row.next_attempt_at),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /* ---------------------------------- runs --------------------------------- */

  /**
   * Append a run row. Only real runs columns are persisted; the rich
   * file-mode annotations a transition run carries (item_id / from / to /
   * note / parent_run) have no column in the schema and are dropped — the
   * audit ROW still lands (stage normalised to 'transition'), which is what
   * the state-machine audit needs. Returns the row echoed with any extra
   * input fields so in-process callers still read what they wrote.
   * @param {Partial<import('../types.mjs').Run>} run
   */
  async appendRun(run = {}) {
    const stage = normalizeStage(run.stage);
    const cols = { stage, status: run.status || 'running', started_at: run.started_at || nowISO() };
    for (const k of RUN_COLS) {
      if (k === 'stage' || k === 'status' || k === 'started_at') continue;
      if (run[k] !== undefined) cols[k] = run[k];
    }
    const [row] = await this.sql`
      insert into autopilot.runs ${this.sql(cols, ...Object.keys(cols))}
      returning *`;
    return { ...run, ...this.#rowToRun(row) };
  }

  /** @param {string} id @param {Partial<import('../types.mjs').Run>} patch */
  async updateRun(id, patch = {}) {
    if (!isUuid(id)) throw new Error(`updateRun: run id must be a uuid (got "${id}")`);
    const cols = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!RUN_COLS.has(k)) continue; // drop non-column fields (e.g. `produced`)
      cols[k] = k === 'stage' ? normalizeStage(v) : v;
    }
    if (!Object.keys(cols).length) {
      const [only] = await this.sql`select * from autopilot.runs where id = ${id}`;
      return only ? { ...patch, ...this.#rowToRun(only) } : { id, ...patch };
    }
    const [row] = await this.sql`
      update autopilot.runs set ${this.sql(cols, ...Object.keys(cols))}
      where id = ${id} returning *`;
    return row ? { ...patch, ...this.#rowToRun(row) } : { id, ...patch };
  }

  #rowToRun(row) {
    return {
      id: row.id,
      stage: row.stage,
      status: row.status,
      driver: row.driver ?? undefined,
      model: row.model ?? undefined,
      prompt_sha: row.prompt_sha ?? undefined,
      tokens_in: row.tokens_in ?? undefined,
      tokens_out: row.tokens_out ?? undefined,
      cost_usd: row.cost_usd == null ? undefined : Number(row.cost_usd),
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      error: row.error ?? undefined,
      log_path: row.log_path ?? undefined,
    };
  }

  /**
   * Append a structured log line. Per-run logs stay ON DISK (like assets),
   * under the configured logs dir, keyed by the run id — matching FileStore.
   * @param {string} runId @param {Object} entry
   */
  async appendLog(runId, entry) {
    if (!this.logsDir) return; // no data root configured → nothing to write to
    await fsp.mkdir(this.logsDir, { recursive: true });
    const line = `${JSON.stringify({ ts: nowISO(), ...entry })}\n`;
    await fsp.appendFile(join(this.logsDir, `${runId}.jsonl`), line, 'utf8');
  }

  /* -------------------------------- approvals ------------------------------- */

  /** @param {Partial<import('../types.mjs').Approval>} approval */
  async appendApproval(approval = {}) {
    if (!approval.content_item_id) throw new Error('appendApproval: content_item_id required');
    const pk = toPk(approval.content_item_id);
    const decidedAt = approval.decided_at || nowISO();
    const [row] = await this.sql`
      insert into autopilot.approvals (content_item_id, decision, reason_tags, note, caption_diff, via, decided_at)
      values (
        ${pk}, ${approval.decision}, ${approval.reason_tags ?? null}, ${approval.note ?? null},
        ${approval.caption_diff == null ? null : this.sql.json(approval.caption_diff)},
        ${approval.via ?? 'cli'}, ${decidedAt}
      )
      returning *`;
    return {
      id: row.id,
      content_item_id: approval.content_item_id,
      decision: row.decision,
      reason_tags: row.reason_tags ?? [],
      note: row.note ?? null,
      caption_diff: row.caption_diff ?? null,
      via: row.via,
      decided_at: iso(row.decided_at),
    };
  }

  /** @param {string} itemId */
  async listApprovals(itemId) {
    const pk = toPk(itemId);
    const rows = await this.sql`
      select * from autopilot.approvals where content_item_id = ${pk} order by decided_at asc`;
    return rows.map((r) => ({
      id: r.id,
      content_item_id: itemId,
      decision: r.decision,
      reason_tags: r.reason_tags ?? [],
      note: r.note ?? null,
      caption_diff: r.caption_diff ?? null,
      via: r.via,
      decided_at: iso(r.decided_at),
    }));
  }

  /* -------------------------------- settings -------------------------------- */

  async getSettings() {
    const rows = await this.sql`select key, value from autopilot.settings`;
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** @param {string} key */
  async getSetting(key) {
    const rows = await this.sql`select value from autopilot.settings where key = ${key}`;
    return rows.count ? rows[0].value : undefined;
  }

  /** @param {string} key @param {*} value */
  async setSetting(key, value) {
    await this.sql`
      insert into autopilot.settings (key, value, updated_at)
      values (${key}, ${this.sql.json(value)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }

  /* ---------------------------------- ideas -------------------------------- */

  /**
   * Upsert an idea row (FK target for content_items.idea_id). Used by the
   * importer before it upserts items. Idempotent.
   * @param {string} id @param {Object} [payload] the ideas.json object
   */
  async ensureIdea(id, payload = {}) {
    if (!id) throw new Error('ensureIdea: id required');
    const p = payload && typeof payload === 'object' ? payload : {};
    const pillar = String(p.pillar ?? 'unknown');
    const formatFamily = String(p.format_family ?? p.platform ?? 'unknown');
    const [row] = await this.sql`
      insert into autopilot.ideas (id, payload, pillar, format_family)
      values (${id}, ${this.sql.json(p)}, ${pillar}, ${formatFamily})
      on conflict (id) do update set
        payload = excluded.payload, pillar = excluded.pillar,
        format_family = excluded.format_family, updated_at = now()
      returning id`;
    return row.id;
  }

  /* --------------------------------- lifecycle ----------------------------- */

  /** Close the connection pool so a short-lived CLI process can exit cleanly. */
  async close() {
    if (this.sql) await this.sql.end({ timeout: 5 });
  }
}
