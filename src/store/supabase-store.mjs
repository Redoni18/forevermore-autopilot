/**
 * @file SupabaseStore — M1 stub (ticket AP-103 asks for a compiling stub only).
 *
 * The real implementation lands once the `autopilot` schema (ticket AP-102) is
 * pushed (owner decision D-4). It will mirror {@link FileStore}'s behavior
 * against Postgres, using:
 *   - `content_items` for get/put/list, with `transition()` implemented as a
 *     conditional UPDATE (`... where id=$1 and status=$from`) whose 0-row result
 *     is the CAS conflict — Postgres row-level locking replaces the lockfile.
 *   - `runs` / `approvals` / `settings` tables for the rest.
 *   - the service-role key (runner-only; never in the atlas client).
 *
 * Types come from ticket AP-102's `autopilot/src/db/types.ts` (NOT created by
 * this ticket — do not import it until AP-102 lands). Field names are kept
 * identical to the file-mode JSON so callers are storage-agnostic.
 *
 * Every method throws until AP-102 is done, so accidental `store=supabase`
 * fails loudly instead of silently no-op'ing.
 */

const TODO = 'SupabaseStore is a stub — implement after AP-102 schema is pushed (D-4).';

export class SupabaseStore {
  /** @param {ReturnType<import('../config.mjs').loadConfig>} config */
  constructor(config) {
    this.config = config;
    // TODO(AP-102): const { createClient } = await import('@supabase/supabase-js');
    // TODO(AP-102): this.db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'autopilot' } });
    // TODO(AP-102): import type { ContentItemRow, RunRow, ... } from '../db/types.ts';
  }

  /* eslint-disable class-methods-use-this */
  async getItem(/* id */) {
    throw new Error(TODO);
  }
  async putItem(/* item */) {
    throw new Error(TODO);
  }
  /** CAS = `update content_items set status=$to, ... where id=$1 and status=$from`; rowCount===0 → conflict. */
  async transition(/* id, from, to, patch */) {
    throw new Error(TODO);
  }
  async listItems(/* filter */) {
    throw new Error(TODO);
  }
  async listByStatus(/* status */) {
    throw new Error(TODO);
  }
  async appendRun(/* run */) {
    throw new Error(TODO);
  }
  async updateRun(/* id, patch */) {
    throw new Error(TODO);
  }
  async appendLog(/* runId, entry */) {
    throw new Error(TODO);
  }
  async appendApproval(/* approval */) {
    throw new Error(TODO);
  }
  async listApprovals(/* itemId */) {
    throw new Error(TODO);
  }
  async getSettings() {
    throw new Error(TODO);
  }
  async getSetting(/* key */) {
    throw new Error(TODO);
  }
  async setSetting(/* key, value */) {
    throw new Error(TODO);
  }
}
