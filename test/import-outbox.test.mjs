// Importer idempotency test: import a small tagged file-mode outbox into the
// DB-backed store, then import it AGAIN and assert nothing duplicates (items
// upsert, the decision is skipped). Hermetic + skips when the DB is down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importOutbox } from '../src/cli/commands.mjs';
import { pgTest, pgItem } from './pg-helpers.mjs';

/** Lay down a minimal file-mode data root (outbox + decisions + ideas.json). */
async function buildOutbox(tag) {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-import-test-'));
  const outboxDir = join(root, 'outbox');
  const decisionsDir = join(root, 'decisions');
  const ideasPath = join(root, 'ideas.json');

  const ideaId = `idea_${tag}`;
  const item1 = pgItem(tag, 1, { idea_id: ideaId, status: 'approved', produced_by: `run_${tag}_r` });
  const item2 = pgItem(tag, 2, { idea_id: ideaId, status: 'pending_review', produced_by: `run_${tag}_r` });

  for (const it of [item1, item2]) {
    const dir = join(outboxDir, it.id, 'assets');
    await mkdir(dir, { recursive: true });
    await writeFile(join(outboxDir, it.id, 'item.json'), JSON.stringify(it, null, 2));
    await writeFile(join(dir, 'final.mp4'), 'not-a-real-video');
  }

  await mkdir(decisionsDir, { recursive: true });
  const decision = {
    id: `ap_${tag}`,
    content_item_id: item1.id,
    decision: 'approved',
    reason_tags: [],
    note: 'imported demo approval',
    caption_diff: null,
    via: 'cli',
    decided_at: '2026-07-12T02:31:41.429Z',
  };
  await writeFile(join(decisionsDir, `${item1.id}-20260712T023141429.json`), JSON.stringify(decision, null, 2));

  await writeFile(ideasPath, JSON.stringify([{ id: ideaId, title: 'imported idea', pillar: 'P4', platform: 'both' }]));

  return { root, outboxDir, decisionsDir, ideasPath, ideaId, item1, item2 };
}

test('import-outbox: first run imports items + decisions, second run is idempotent', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  const fx = await buildOutbox(tag);
  t.after(async () => {
    await cleanup();
    await rm(fx.root, { recursive: true, force: true });
  });

  // ---- run 1 ----
  const first = await importOutbox(store, {
    outboxDir: fx.outboxDir,
    decisionsDir: fx.decisionsDir,
    ideasPath: fx.ideasPath,
  });
  assert.equal(first.items, 2, 'both items upserted');
  assert.equal(first.itemErrors, 0);
  assert.equal(first.ideas, 1, 'the shared idea ensured once');
  assert.equal(first.decisionFiles, 1);
  assert.equal(first.approvals, 1, 'the decision replayed as one approval');
  assert.equal(first.approvalsSkipped, 0);

  // items + approval landed and read back through the store contract
  const got = await store.getItem(fx.item1.id);
  assert.equal(got.status, 'approved');
  assert.equal(got.idea_id, fx.ideaId, 'idea FK preserved');
  const apps = await store.listApprovals(fx.item1.id);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].decision, 'approved');

  // ---- run 2 (idempotency) ----
  const second = await importOutbox(store, {
    outboxDir: fx.outboxDir,
    decisionsDir: fx.decisionsDir,
    ideasPath: fx.ideasPath,
  });
  assert.equal(second.items, 2, 'items upsert again (no error)');
  assert.equal(second.approvals, 0, 'no new approval inserted');
  assert.equal(second.approvalsSkipped, 1, 'the existing approval is skipped');

  // still exactly one approval, one item row
  assert.equal((await store.listApprovals(fx.item1.id)).length, 1, 'no duplicate approval');
  const mine = (await store.listByStatus(['approved', 'pending_review'])).filter((i) => i.id.startsWith(`ci_${tag}_`));
  assert.equal(mine.length, 2, 'exactly the two imported items, not duplicated');
});
