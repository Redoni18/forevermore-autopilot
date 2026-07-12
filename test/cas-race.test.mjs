import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasConflictError } from '../src/types.mjs';
import { mkEnv, plannedItem } from './helpers.mjs';

test('two concurrent transitions from the same state: exactly one wins', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem());

  const results = await Promise.allSettled([
    store.transition(item.id, 'planned', 'drafting', { by: 'A' }),
    store.transition(item.id, 'planned', 'drafting', { by: 'B' }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one transition should commit');
  assert.equal(rejected.length, 1, 'the other should be rejected');
  assert.equal(rejected[0].reason.code, 'CAS_CONFLICT');
  assert.equal((await store.getItem(item.id)).status, 'drafting');
});

test('many concurrent racers: still exactly one winner', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem());

  const N = 12;
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, k) => store.transition(item.id, 'planned', 'drafting', { racer: k })),
  );
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, N - 1);
  for (const l of losers) assert.equal(l.reason.code, 'CAS_CONFLICT');
  assert.equal((await store.getItem(item.id)).status, 'drafting');
});

test('transition with a mismatched `from` throws CasConflictError', async () => {
  const { store } = mkEnv();
  const item = await store.putItem(plannedItem());
  await assert.rejects(() => store.transition(item.id, 'rendered', 'pending_review', {}), CasConflictError);
  // untouched
  assert.equal((await store.getItem(item.id)).status, 'planned');
});

test('transition on a missing item rejects', async () => {
  const { store } = mkEnv();
  await assert.rejects(() => store.transition('ci_nope', 'planned', 'drafting', {}), /no such item/);
});
