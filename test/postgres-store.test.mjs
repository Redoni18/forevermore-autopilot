// PostgresStore contract tests — mirroring the critical FileStore cases
// (roundtrip, CAS conflict via concurrent transitions, listByStatus, approvals
// incl. changes_requested, settings) against the live control-plane DB. Each
// test is hermetic (tagged rows, cleaned up) and SKIPS cleanly when the DB is
// unreachable. See test/pg-helpers.mjs for the isolation model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasConflictError } from '../src/types.mjs';
import { pgTest, pgItem } from './pg-helpers.mjs';

test('pg putItem/getItem roundtrip preserves the file-mode slug ids + shape', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const saved = await store.putItem(pgItem(tag, 1, { produced_by: `run_${tag}_gen` }));
  assert.ok(saved.created_at && saved.updated_at, 'timestamps stamped');
  assert.equal(saved.id, `ci_${tag}_1`, 'putItem echoes the caller slug id');

  const got = await store.getItem(`ci_${tag}_1`);
  assert.equal(got.id, `ci_${tag}_1`);
  assert.equal(got.status, 'planned');
  assert.equal(got.candidate_group, `cg_${tag}`, 'slug candidate_group survives the uuid column');
  assert.equal(got.produced_by, `run_${tag}_gen`, 'slug produced_by survives via the envelope');
  assert.equal(got.caption, `caption ${tag}-1`);
  assert.deepEqual(got.hashtags, ['forevermore', 'giftideas']);
  assert.deepEqual(got.overlays, { hook: `hook ${tag}-1` }, 'overlays returns clean (envelope stripped)');
  assert.equal(got.assets.length, 1);
  assert.equal(got.lint.passed, true);

  assert.equal(await store.getItem(`ci_${tag}_missing`), null, 'missing item → null');
});

test('pg putItem upserts (same slug id → one row, updated in place)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  await store.putItem(pgItem(tag, 1, { caption: 'first' }));
  await store.putItem(pgItem(tag, 1, { caption: 'second', status: 'drafted' }));
  const got = await store.getItem(`ci_${tag}_1`);
  assert.equal(got.caption, 'second');
  assert.equal(got.status, 'drafted');

  const drafted = (await store.listByStatus('drafted')).filter((i) => i.id === `ci_${tag}_1`);
  assert.equal(drafted.length, 1, 'exactly one row after upsert');
});

test('pg transition CAS: two concurrent transitions, exactly one wins', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 2));
  const results = await Promise.allSettled([
    store.transition(item.id, 'planned', 'drafting', { by: 'A' }),
    store.transition(item.id, 'planned', 'drafting', { by: 'B' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one transition commits');
  assert.equal(rejected.length, 1, 'the other is rejected');
  assert.equal(rejected[0].reason.code, 'CAS_CONFLICT');
  assert.equal((await store.getItem(item.id)).status, 'drafting');
});

test('pg transition: mismatched `from` throws CasConflictError with the actual status', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 3));
  await assert.rejects(() => store.transition(item.id, 'rendered', 'pending_review', {}), (err) => {
    assert.ok(err instanceof CasConflictError);
    assert.equal(err.code, 'CAS_CONFLICT');
    assert.equal(err.actual, 'planned');
    return true;
  });
  assert.equal((await store.getItem(item.id)).status, 'planned', 'untouched');
});

test('pg transition: missing item rejects with "no such item"', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);
  await assert.rejects(() => store.transition(`ci_${tag}_nope`, 'planned', 'drafting', {}), /no such item/);
});

test('pg transition applies whitelisted column patches, drops file-mode-only keys', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const item = await store.putItem(pgItem(tag, 4, { status: 'pending_review' }));
  const updated = await store.transition(item.id, 'pending_review', 'approved', {
    chosen: true,
    caption: 'approved caption',
    skip_reason: 'not-a-column', // dropped silently
  });
  assert.equal(updated.status, 'approved');
  assert.equal(updated.chosen, true);
  assert.equal(updated.caption, 'approved caption');
  assert.equal(updated.skip_reason, undefined, 'non-column patch keys are not surfaced');
});

test('pg listByStatus filters (single + multi)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  await store.putItem(pgItem(tag, 1, { status: 'planned' }));
  await store.putItem(pgItem(tag, 2, { status: 'pending_review' }));
  await store.putItem(pgItem(tag, 3, { status: 'drafted' }));

  const mine = (arr) => arr.filter((i) => i.id.startsWith(`ci_${tag}_`)).map((i) => i.id).sort();
  assert.deepEqual(mine(await store.listByStatus('pending_review')), [`ci_${tag}_2`]);
  assert.deepEqual(mine(await store.listByStatus(['planned', 'drafted'])), [`ci_${tag}_1`, `ci_${tag}_3`]);
});

