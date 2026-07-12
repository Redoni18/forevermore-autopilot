import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSITIONS,
  TERMINAL,
  canTransition,
  assertLegal,
  publishBackoffMs,
  qaFailNext,
  regenNext,
  publishFailNext,
  transitionItem,
} from '../src/state/machine.mjs';
import { STATUSES, IllegalTransitionError, CasConflictError } from '../src/types.mjs';
import { mkEnv, plannedItem } from './helpers.mjs';

test('transition table only references known statuses', () => {
  const known = new Set(STATUSES);
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(known.has(from), `unknown from-state ${from}`);
    for (const to of tos) assert.ok(known.has(to), `unknown to-state ${to} from ${from}`);
  }
});

test('legal transitions are allowed, illegal ones are not', () => {
  assert.ok(canTransition('planned', 'drafting'));
  assert.ok(canTransition('rendered', 'pending_review'));
  assert.ok(canTransition('rendered', 'qa_failed'));
  assert.ok(canTransition('pending_review', 'approved'));
  assert.ok(canTransition('publish_failed', 'publishing'));

  assert.ok(!canTransition('planned', 'published'), 'cannot skip to published');
  assert.ok(!canTransition('approved', 'drafting'), 'cannot rewind approved');
  assert.ok(!canTransition('published', 'skipped'), 'published is nearly terminal');
  assert.ok(!canTransition('skipped', 'drafting'), 'skipped is terminal');
});

test('terminal states have no outgoing edges', () => {
  assert.deepEqual([...TERMINAL].sort(), ['archived', 'skipped']);
  for (const t of TERMINAL) assert.equal(TRANSITIONS[t].length, 0);
});

test('assertLegal throws IllegalTransitionError on bad moves', () => {
  assert.throws(() => assertLegal('planned', 'published'), IllegalTransitionError);
  assert.doesNotThrow(() => assertLegal('planned', 'drafting'));
});

test('qaFailNext bounces to drafting until attempts exhausted, then skips', () => {
  assert.deepEqual(qaFailNext({ attempt: 1 }, 3), { to: 'drafting', patch: { attempt: 2 } });
  assert.deepEqual(qaFailNext({ attempt: 2 }, 3), { to: 'drafting', patch: { attempt: 3 } });
  const exhausted = qaFailNext({ attempt: 3 }, 3);
  assert.equal(exhausted.to, 'skipped');
  assert.equal(exhausted.patch.skip_reason, 'qa_attempts_exhausted');
});

test('regenNext respects the regen cap', () => {
  assert.deepEqual(regenNext({ attempt: 1 }, 2), { to: 'drafting', patch: { regen_count: 1, attempt: 2 } });
  assert.deepEqual(regenNext({ attempt: 2, regen_count: 1 }, 2), {
    to: 'drafting',
    patch: { regen_count: 2, attempt: 3 },
  });
  assert.equal(regenNext({ regen_count: 2 }, 2).to, 'skipped');
});

test('publishBackoffMs is 2^n · base minutes', () => {
  assert.equal(publishBackoffMs(1, 5), 10 * 60000);
  assert.equal(publishBackoffMs(2, 5), 20 * 60000);
  assert.equal(publishBackoffMs(3, 5), 40 * 60000);
  // default base is 5
  assert.equal(publishBackoffMs(1), 10 * 60000);
});

test('publishFailNext schedules retries then alerts', () => {
  const now = new Date('2026-07-14T17:00:00Z');
  const r1 = publishFailNext({ publish_attempts: 0 }, 3, 5, now);
  assert.equal(r1.to, 'publishing');
  assert.equal(r1.alert, false);
  assert.equal(r1.patch.publish_attempts, 1);
  assert.equal(new Date(r1.patch.next_attempt_at).getTime(), now.getTime() + 10 * 60000);

  const r2 = publishFailNext({ publish_attempts: 1 }, 3, 5, now);
  assert.equal(new Date(r2.patch.next_attempt_at).getTime(), now.getTime() + 20 * 60000);

  const r3 = publishFailNext({ publish_attempts: 2 }, 3, 5, now);
  assert.equal(new Date(r3.patch.next_attempt_at).getTime(), now.getTime() + 40 * 60000);

  const exhausted = publishFailNext({ publish_attempts: 3 }, 3, 5, now);
  assert.equal(exhausted.to, null);
  assert.equal(exhausted.alert, true);
});

test('transitionItem enforces legality, CASes the store, and logs a transition run', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem());

  const updated = await transitionItem(store, { item, to: 'drafting', stage: 'generate', runId: 'run_x' });
  assert.equal(updated.status, 'drafting');
  assert.equal((await store.getItem(item.id)).status, 'drafting');

  // illegal move throws and does not mutate
  const cur = await store.getItem(item.id);
  await assert.rejects(
    () => transitionItem(store, { item: cur, to: 'published', stage: 'x' }),
    IllegalTransitionError,
  );
  assert.equal((await store.getItem(item.id)).status, 'drafting');
});

test('transitionItem surfaces a CAS conflict when the item moved underneath', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem());
  // advance out from under a stale reference
  await store.transition(item.id, 'planned', 'drafting', {});
  await assert.rejects(
    () => transitionItem(store, { item, to: 'drafting', stage: 'x' }), // item.status is stale 'planned'
    CasConflictError,
  );
});
