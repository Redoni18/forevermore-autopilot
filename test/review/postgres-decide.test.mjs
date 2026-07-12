// Review-station decide() against the PostgresStore — the same orchestration
// the HTTP layer calls, exercised over the DB backend: happy-path approve with
// candidate-group auto-skip, and the 409-equivalent on a double-decide. Skips
// cleanly when the DB is unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../review/lib/store.mjs';
import { pgTest, pgItem } from '../pg-helpers.mjs';

test('review decide over postgres: approve flips status/chosen and auto-skips the pending sibling', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  // two candidates for one slot (shared candidate_group) + a third pending item
  // in a DIFFERENT group that must stay untouched.
  await store.putItem(pgItem(tag, 1, { status: 'pending_review' }));
  await store.putItem(pgItem(tag, 2, { status: 'pending_review' }));
  await store.putItem(pgItem(tag, 9, { status: 'pending_review', candidate_group: `cg_${tag}_other` }));

  const res = await decide({ store, itemId: `ci_${tag}_1`, decision: 'approved' });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.item.status, 'approved');
  assert.equal(res.item.chosen, true);
  assert.equal(res.decision.decision, 'approved');
  assert.equal(res.decision.content_item_id, `ci_${tag}_1`);
  assert.equal(res.decision.via, 'local-station');
  assert.equal(res.decision.caption_diff, null);
  assert.deepEqual(res.autoSkipped, [`ci_${tag}_2`], 'the pending sibling is auto-skipped');

  // sibling really landed as skipped, with the auto-skip approval attached
  const sib = await store.getItem(`ci_${tag}_2`);
  assert.equal(sib.status, 'skipped');
  const sibApprovals = await store.listApprovals(`ci_${tag}_2`);
  assert.equal(sibApprovals.at(-1).decision, 'rejected');
  assert.deepEqual(sibApprovals.at(-1).reason_tags, ['candidate-not-chosen']);

  // the item in the other group is untouched
  assert.equal((await store.getItem(`ci_${tag}_9`)).status, 'pending_review');
});

test('review decide over postgres: edited caption produces a caption_diff and replaces the caption', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const before = `caption ${tag}-5`;
  await store.putItem(pgItem(tag, 5, { status: 'pending_review', caption: before, candidate_group: `cg_${tag}_solo` }));
  const after = 'a warmer, sharper caption';

  const res = await decide({ store, itemId: `ci_${tag}_5`, decision: 'edited', captionAfter: after });
  assert.equal(res.status, 200);
  assert.equal(res.item.status, 'approved'); // edited resolves to approved
  assert.equal(res.item.caption, after);
  assert.deepEqual(res.decision.caption_diff, { before, after });
});

test('review decide over postgres: double-decide 409s (already left pending_review)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  await store.putItem(pgItem(tag, 3, { status: 'pending_review', candidate_group: `cg_${tag}_x` }));

  const first = await decide({ store, itemId: `ci_${tag}_3`, decision: 'approved' });
  assert.equal(first.status, 200);

  const second = await decide({ store, itemId: `ci_${tag}_3`, decision: 'rejected', reasonTags: ['timing'] });
  assert.equal(second.status, 409);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'not_pending_review');
});

test('review decide over postgres: unknown item is a 404', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);
  const res = await decide({ store, itemId: `ci_${tag}_ghost`, decision: 'approved' });
  assert.equal(res.status, 404);
  assert.equal(res.error, 'not_found');
});