test('pg approvals: appendApproval (incl. changes_requested + local-station) then listApprovals sorted', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const id = `ci_${tag}_1`;
  await store.putItem(pgItem(tag, 1));
  await store.appendApproval({ content_item_id: id, decision: 'approved', via: 'cli' });
  await store.appendApproval({
    content_item_id: id,
    decision: 'changes_requested',
    reason_tags: ['hook-weak', 'timing'],
    note: 'sharpen the open',
    via: 'local-station',
  });

  const list = await store.listApprovals(id);
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.id && a.decided_at), 'every approval has id + decided_at');
  assert.ok(list.every((a) => a.content_item_id === id), 'content_item_id echoes the slug');
  assert.deepEqual([...new Set(list.map((a) => a.decision))].sort(), ['approved', 'changes_requested']);
  const cr = list.find((a) => a.decision === 'changes_requested');
  assert.deepEqual(cr.reason_tags, ['hook-weak', 'timing']);
  assert.equal(cr.via, 'local-station');
  assert.deepEqual(await store.listApprovals(`ci_${tag}_other`), []);
});

test('pg rationale (AP-831) roundtrips through putItem + a transition patch', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const rationale = {
    summary: 'a first-person reel that lands the tension fast.',
    hook_reasoning: 'opens on a concrete POV.',
    strategy: {
      idea_id: 'F03',
      idea_title: 'gamer-partner wedge',
      pillar: 'P4',
      playbook_rules: [{ id: 'aee31fc7', rule: 'orientation beat' }],
    },
    craft: ['POV framing', 'orientation beat'],
    limits: ['kinetic-text video — no footage yet'],
    audience: 'partners of gamers.',
  };

  const saved = await store.putItem(pgItem(tag, 1, { rationale }));
  assert.deepEqual(saved.rationale, rationale, 'putItem persists the jsonb thinking log');
  assert.deepEqual((await store.getItem(`ci_${tag}_1`)).rationale, rationale, 'getItem returns it');

  const drafted = await store.transition(`ci_${tag}_1`, 'planned', 'drafting', {
    rationale: { ...rationale, summary: 'revised' },
  });
  assert.equal(drafted.rationale.summary, 'revised', 'transition patch updates rationale');
  assert.equal((await store.getItem(`ci_${tag}_1`)).rationale.summary, 'revised');
});

test('pg sources (AP-833) roundtrips through putItem + a transition patch merge', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const plan = {
    picked_because: 'Best available for this reel slot: format fit purpose-built; score 100.',
    idea: { id: 'F03', title: 'gamer-partner wedge' },
    score: 100,
    runners_up: [{ id: 'F04', title: 'x', score: 90 }],
  };
  const saved = await store.putItem(pgItem(tag, 1, { sources: { plan } }));
  assert.deepEqual(saved.sources, { plan }, 'putItem persists the jsonb source log');
  assert.deepEqual((await store.getItem(`ci_${tag}_1`)).sources, { plan }, 'getItem returns it');

  // The generate stage merges its layer over the planner's, then patches whole.
  const generation = { skill: { stage: 'copywriter' }, playbook_rules: [], recent_posts: 0 };
  const drafted = await store.transition(`ci_${tag}_1`, 'planned', 'drafting', {
    sources: { plan, generation },
  });
  assert.deepEqual(drafted.sources.generation, generation, 'transition patch adds the generation layer');
  assert.deepEqual(drafted.sources.plan, plan, 'the planner layer survives');
});

test('pg getRun returns the row by uuid; slug id or unknown → null', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(async () => {
    // sweep the appended run so it never pollutes the live activity feed
    await store.sql`delete from autopilot.runs where driver = ${`test-${tag}`}`;
    await cleanup();
  });

  const run = await store.appendRun({ stage: 'generate', driver: `test-${tag}`, model: 'claude-x', tokens_in: 900, tokens_out: 120, cost_usd: 0.0042, prompt_sha: 'abc123' });
  const got = await store.getRun(run.id);
  assert.equal(got.id, run.id);
  assert.equal(got.stage, 'generate');
  assert.equal(got.model, 'claude-x');
  assert.equal(got.tokens_in, 900);
  assert.equal(got.cost_usd, 0.0042);
  assert.equal(await store.getRun('run_file_mode_slug'), null, 'a file-mode slug run id has no uuid row');
});

