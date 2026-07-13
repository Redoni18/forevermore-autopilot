// Integration: the router + scanner over a real FileStore + fake Bot API.
// Drives the decision paths end-to-end (same decide() the Station uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdate } from '../../src/telegram/commands.mjs';
import { runScanCycle } from '../../src/telegram/notify.mjs';
import { runStage } from '../../src/stages/registry.mjs';
import { FixtureBrain } from '../../src/drivers/fixture-brain.mjs';
import { TelegramApi } from '../../src/telegram/api.mjs';
import { FakeTelegram } from './fake-api.mjs';
import { mkEnv, adapterStub, lintPass } from '../helpers.mjs';

const CHAT = 900900;
const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

async function seed(env) {
  await runStage('plan', { config: env.config, store: env.store, date: RUN_DATE });
  await runStage('generate', { config: env.config, store: env.store, date: SLOT_DATE, brain: new FixtureBrain() });
  await runStage('render', { config: env.config, store: env.store, date: SLOT_DATE, adapters: adapterStub });
  await runStage('qa', { config: env.config, store: env.store, date: SLOT_DATE, lintFn: lintPass });
}

async function withBot(fn) {
  const env = mkEnv();
  env.config.telegram = { ...env.config.telegram, enabled: true, chatId: String(CHAT), botToken: 't' };
  const fake = new FakeTelegram();
  const base = await fake.start();
  const api = new TelegramApi({ token: 't', apiBase: base });
  const ctx = { store: env.store, config: env.config, api, chatId: String(CHAT), log: async () => {} };
  try {
    await fn({ env, fake, api, ctx });
  } finally {
    await fake.stop();
  }
}

test('approve callback → status approved, via:telegram, siblings auto-skipped', async () => {
  await withBot(async ({ env, fake, ctx }) => {
    await seed(env);
    const group = (await env.store.listByStatus('pending_review'));
    const target = group[0];
    const groupId = target.candidate_group;
    const siblings = group.filter((i) => i.candidate_group === groupId);
    assert.ok(siblings.length >= 2, 'candidate group has siblings to auto-skip');

    await handleUpdate(
      { callback_query: { id: 'cb1', data: `d:${target.id}:a`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 5 } } },
      ctx,
    );

    const after = await env.store.getItem(target.id);
    assert.equal(after.status, 'approved');
    const approvals = await env.store.listApprovals(target.id);
    assert.equal(approvals.at(-1).via, 'telegram');
    for (const s of siblings.filter((i) => i.id !== target.id)) {
      assert.equal((await env.store.getItem(s.id)).status, 'skipped', `${s.id} auto-skipped`);
    }
    // The buttons were frozen (editMessageReplyMarkup called).
    assert.equal(fake.sentOf('editMessageReplyMarkup').length, 1);
  });
});

test('reply to a card → changes_requested + redraft bounce to drafting', async () => {
  await withBot(async ({ env, ctx }) => {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    await handleUpdate(
      {
        message: {
          chat: { id: CHAT },
          from: { id: CHAT },
          text: 'show the product before the end card',
          reply_to_message: { text: `🎬 ${target.id} — instagram reel` },
        },
      },
      ctx,
    );
    const after = await env.store.getItem(target.id);
    assert.equal(after.status, 'drafting', 'a change request queues a redraft');
    assert.equal(after.feedback.note, 'show the product before the end card');
  });
});

test('/new commissions an item that lands in drafting for the next tick', async () => {
  await withBot(async ({ env, ctx }) => {
    await handleUpdate(
      { message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/new tiktok: a video about long-distance dads' } },
      ctx,
    );
    const drafting = await env.store.listByStatus('drafting');
    const commissioned = drafting.find((i) => i.produced_by === 'telegram:/new');
    assert.ok(commissioned, 'commissioned item exists in drafting');
    assert.equal(commissioned.platform, 'tiktok');
    assert.equal(commissioned.idea_id, null, 'off-list marker');
    assert.match(commissioned.feedback.note, /long-distance dads/);
  });
});

test('/pause and /resume toggle the kill switch', async () => {
  await withBot(async ({ env, ctx }) => {
    await handleUpdate({ message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/pause' } }, ctx);
    assert.equal(await env.store.getSetting('kill_switch'), true);
    await handleUpdate({ message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/resume' } }, ctx);
    assert.equal(await env.store.getSetting('kill_switch'), false);
  });
});

test('freeform message → owner note', async () => {
  await withBot(async ({ env, ctx }) => {
    await handleUpdate({ message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'try more matchday hooks' } }, ctx);
    const notes = await env.store.listOwnerNotes(10);
    assert.ok(notes.some((n) => n.text === 'try more matchday hooks'));
  });
});

test('/rule adds an active owner playbook rule with a category', async () => {
  await withBot(async ({ env, ctx }) => {
    await handleUpdate({ message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/rule lead with the price #caption' } }, ctx);
    const rules = await env.store.listPlaybookRules('active');
    const r = rules.find((x) => x.rule === 'lead with the price');
    assert.ok(r);
    assert.equal(r.category, 'caption');
    assert.equal(r.source, 'owner');
  });
});

/* ── scanner ────────────────────────────────────────────────────────────── */

test('scanner sends one card per pending item, deduped across cycles', async () => {
  await withBot(async ({ env, fake, api, ctx }) => {
    await seed(env);
    const pending = await env.store.listByStatus('pending_review');
    const r1 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: new Date('2026-07-14T12:00:00Z') });
    assert.equal(r1.byKind.card, pending.length, 'a card per pending item');
    const r2 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: new Date('2026-07-14T12:01:00Z') });
    assert.equal(r2.byKind.card || 0, 0, 'no duplicate cards on the next cycle');
  });
});

test('quiet hours hold non-critical cards but pass a critical alert', async () => {
  await withBot(async ({ env, api }) => {
    await seed(env);
    // Force a failure run (critical) so we can prove it bypasses quiet hours.
    const run = await env.store.appendRun({ stage: 'generate', status: 'failed', driver: 'test', date: SLOT_DATE, started_at: new Date().toISOString(), error: 'boom' });
    await env.store.updateRun(run.id, { status: 'failed', error: 'boom', finished_at: new Date().toISOString() });

    const night = new Date('2026-07-14T00:30:00Z'); // 02:30 Tirane → quiet
    const r = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: night });
    assert.equal(r.byKind.card || 0, 0, 'cards held during quiet hours');
    assert.ok((r.byKind.alert || 0) >= 1, 'the failure alert still fires');
  });
});

test('liveness alert fires when unpaused and the last tick is stale', async () => {
  await withBot(async ({ env, api }) => {
    await env.store.setSetting('last_tick_at', { at: '2026-07-14T09:00:00Z', paused: false });
    const later = new Date('2026-07-14T11:00:00Z'); // >90 min after
    const r = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: later });
    assert.ok((r.byKind.alert || 0) >= 1, 'liveness alert sent');
  });
});
