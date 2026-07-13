// Adversarial: double-tap, non-owner, orphan reply, restart mid-queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdate } from '../../src/telegram/commands.mjs';
import { runScanCycle } from '../../src/telegram/notify.mjs';
import { runStage } from '../../src/stages/registry.mjs';
import { FixtureBrain } from '../../src/drivers/fixture-brain.mjs';
import { TelegramApi } from '../../src/telegram/api.mjs';
import { FakeTelegram } from './fake-api.mjs';
import { mkEnv, adapterStub, lintPass } from '../helpers.mjs';

const CHAT = 555;
const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

async function boot() {
  const env = mkEnv();
  env.config.telegram = { ...env.config.telegram, enabled: true, chatId: String(CHAT), botToken: 't' };
  const fake = new FakeTelegram();
  const api = new TelegramApi({ token: 't', apiBase: await fake.start() });
  const ctx = { store: env.store, config: env.config, api, chatId: String(CHAT), log: async () => {} };
  return { env, fake, api, ctx };
}

async function seed(env) {
  await runStage('plan', { config: env.config, store: env.store, date: RUN_DATE });
  await runStage('generate', { config: env.config, store: env.store, date: SLOT_DATE, brain: new FixtureBrain() });
  await runStage('render', { config: env.config, store: env.store, date: SLOT_DATE, adapters: adapterStub });
  await runStage('qa', { config: env.config, store: env.store, date: SLOT_DATE, lintFn: lintPass });
}

test('double-tap approve → exactly one approval, second is a 409 no-op', async () => {
  const { env, fake, ctx } = await boot();
  try {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    const tap = () =>
      handleUpdate(
        { callback_query: { id: 'x', data: `d:${target.id}:a`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: 1 } } },
        ctx,
      );
    const first = await tap();
    const second = await tap();
    assert.equal(first.decision, 'approved');
    assert.equal(second.conflict, true, 'second tap is a 409 conflict');
    const approvals = (await env.store.listApprovals(target.id)).filter((a) => a.decision === 'approved');
    assert.equal(approvals.length, 1, 'only one approval recorded');
    // The second answerCallbackQuery said "already decided".
    const answers = fake.sentOf('answerCallbackQuery');
    assert.ok(answers.some((a) => /already/.test(a.params.text || '')));
  } finally {
    await fake.stop();
  }
});

test('non-owner chat is ignored — no store change, no reply', async () => {
  const { env, fake, ctx } = await boot();
  try {
    const before = (await env.store.listOwnerNotes(50)).length;
    const res = await handleUpdate({ message: { chat: { id: 999999 }, from: { id: 999999 }, text: '/pause' } }, ctx);
    assert.equal(res.ignored, true);
    assert.equal(await env.store.getSetting('kill_switch'), undefined, 'kill switch untouched');
    assert.equal((await env.store.listOwnerNotes(50)).length, before);
    assert.equal(fake.sent.length, 0, 'the bot sent nothing back');
  } finally {
    await fake.stop();
  }
});

test('reply to an unmappable message becomes an owner note (nothing lost)', async () => {
  const { env, fake, ctx } = await boot();
  try {
    await handleUpdate(
      { message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'good idea', reply_to_message: { text: 'a message with no item id' } } },
      ctx,
    );
    assert.ok((await env.store.listOwnerNotes(10)).some((n) => n.text === 'good idea'));
  } finally {
    await fake.stop();
  }
});

test('restart mid-queue: sent cards are not resent; a claimed-unsent card resends once', async () => {
  const { env, fake, api } = await boot();
  try {
    await seed(env);
    const now = new Date('2026-07-14T12:00:00Z');
    const r1 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now });
    const firstCards = r1.byKind.card;
    assert.ok(firstCards >= 1);

    // Simulate a crash BETWEEN claim and send for one item: claim a card row
    // that never got a message_id, aged past the 5-min retry threshold.
    await env.store.tgClaim({
      kind: 'card',
      dedup_key: 'card:orphan_item:pending_review:1',
      chat_id: CHAT,
      payload: { text: 'orphaned card body' },
    });
    // Backdate its created_at so it's an eligible orphan.
    // (FileStore stores the ledger as JSON — mutate via a fresh claim age trick:
    //  tgListUnsent uses created_at < now-olderThanMs; advance `now` instead.)
    const later = new Date(now.getTime() + 6 * 60 * 1000);

    const sentBefore = fake.sentOf('sendMessage').length + fake.sentOf('sendVideo').length + fake.sentOf('sendPhoto').length;
    const r2 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: later });
    // The already-sent pending cards are NOT resent — the only thing that goes
    // out this cycle is the one orphaned claim (also a 'card' kind).
    assert.equal(r2.sent, 1, 'only the orphaned claim is (re)sent, no duplicate pending cards');
    const sentAfter = fake.sentOf('sendMessage').length + fake.sentOf('sendVideo').length + fake.sentOf('sendPhoto').length;
    assert.equal(sentAfter - sentBefore, 1, 'the orphaned claim resent exactly once');
    // And it's now marked sent, so a third cycle resends nothing.
    const r3 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHAT, now: new Date(later.getTime() + 6 * 60 * 1000) });
    assert.equal(r3.sent, 0, 'orphan not resent again once marked sent');
  } finally {
    await fake.stop();
  }
});