test('pg playbook write path: insert → active, retire → status filter moves it (AP-834)', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(async () => {
    await store.sql`delete from autopilot.playbook_rules where rule like ${`%${tag}%`}`;
    await store.sql`delete from autopilot.owner_notes where text like ${`%${tag}%`}`;
    await store.sql`delete from autopilot.runs where driver = ${`test-${tag}`}`;
    await cleanup();
  });

  const saved = await store.insertPlaybookRule({ rule: `station rule ${tag}`, category: 'hook', weight: 7 });
  assert.ok(saved.id, 'insert returns the uuid id');
  assert.equal(saved.status, 'active');
  assert.equal(saved.source, 'owner');
  assert.ok(saved.decided_at, 'an active rule is stamped decided_at');

  const active = await store.listPlaybookRules('active');
  assert.ok(active.some((r) => r.id === saved.id), 'the new rule is injectable immediately');

  const retired = await store.setPlaybookRuleStatus(saved.id, 'retired');
  assert.equal(retired.status, 'retired');
  assert.ok(!(await store.listPlaybookRules('active')).some((r) => r.id === saved.id));
  assert.ok((await store.listPlaybookRules('retired')).some((r) => r.id === saved.id));

  assert.equal(await store.setPlaybookRuleStatus('not-a-uuid', 'retired'), null, 'non-uuid id → null, no throw');

  // owner notes inbox
  const note = await store.insertOwnerNote(`note ${tag}: more claw-machine content`);
  assert.equal(note.processed, false);
  const notes = await store.listOwnerNotes(10);
  assert.ok(notes.some((n) => n.id === note.id), 'the note is listed');

  // activity: listRuns excludes transition noise and sorts newest-first
  // (driver carries the tag so t.after can sweep this row out of the live feed)
  const run = await store.appendRun({ stage: 'generate', driver: `test-${tag}` });
  const runs = await store.listRuns({ limit: 10 });
  assert.ok(runs.length >= 1);
  assert.equal(runs[0].id, run.id, 'the just-appended run leads the feed');
  assert.ok(runs.every((r) => r.stage !== 'transition'), 'transition audit rows are excluded');
});

test('pg listPlaybookRules: active owner rules, weight-desc, id/rule/weight shaped; status filter works', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const active = await store.listPlaybookRules('active');
  assert.ok(active.length >= 1, 'the live DB carries active owner rules');
  for (const r of active) {
    assert.ok(typeof r.id === 'string' && r.id.length, 'rule has an id (for citation)');
    assert.ok(typeof r.rule === 'string' && r.rule.length, 'rule has text');
    assert.equal(typeof r.weight, 'number');
    assert.equal(r.status, 'active');
  }
  // weight-desc ordering (the brain-injection contract).
  for (let i = 1; i < active.length; i++) {
    assert.ok(active[i - 1].weight >= active[i].weight, 'rules are weight-desc');
  }
  // the owner's orientation-beat rule is present and citable.
  assert.ok(active.some((r) => /orientation beat/i.test(r.rule)), 'orientation-beat rule is active');

  // status filter: a tagged proposed rule shows under 'proposed', not 'active'.
  const probe = `AP831-probe-${tag}`;
  await store.sql`insert into autopilot.playbook_rules (rule, category, status, source, weight) values (${probe}, 'hook', 'proposed', 'reflection', 4)`;
  try {
    const proposed = await store.listPlaybookRules('proposed');
    assert.ok(proposed.some((r) => r.rule === probe), 'proposed rule appears under proposed');
    assert.ok(!(await store.listPlaybookRules('active')).some((r) => r.rule === probe), 'not under active');
  } finally {
    await store.sql`delete from autopilot.playbook_rules where rule = ${probe}`;
  }
});

test('pg settings: get/set roundtrip for boolean + object values', async (t) => {
  const ctx = await pgTest(t);
  if (!ctx) return;
  const { store, tag, cleanup } = ctx;
  t.after(cleanup);

  const kSwitch = `test_${tag}_kill_switch`;
  const kCadence = `test_${tag}_cadence`;
  assert.equal(await store.getSetting(kSwitch), undefined, 'unset key → undefined');

  await store.setSetting(kSwitch, false);
  assert.equal(await store.getSetting(kSwitch), false);
  await store.setSetting(kSwitch, true); // upsert overwrites
  assert.equal(await store.getSetting(kSwitch), true);
  await store.setSetting(kCadence, { ig: 1, tt: 2 });
  assert.deepEqual(await store.getSetting(kCadence), { ig: 1, tt: 2 });

  const all = await store.getSettings();
  assert.equal(all[kSwitch], true);
  assert.deepEqual(all[kCadence], { ig: 1, tt: 2 });
});
