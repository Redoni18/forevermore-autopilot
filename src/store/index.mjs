/**
 * @file Store factory. Picks the concrete implementation from `config.store`:
 *   "file"      → FileStore (repo-local outbox; the zero-dependency default)
 *   "postgres"  → PostgresStore (Autopilot's own control-plane DB — ADR-001)
 *   "supabase"  → deprecated alias for "postgres" (the M1 name; kept working)
 * Both satisfy the identical {@link import('../types.mjs').Store} contract, so
 * switching modes is this one config flip.
 */

import { FileStore } from './file-store.mjs';
import { PostgresStore } from './postgres-store.mjs';

/**
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @returns {import('../types.mjs').Store}
 */
export function createStore(config) {
  switch (config.store) {
    case 'file':
      return new FileStore(config);
    case 'postgres':
      return new PostgresStore(config);
    case 'supabase':
      // Deprecated: "supabase" was the M1 stub's name. The store is a plain
      // Postgres client now (ADR-001 — Autopilot's own DB, not the platform's
      // Supabase project). Kept as an alias so existing configs don't break.
      return new PostgresStore(config);
    default:
      throw new Error(`unknown store "${config.store}" (want file|postgres)`);
  }
}

export { FileStore, PostgresStore };
