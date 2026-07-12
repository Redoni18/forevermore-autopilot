/**
 * @file Hermetic helpers for the PostgresStore integration tests.
 *
 * Isolation model (chosen deliberately — see AP-812 report): rather than
 * spin up a scratch database (needs CREATEDB + a template with no live
 * connections, and would have to replay a migration owned by a parallel
 * agent), every test runs against the SAME live control-plane DB but tags all
 * the rows it creates with a per-run random slug and DELETEs them in a
 * `t.after` hook. approvals cascade on their content_item, so removing tagged
 * items sweeps their approvals too. Tests therefore never assume empty tables
 * (the DB carries a pre-existing demo row) and never collide with each other.
 *
 * When the DB is unreachable (no Docker, CI without Postgres) `pgTest` calls
 * `t.skip()` and returns null, so the suite stays green everywhere.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { PostgresStore } from '../src/store/postgres-store.mjs';

export const TEST_DB_URL = process.env.AUTOPILOT_DB_URL || 'postgres://postgres:autopilot@127.0.0.1:5433/autopilot';

/** Cheap reachability probe (per test-file process). */
async function dbReachable(url) {
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} });
  try {
    await sql`select 1 from autopilot.settings limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 3 });
  }
}

/** Build a hermetic config whose data root (outbox/logs) is a fresh temp dir. */
export function pgConfig() {
  const tmp = mkdtempSync(join(tmpdir(), 'autopilot-pg-test-'));
  return loadConfig({
    configPath: join(tmp, 'no-config.json'),
    env: { AUTOPILOT_STORE: 'postgres', AUTOPILOT_DB_URL: TEST_DB_URL, AUTOPILOT_ROOT: tmp },
  });
}

/**
 * Boot a PostgresStore for a test, or skip cleanly when the DB is down.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<null | { store: PostgresStore, tag: string, cleanup: () => Promise<void> }>}
 */
export async function pgTest(t) {
  if (!(await dbReachable(TEST_DB_URL))) {
    t.skip(`Postgres unreachable at ${TEST_DB_URL} — skipping DB integration test`);
    return null;
  }
  const store = new PostgresStore(pgConfig());
  const tag = Math.random().toString(36).slice(2, 10);
  async function cleanup() {
    try {
      // content_items tagged via their file-id envelope; approvals cascade.
      await store.sql`
        delete from autopilot.content_items
        where overlays -> '__fileids' ->> 'id' like ${`%${tag}%`}`;
      await store.sql`delete from autopilot.settings where key like ${`%${tag}%`}`;
      await store.sql`delete from autopilot.ideas where id like ${`%${tag}%`}`;
    } finally {
      await store.close();
    }
  }
  return { store, tag, cleanup };
}

/** A DB-mode content item carrying the run tag inside its slug ids. */
export function pgItem(tag, k = 1, over = {}) {
  return {
    id: `ci_${tag}_${k}`,
    slot_at: '2026-07-14T17:30:00+02:00',
    platform: 'instagram',
    format: 'reel',
    idea_id: null,
    series_key: null,
    pillar: 'P1',
    risk: 'standard',
    status: 'planned',
    candidate_group: `cg_${tag}`,
    chosen: false,
    caption: `caption ${tag}-${k}`,
    hashtags: ['forevermore', 'giftideas'],
    overlays: { hook: `hook ${tag}-${k}` },
    link_utm: null,
    assets: [{ kind: 'video', path: 'assets/final.mp4', w: 1080, h: 1920, sha256: 'x'.repeat(64), dur_s: 6.5 }],
    lint: { passed: true, violations: [] },
    dedupe: null,
    produced_by: null,
    attempt: 1,
    regen_of: null,
    ...over,
  };
}
