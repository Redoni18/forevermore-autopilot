// Tests for POST /api/decide against a temp copy of the committed fixture
// outbox (autopilot/fixtures/outbox-sample/): happy paths per decision type,
// 409 on double-decide, candidate-group auto-skip, and caption_diff.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupReviewTest } from './helpers.mjs';

test('decide: approve happy path — status flips, chosen flips, siblings auto-skip', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'approved' });

  assert.equal(res.status, 200);
  assert.equal(res.body.item.status, 'approved');
  assert.equal(res.body.item.chosen, true);
  assert.equal(res.body.decision.decision, 'approved');
  assert.equal(res.body.decision.content_item_id, 'ci_20260713_ig_1');
  assert.equal(res.body.decision.via, 'local-station');
  assert.equal(res.body.decision.caption_diff, null);
  assert.deepEqual([...res.body.autoSkipped].sort(), ['ci_20260713_ig_2', 'ci_20260713_ig_3']);

  // re-fetch and confirm the siblings actually landed as skipped, not just reported as such
  const items = await h.getItems();
  const group = items.body.groups.find((g) => g.candidate_group === 'cg_20260713_ig_1830');
  const sibling2 = group.items.find((i) => i.id === 'ci_20260713_ig_2');
  const sibling3 = group.items.find((i) => i.id === 'ci_20260713_ig_3');
  assert.equal(sibling2.status, 'skipped');
  assert.equal(sibling3.status, 'skipped');
  assert.deepEqual(sibling2.decision.reason_tags, ['candidate-not-chosen']);
  assert.equal(sibling2.decision.via, 'local-station');
  assert.equal(group.pending_count, 0);

  // the other group is untouched
  const otherGroup = items.body.groups.find((g) => g.candidate_group === 'cg_20260714_tt_0900');
  assert.equal(otherGroup.pending_count, 3);
});

test('decide: edited caption produces a correct caption_diff and replaces the canonical caption', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const before = await h.getItems();
  const originalGroup = before.body.groups.find((g) => g.candidate_group === 'cg_20260714_tt_0900');
  const originalItem = originalGroup.items.find((i) => i.id === 'ci_20260714_tt_1');
  const originalCaption = originalItem.caption;

  const newCaption = 'the photos are already on your phone. we just give them somewhere to live.';
  const res = await h.decide({ itemId: 'ci_20260714_tt_1', decision: 'edited', captionAfter: newCaption });

  assert.equal(res.status, 200);
  assert.equal(res.body.item.status, 'approved'); // 'edited' still resolves to status approved
  assert.equal(res.body.item.chosen, true);
  assert.equal(res.body.item.caption, newCaption);
  assert.deepEqual(res.body.decision.caption_diff, { before: originalCaption, after: newCaption });
  assert.deepEqual([...res.body.autoSkipped].sort(), ['ci_20260714_tt_2', 'ci_20260714_tt_3']);
});

test('decide: approving with an unchanged captionAfter does not fabricate a caption_diff', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const before = await h.getItems();
  const item = before.body.groups
    .flatMap((g) => g.items)
    .find((i) => i.id === 'ci_20260713_ig_1');

  // decision is 'approved' (not 'edited') even though a captionAfter happens to be sent
  const res = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'approved', captionAfter: item.caption });

  assert.equal(res.status, 200);
  assert.equal(res.body.decision.caption_diff, null);
  assert.equal(res.body.item.caption, item.caption);
});

test('decide: 409s on double-decide (already left pending_review)', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const first = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'approved' });
  assert.equal(first.status, 200);

  const second = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'rejected', reasonTags: ['timing'] });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'not_pending_review');

  // an auto-skipped sibling is also no longer decidable
  const third = await h.decide({ itemId: 'ci_20260713_ig_2', decision: 'approved' });
  assert.equal(third.status, 409);
  assert.equal(third.body.error, 'not_pending_review');
});

test('decide: changes_requested embeds feedback and bounces to drafting for regen (AP-815)', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.decide({
    itemId: 'ci_20260714_tt_3',
    decision: 'changes_requested',
    reasonTags: ['hook-weak', 'timing'],
    note: 'sharpen the open, this reads slow',
  });

  assert.equal(res.status, 200);
  // The item does NOT park at changes_requested — it enters the regen path
  // immediately so the next `generate` run re-drafts it with the feedback.
  assert.equal(res.body.item.status, 'drafting');
  assert.equal(res.body.item.regen_count, 1);
  assert.equal(res.body.item.attempt, 2);
  assert.equal(res.body.item.chosen, false);
  assert.deepEqual(res.body.item.feedback.reason_tags, ['hook-weak', 'timing']);
  assert.equal(res.body.item.feedback.note, 'sharpen the open, this reads slow');
  assert.deepEqual(res.body.autoSkipped, []);

  const items = await h.getItems();
  const group = items.body.groups.find((g) => g.candidate_group === 'cg_20260714_tt_0900');
  assert.equal(group.pending_count, 2); // tt_1 and tt_2 are untouched
});

test('decide: rejected maps to status skipped and does not touch siblings', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.decide({ itemId: 'ci_20260713_ig_3', decision: 'rejected', reasonTags: ['off-voice'] });

  assert.equal(res.status, 200);
  assert.equal(res.body.item.status, 'skipped');
  assert.deepEqual(res.body.autoSkipped, []);

  const items = await h.getItems();
  const group = items.body.groups.find((g) => g.candidate_group === 'cg_20260713_ig_1830');
  assert.equal(group.pending_count, 2); // ig_1 and ig_2 are untouched
});

test('decide: validation — missing itemId is a 400', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());
  const res = await h.decide({ decision: 'approved' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad_request');
});

test('decide: validation — unknown decision string is a 400', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());
  const res = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'maybe-later' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad_request');
});

test('decide: validation — rejected/changes_requested require a reason tag or note', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res1 = await h.decide({ itemId: 'ci_20260713_ig_1', decision: 'rejected' });
  assert.equal(res1.status, 400);

  const res2 = await h.decide({ itemId: 'ci_20260713_ig_2', decision: 'changes_requested', reasonTags: [], note: '  ' });
  assert.equal(res2.status, 400);

  // a note alone (no tags) is sufficient
  const res3 = await h.decide({ itemId: 'ci_20260713_ig_3', decision: 'rejected', note: 'not on-brand' });
  assert.equal(res3.status, 200);
});

test('decide: unknown itemId is a 404', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());
  const res = await h.decide({ itemId: 'ci_does_not_exist', decision: 'approved' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
