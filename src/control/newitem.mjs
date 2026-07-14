/**
 * @file `/new` commissioning — create an off-list item the next tick drafts.
 *
 * The brief's "planner OFFLIST sentinel" does not exist; this builds the shell
 * from scratch, indistinguishable from a planner shell downstream:
 *   - id `ci_<YYYYMMDD>_<ig|tt>_x<n>` (x = commissioned; n collision-probed)
 *   - own candidate_group (one candidate → no auto-skip interference)
 *   - idea_id null (the documented off-list marker, types.mjs), risk 'standard'
 *   - slot tomorrow (or an explicit YYYY-MM-DD) at config.slot_times[platform]
 *
 * The owner's brief travels as item.feedback on a planned→drafting transition;
 * generate.mjs already injects item.feedback.note into inputs.feedback, so the
 * redraft/QA/review flow is untouched. The tick sweeps `drafting` (not
 * `planned`), so we land the item in drafting for guaranteed pickup.
 */

import { compact, zonedISO, addDays, localToday, nowISO } from '../util/time.mjs';
import { formatForSlot } from '../plan/ideas.mjs';
import { transitionItem } from '../state/machine.mjs';

/** Parse `/new [instagram|tiktok] [YYYY-MM-DD] <brief>` → structured request. */
export function parseNewCommand(text) {
  let rest = String(text || '')
    .replace(/^\/new(@\w+)?\s*/i, '')
    .trim();
  if (!rest) return { ok: false, error: 'usage: /new [instagram|tiktok] [YYYY-MM-DD] <brief>' };

  let platform = 'instagram';
  const pm = /^(instagram|ig|tiktok|tt)\b[:\s]+/i.exec(rest);
  if (pm) {
    const p = pm[1].toLowerCase();
    platform = p === 'tt' || p === 'tiktok' ? 'tiktok' : 'instagram';
    rest = rest.slice(pm[0].length).trim();
  }

  let date = null;
  const dm = /^(\d{4}-\d{2}-\d{2})\b\s*/.exec(rest);
  if (dm) {
    date = dm[1];
    rest = rest.slice(dm[0].length).trim();
  }

  if (!rest) return { ok: false, error: 'a brief is required: /new <what to make>' };
  return { ok: true, platform, date, brief: rest };
}

/** Weekday 1..7 (Mon..Sun) of a YYYY-MM-DD date (UTC-safe, date-only). */
function isoWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return d === 0 ? 7 : d;
}

/** Find a free `ci_<date>_<plat>_x<n>` id (probes n=1.. via getItem). */
async function freeId(store, dateCompact, platAbbr) {
  for (let n = 1; n <= 50; n++) {
    const id = `ci_${dateCompact}_${platAbbr}_x${n}`;
    if (!(await store.getItem(id))) return { id, n };
  }
  throw new Error('could not allocate a commission id (50 taken)');
}

/**
 * Create + queue a commissioned item.
 * @param {Object} args
 * @param {import('../types.mjs').Store} args.store
 * @param {ReturnType<import('../config.mjs').loadConfig>} args.config
 * @param {'instagram'|'tiktok'} args.platform
 * @param {string|null} args.date  YYYY-MM-DD or null (→ tomorrow)
 * @param {string} args.brief
 * @returns {Promise<{id:string, slot_at:string, platform:string, format:string}>}
 */
export async function commissionItem({ store, config, platform, date, brief, now = new Date() }) {
  const slotDate = date || addDays(localToday(now), 1);
  const platAbbr = platform === 'tiktok' ? 'tt' : 'ig';
  const dateCompact = compact(slotDate);
  const { id, n } = await freeId(store, dateCompact, platAbbr);

  const weekday = isoWeekday(slotDate);
  const format = formatForSlot(platform, weekday, config.format_mix);
  const slotTime = (config.slot_times && config.slot_times[platform]) || '17:30';
  const slot_at = zonedISO(slotDate, slotTime, config.timezone);
  const pillar = null;

  const shell = {
    id,
    slot_at,
    platform,
    format,
    idea_id: null, // off-list marker (types.mjs)
    series_key: null,
    pillar,
    risk: 'standard',
    status: 'planned',
    candidate_group: `cg_${dateCompact}_${platAbbr}_x${n}`,
    chosen: false,
    caption: null,
    hashtags: [],
    overlays: {},
    link_utm:
      `https://getforevermore.co?utm_source=${platform}` +
      `&utm_medium=organic&utm_campaign=${pillar || 'none'}&utm_content=${id}`,
    assets: [],
    lint: null,
    dedupe: null,
    sources: { commission: { brief, at: nowISO(now), via: 'telegram' } },
    produced_by: 'telegram:/new',
    attempt: 1,
    regen_of: null,
  };

  await store.putItem(shell);

  // Land it in `drafting` so the very next tick's generate sweep picks it up
  // (the sweep does not scan `planned`). The brief rides as feedback → generate
  // injects it as inputs.feedback with zero downstream changes.
  const item = await store.getItem(id);
  await transitionItem(store, {
    item,
    to: 'drafting',
    patch: {
      feedback: { note: `OWNER BRIEF: ${brief}`, reason_tags: ['owner-brief'], decided_at: nowISO(now) },
    },
    stage: 'telegram',
    now,
  });

  return { id, slot_at, platform, format };
}
