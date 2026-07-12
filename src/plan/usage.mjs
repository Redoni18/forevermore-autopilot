/**
 * @file The idea-usage journal (`state/ideas-usage.json`) — the recency source
 * for the planner (PRD §6.3 "recency_penalty (last_used_at)"). Kept as a plain
 * file so it survives across plan runs and is the deterministic input the
 * planner reads. Written only by a *successful, non-dry* plan.
 */

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { isoDatePart } from '../util/time.mjs';

function usagePath(config) {
  return join(config.resolved.state, 'ideas-usage.json');
}

/** @returns {Promise<Object<string,{last_used_at:string, uses:number}>>} */
export async function loadUsage(config) {
  try {
    return JSON.parse(await fsp.readFile(usagePath(config), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * Record that the given planned shells consumed their ideas. `last_used_at` is
 * the item's slot date (so recency reflects when it will actually run).
 * @param {ReturnType<import('../config.mjs').loadConfig>} config
 * @param {import('../types.mjs').ContentItem[]} shells
 */
export async function bumpUsage(config, shells) {
  const path = usagePath(config);
  await fsp.mkdir(dirname(path), { recursive: true });
  const usage = await loadUsage(config);
  for (const s of shells) {
    if (!s.idea_id) continue;
    const slotDate = isoDatePart(s.slot_at);
    const prev = usage[s.idea_id] || { uses: 0 };
    usage[s.idea_id] = { last_used_at: slotDate, uses: (prev.uses || 0) + 1 };
  }
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, path);
}
