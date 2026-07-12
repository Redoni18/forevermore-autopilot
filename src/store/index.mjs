/**
 * @file Store factory. Picks the concrete implementation from `config.store`
 * ("file" → M0 FileStore, "supabase" → M1 stub). Both satisfy the identical
 * {@link import('../types.mjs').Store} contract, so M0→M1 is this one switch.
 */

import { FileStore } from './file-store.mjs';
import { SupabaseStore } from './supabase-store.mjs';

/**
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @returns {import('../types.mjs').Store}
 */
export function createStore(config) {
  switch (config.store) {
    case 'file':
      return new FileStore(config);
    case 'supabase':
      return new SupabaseStore(config);
    default:
      throw new Error(`unknown store "${config.store}" (want file|supabase)`);
  }
}

export { FileStore, SupabaseStore };
