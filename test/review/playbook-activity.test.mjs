// Tests for the AP-834 station surfaces: GET /api/activity (the employee's
// worklog), GET/POST /api/playbook (standing guidance: rules + owner notes).
// All file-mode via the fixture harness — the same Store contract postgres
// mode uses (pg parity for the underlying methods is covered in
// test/postgres-store.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupReviewTest } from './helpers.mjs';

async function postJson(baseUrl, path, payload) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/activity returns runs (empty on a fresh fixture) without erroring', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await fetch(`${h.baseUrl}/api/activity`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.runs), 'runs is always an array');
  assert.ok(body.generated_at, 'payload is timestamped');
});

test('POST /api/playbook/rules → active owner rule, visible in GET /api/playbook and to the brain', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const created = await postJson(h.baseUrl, '/api/playbook/rules', {
    rule: 'Always name the world in the first beat.',
    category: 'hook',
    weight: 8,
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.rule.id, 'the saved rule has an id');
  assert.equal(created.body.rule.status, 'active', 'owner rules go live immediately');
  assert.equal(created.body.rule.source, 'owner');
  assert.equal(created.body.rule.weight, 8);

  const playbook = await fetch(`${h.baseUrl}/api/playbook`).then((r) => r.json());
  assert.equal(playbook.rules.active.length, 1);
  assert.equal(playbook.rules.active[0].rule, 'Always name the world in the first beat.');
  assert.deepEqual(playbook.rules.retired, []);
  assert.ok(Array.isArray(playbook.notes));
});

test('POST /api/playbook/rules validates: empty rule, bad category, silly weight', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const empty = await postJson(h.baseUrl, '/api/playbook/rules', { rule: '   ' });
  assert.equal(empty.status, 400);

  const badCat = await postJson(h.baseUrl, '/api/playbook/rules', { rule: 'x', category: 'vibes' });
  assert.equal(badCat.status, 400);

  // out-of-range weight falls back to the default rather than failing the save
  const clamped = await postJson(h.baseUrl, '/api/playbook/rules', { rule: 'ok rule', category: 'caption', weight: 99 });
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.rule.weight, 6);
});

test('POST /api/playbook/rules/status retires and re-activates a rule', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const { body } = await postJson(h.baseUrl, '/api/playbook/rules', { rule: 'retire me', category: 'timing' });
  const id = body.rule.id;

  const retired = await postJson(h.baseUrl, '/api/playbook/rules/status', { id, status: 'retired' });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.rule.status, 'retired');

  let playbook = await fetch(`${h.baseUrl}/api/playbook`).then((r) => r.json());
  assert.equal(playbook.rules.active.length, 0);
  assert.equal(playbook.rules.retired.length, 1);

  const revived = await postJson(h.baseUrl, '/api/playbook/rules/status', { id, status: 'active' });
  assert.equal(revived.status, 200);
  playbook = await fetch(`${h.baseUrl}/api/playbook`).then((r) => r.json());
  assert.equal(playbook.rules.active.length, 1);

  const missing = await postJson(h.baseUrl, '/api/playbook/rules/status', { id: 'pr_nope', status: 'retired' });
  assert.equal(missing.status, 404);

  const badStatus = await postJson(h.baseUrl, '/api/playbook/rules/status', { id, status: 'paused' });
  assert.equal(badStatus.status, 400);
});

test('POST /api/playbook/notes captures a suggestion; GET lists newest first', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const a = await postJson(h.baseUrl, '/api/playbook/notes', { text: 'More prize-claw content in August.' });
  assert.equal(a.status, 200);
  assert.equal(a.body.note.processed, false, 'a fresh note is unprocessed');
  const b = await postJson(h.baseUrl, '/api/playbook/notes', { text: 'Try a duet format next month.' });
  assert.equal(b.status, 200);

  const playbook = await fetch(`${h.baseUrl}/api/playbook`).then((r) => r.json());
  assert.equal(playbook.notes.length, 2);
  assert.equal(playbook.notes[0].text, 'Try a duet format next month.', 'newest first');

  const empty = await postJson(h.baseUrl, '/api/playbook/notes', { text: '' });
  assert.equal(empty.status, 400);
});

test('a rule added through the station is injected into the next generate run', async (t) => {
  // End-to-end wiring proof for the suggestion loop: station POST → playbook
  // store → generate injects + the draft cites it in rationale AND sources.
  const { mkEnv } = await import('../helpers.mjs');
  const { runStage } = await import('../../src/stages/registry.mjs');
  const { FixtureBrain } = await import('../../src/drivers/fixture-brain.mjs');

  const { config, store } = mkEnv();
  const saved = await store.insertPlaybookRule({ rule: 'Open with the recipient, never the product.', category: 'hook', weight: 9 });
  assert.equal(saved.status, 'active');

  await runStage('plan', { config, store, date: '2026-07-13' });
  await runStage('generate', { config, store, date: '2026-07-14', brain: new FixtureBrain() });

  const drafted = await store.listByStatus('drafted');
  assert.ok(drafted.length > 0);
  for (const item of drafted) {
    assert.deepEqual(
      item.rationale.strategy.playbook_rules.map((r) => r.id),
      [saved.id],
      `${item.id} cites the station-added rule`,
    );
    assert.deepEqual(item.sources.generation.playbook_rules.map((r) => r.id), [saved.id]);
  }
});
