/**
 * @file `render` stage. Produces media for the slot date's drafted candidates
 * via the injected renderer adapters (AP-203). Transitions drafted → rendering
 * → rendered, writing the `assets` descriptors. Idempotent + resumable; a
 * failing item is left in `rendering` for the next run and does not block its
 * siblings (errors are aggregated and thrown at the end so the failure is
 * visible and the completion marker is withheld).
 */

import { join } from 'node:path';
import { isoDatePart } from '../util/time.mjs';
import { transitionItem } from '../state/machine.mjs';

/**
 * Route an item to an adapter by format.
 *  - image / carousel / story → poster (story = story-size image in v0)
 *  - reel / tiktok_video      → video  (kinetic HookCard + EndCard)
 * `capture` (library footage) is available via adapters.capture but is not
 * auto-routed in v0 (needs AP-204's library); items opt in via overlays.source.
 * @param {import('../types.mjs').ContentItem} item
 */
export function routeAdapter(item) {
  if (item.overlays && item.overlays.source === 'capture') return 'capture';
  switch (item.format) {
    case 'image':
    case 'carousel':
    case 'story':
      return 'poster';
    case 'reel':
    case 'tiktok_video':
      return 'video';
    default:
      throw new Error(`render: no adapter for format "${item.format}"`);
  }
}

/** @param {Object} ctx */
export async function renderStage(ctx) {
  const { config, store, date, dryRun, log, runId, adapters } = ctx;
  if (!adapters) throw new Error('render: no renderer adapters injected');

  const targets = (await store.listByStatus(['drafted', 'rendering'])).filter(
    (i) => isoDatePart(i.slot_at) === date,
  );

  let rendered = 0;
  const errors = [];
  for (const item of targets) {
    const route = routeAdapter(item);
    if (dryRun) {
      await log({ event: 'render.dry_run', id: item.id, route });
      continue;
    }
    try {
      let cur = item;
      if (cur.status === 'drafted') {
        cur = await transitionItem(store, {
          item: cur,
          to: 'rendering',
          stage: 'render',
          runId,
          patch: { produced_by: runId },
        });
      }
      const outDir = join(config.resolved.outbox, cur.id, 'assets');
      const assets = await adapters[route](cur, { config, outDir });
      cur = await transitionItem(store, {
        item: cur,
        to: 'rendered',
        stage: 'render',
        runId,
        patch: { assets, produced_by: runId },
      });
      rendered++;
      await log({ event: 'render.rendered', id: cur.id, route, assets: assets.map((a) => a.path) });
    } catch (err) {
      errors.push(item.id);
      await log({ event: 'render.error', id: item.id, route, error: String(err && err.message ? err.message : err) });
    }
  }

  await log({ event: 'render.done', rendered, targets: targets.length, errors: errors.length });
  if (errors.length) throw new Error(`render: ${errors.length} item(s) errored: ${errors.join(', ')}`);
  return { produced: rendered };
}
