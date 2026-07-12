// Tests for GET /api/items: fixture shape, grouping, pending counts, and
// autopilot/settings.json handling (both tolerated shapes — see lib/settings.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { setupReviewTest, copyFixtureOutbox, startTestServer } from './helpers.mjs';

test('GET /api/items: fixture loads as 2 groups of 3, all pending_review', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.getItems();
  assert.equal(res.status, 200);
  assert.equal(res.body.pending_count, 6);
  assert.equal(res.body.groups.length, 2);

  const ig = res.body.groups.find((g) => g.candidate_group === 'cg_20260713_ig_1830');
  const tt = res.body.groups.find((g) => g.candidate_group === 'cg_20260714_tt_0900');
  assert.ok(ig && tt, 'both fixture candidate groups are present');
  assert.equal(ig.items.length, 3);
  assert.equal(tt.items.length, 3);
  assert.equal(ig.platform, 'instagram');
  assert.equal(tt.platform, 'tiktok');
  assert.equal(ig.pending_count, 3);
  assert.equal(tt.pending_count, 3);

  // exactly one sensitive item and one lint-warning item, per the fixture spec
  const allItems = res.body.groups.flatMap((g) => g.items);
  assert.equal(allItems.filter((i) => i.risk === 'sensitive').length, 1);
  const warned = allItems.filter((i) => (i.lint?.violations || []).some((v) => v.severity === 'warn'));
  assert.equal(warned.length, 1);
  const blocked = allItems.filter((i) => (i.lint?.violations || []).some((v) => v.severity === 'block'));
  assert.equal(blocked.length, 0);
});

test('GET /api/items: every fixture item exposes the PRD §5 asset contract', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  const res = await h.getItems();
  const allItems = res.body.groups.flatMap((g) => g.items);
  assert.equal(allItems.length, 6);
  for (const item of allItems) {
    assert.ok(item.assets && item.assets.length >= 1, `${item.id} has an asset`);
    const asset = item.assets[0];
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${item.id} asset sha256 looks real`);
    assert.ok(asset.w > 0 && asset.h > 0, `${item.id} asset has dims`);
  }
});

test('GET /api/items: settings is null when settings.json is absent', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());
  const res = await h.getItems();
  assert.equal(res.body.settings, null);
});

test('GET /api/items: settings.json as a flat object surfaces kill_switch', async (t) => {
  const paths = await copyFixtureOutbox();
  await writeFile(paths.settingsPath, JSON.stringify({ kill_switch: true, autonomy_level: 'L1' }), 'utf8');
  const h = await startTestServer(paths);
  t.after(async () => {
    await h.close();
    await paths.cleanup();
  });

  const res = await h.getItems();
  assert.equal(res.body.settings.kill_switch, true);
  assert.equal(res.body.settings.autonomy_level, 'L1');
});

test('GET /api/items: settings.json as a KV-row array also resolves (mirrors the Supabase settings table shape)', async (t) => {
  const paths = await copyFixtureOutbox();
  await writeFile(
    paths.settingsPath,
    JSON.stringify([{ key: 'kill_switch', value: false }, { key: 'autonomy_level', value: 'L1' }]),
    'utf8',
  );
  const h = await startTestServer(paths);
  t.after(async () => {
    await h.close();
    await paths.cleanup();
  });

  const res = await h.getItems();
  assert.equal(res.body.settings.kill_switch, false);
  assert.equal(res.body.settings.autonomy_level, 'L1');
});

test('GET /api/items: a decided item carries its latest decision record for UI context', async (t) => {
  const h = await setupReviewTest();
  t.after(() => h.teardown());

  await h.decide({ itemId: 'ci_20260713_ig_3', decision: 'rejected', reasonTags: ['off-voice'], note: 'not us' });

  const res = await h.getItems();
  const group = res.body.groups.find((g) => g.candidate_group === 'cg_20260713_ig_1830');
  const decided = group.items.find((i) => i.id === 'ci_20260713_ig_3');
  assert.equal(decided.status, 'skipped');
  assert.ok(decided.decision, 'decided item has a decision record attached');
  assert.equal(decided.decision.decision, 'rejected');
  assert.deepEqual(decided.decision.reason_tags, ['off-voice']);
  assert.equal(decided.decision.note, 'not us');

  // the still-pending siblings do NOT carry a decision field
  const stillPending = group.items.find((i) => i.id === 'ci_20260713_ig_1');
  assert.equal(stillPending.decision, undefined);
});
