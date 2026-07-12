/**
 * @file `plan` stage (deterministic, PRD §6.3 v0). Emits `planned` shells for
 * T+1..T+horizon. Idempotent: existing item ids are left untouched; the usage
 * journal is bumped only for newly-created items.
 */

import { loadIdeas } from '../plan/ideas.mjs';
import { planWeek } from '../plan/planner.mjs';
import { loadUsage, bumpUsage } from '../plan/usage.mjs';

/** @param {Object} ctx */
export async function planStage(ctx) {
  const { config, store, date, dryRun, log, runId } = ctx;

  const ideas = loadIdeas(config.resolved.ideas);
  const usage = await loadUsage(config);
  const shells = planWeek({
    ideas,
    usage,
    cadence: config.cadence,
    slotTimes: config.slot_times,
    formatMix: config.format_mix,
    timezone: config.timezone,
    startDate: date,
    horizonDays: config.planning_horizon_days,
    producedBy: dryRun ? null : runId,
  });

  if (dryRun) {
    await log({ event: 'plan.dry_run', run_date: date, slots: shells.length });
    return { produced: 0, planned: shells, dryRun: true };
  }

  // FK-backed stores (postgres) require the referenced idea row to exist
  // before a content_item can point at it. ensureIdea is idempotent; FileStore
  // has no FK and no ensureIdea, so this is a no-op there (AP-820 seed fix).
  const ideaById = new Map(ideas.map((i) => [i.id, i]));

  let created = 0;
  let skipped = 0;
  const createdShells = [];
  for (const shell of shells) {
    const existing = await store.getItem(shell.id);
    if (existing) {
      skipped++;
      await log({ event: 'plan.skip_existing', id: shell.id });
      continue;
    }
    if (shell.idea_id && typeof store.ensureIdea === 'function') {
      const idea = ideaById.get(shell.idea_id);
      await store.ensureIdea(shell.idea_id, idea || {});
    }
    await store.putItem(shell);
    createdShells.push(shell);
    created++;
    await log({ event: 'plan.created', id: shell.id, idea: shell.idea_id, slot_at: shell.slot_at });
  }

  if (createdShells.length) await bumpUsage(config, createdShells);

  await log({ event: 'plan.done', created, skipped, total: shells.length });
  return { produced: created, planned: shells, skipped };
}
