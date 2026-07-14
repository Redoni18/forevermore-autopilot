// Integration: the neutral router + scanner over a real FileStore + fake
// Discord REST. Drives the same decide() paths the Station uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleEvent } from '../../src/control/commands.mjs';
import { runScanCycle } from '../../src/control/notify.mjs';
import { toNeutralEvent } from '../../src/discord/bot.mjs';
import { DiscordApi } from '../../src/discord/api.mjs';
import { runStage } from '../../src/stages/registry.mjs';
import { FixtureBrain } from '../../src/drivers/fixture-brain.mjs';
import { FakeDiscord } from './fake-api.mjs';
import { mkEnv, adapterStub, lintPass } from '../helpers.mjs';

const OWNER = '9007199254740993001'; // snowflake-sized: exceeds 2^53 on purpose
const CHANNEL = '9007199254740993555';
const RUN_DATE = '2026-07-13';
const SLOT_DATE = '2026-07-14';

async function seed(env) {
  await runStage('plan', { config: env.config, store: env.store, date: RUN_DATE });
  await runStage('generate', { config: env.config, store: env.store, date: SLOT_DATE, brain: new FixtureBrain() });
  await runStage('render', { config: env.config, store: env.store, date: SLOT_DATE, adapters: adapterStub });
  await runStage('qa', { config: env.config, store: env.store, date: SLOT_DATE, lintFn: lintPass });
}

async function boot() {
  const env = mkEnv();
  env.config.discord = { ...env.config.discord, enabled: true, channelId: CHANNEL, ownerId: OWNER, botToken: 't' };
  const fake = new FakeDiscord();
  const api = new DiscordApi({ token: 't', apiBase: await fake.start() });
  const ctx = { store: env.store, config: env.config, api, channelId: CHANNEL, ownerId: OWNER, log: async () => {} };
  return { env, fake, api, ctx };
}

/** A button interaction the way the gateway would dispatch it. */
function buttonInteraction(itemId, action, { authorId = OWNER, messageId = '900' } = {}) {
  const code = { approve: 'a', changes: 'c', skip: 's' }[action];
  return {
    type: 3,
    id: '111',
    token: 'itoken',
    channel_id: CHANNEL,
    member: { user: { id: authorId } },
    message: { id: messageId },
    data: { custom_id: `d:${itemId}:${code}` },
  };
}

test('approve button → approved via decide, siblings auto-skipped, card frozen', async () => {
  const { env, fake, api, ctx } = await boot();
  try {
    await seed(env);
    const group = await env.store.listByStatus('pending_review');
    const target = group[0];
    const siblings = group.filter((i) => i.candidate_group === target.candidate_group && i.id !== target.id);

    const ev = toNeutralEvent('INTERACTION_CREATE', buttonInteraction(target.id, 'approve'), { channelId: CHANNEL, api });
    assert.equal(ev.kind, 'button');
    const res = await handleEvent(ev, ctx);
    assert.equal(res.decision, 'approved');

    assert.equal((await env.store.getItem(target.id)).status, 'approved');
    const approvals = await env.store.listApprovals(target.id);
    assert.equal(approvals.at(-1).via, 'telegram'); // the chat-surface via value
    for (const s of siblings) assert.equal((await env.store.getItem(s.id)).status, 'skipped');

    assert.equal(fake.interactionResponses().length, 1, 'interaction acked');
    assert.equal(fake.edits().length, 1, 'card components stripped');
  } finally {
    await fake.stop();
  }
});

test('reply to a card (ledger-mapped message id) → changes_requested + bounce', async () => {
  const { env, fake, ctx } = await boot();
  try {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    // The scanner would have claimed + sent the card; simulate its ledger row.
    await env.store.tgClaim({
      kind: 'card',
      dedup_key: `card:${target.id}:pending_review:1`,
      item_id: target.id,
      chat_id: CHANNEL,
      payload: { text: 'x' },
    });
    await env.store.tgMarkSent(`card:${target.id}:pending_review:1`, { message_id: '9007199254740995123' });

    const ev = toNeutralEvent(
      'MESSAGE_CREATE',
      {
        channel_id: CHANNEL,
        author: { id: OWNER },
        content: 'tighten the hook, lead with the vault',
        referenced_message: { id: '9007199254740995123', content: 'no ci token here' },
      },
      { channelId: CHANNEL, api: ctx.api },
    );
    const res = await handleEvent(ev, ctx);
    assert.equal(res.kind, 'changes');
    assert.equal(res.ok, true);
    const after = await env.store.getItem(target.id);
    assert.equal(after.status, 'drafting');
    assert.equal(after.feedback.note, 'tighten the hook, lead with the vault');
  } finally {
    await fake.stop();
  }
});

test('changes tap arms the pending note: next plain message becomes the change request', async () => {
  const { env, fake, api, ctx } = await boot();
  try {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    await handleEvent(toNeutralEvent('INTERACTION_CREATE', buttonInteraction(target.id, 'changes'), { channelId: CHANNEL, api }), ctx);
    assert.equal((await env.store.getSetting('pending_change_note')).itemId, target.id, 'pending state armed');

    const msg = toNeutralEvent(
      'MESSAGE_CREATE',
      { channel_id: CHANNEL, author: { id: OWNER }, content: 'show one template thumbnail, not a grid of nine' },
      { channelId: CHANNEL, api: ctx.api },
    );
    const res = await handleEvent(msg, ctx);
    assert.equal(res.kind, 'changes');
    assert.equal(res.ok, true);
    const after = await env.store.getItem(target.id);
    assert.equal(after.status, 'drafting', 'plain message after the tap queued the redraft');
    assert.equal(after.feedback.note, 'show one template thumbnail, not a grid of nine');
    assert.equal(await env.store.getSetting('pending_change_note'), null, 'pending state consumed');

    // …and a later plain message is back to being a suggestion-box note.
    const later = await handleEvent(
      toNeutralEvent('MESSAGE_CREATE', { channel_id: CHANNEL, author: { id: OWNER }, content: 'love the matchday hooks' }, { channelId: CHANNEL, api: ctx.api }),
      ctx,
    );
    assert.equal(later.kind, 'note');
  } finally {
    await fake.stop();
  }
});

test('an EXPIRED pending note falls back to the suggestion box', async () => {
  const { env, fake, ctx } = await boot();
  try {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    await env.store.setSetting('pending_change_note', { itemId: target.id, at: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
    const res = await handleEvent(
      toNeutralEvent('MESSAGE_CREATE', { channel_id: CHANNEL, author: { id: OWNER }, content: 'stale thought' }, { channelId: CHANNEL, api: ctx.api }),
      ctx,
    );
    assert.equal(res.kind, 'note', 'expired pending → suggestion box, not a change request');
    assert.equal((await env.store.getItem(target.id)).status, 'pending_review', 'item untouched');
  } finally {
    await fake.stop();
  }
});

test('paused-tick run rows alone do NOT produce a tick summary', async () => {
  const { env, fake, api } = await boot();
  try {
    await seed(env);
    // Cycle 1 initializes the cursor + sends the cards.
    await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: new Date('2026-07-14T12:00:00Z') });
    // A paused tick writes kill-switch marker rows (status ok, nothing produced).
    for (const stage of ['plan', 'digest']) {
      await env.store.appendRun({ stage, status: 'ok', driver: 'deterministic', date: SLOT_DATE, note: 'kill_switch_engaged', started_at: '2026-07-14T12:05:00Z', finished_at: '2026-07-14T12:05:01Z' });
    }
    const r = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: new Date('2026-07-14T12:07:00Z') });
    assert.equal(r.byKind.summary || 0, 0, 'no "N awaiting review" spam from a do-nothing tick');
  } finally {
    await fake.stop();
  }
});

test('/new, /pause, /resume, freeform note and /rule flow through the router', async () => {
  const { env, fake, ctx } = await boot();
  try {
    const msg = (text) =>
      toNeutralEvent('MESSAGE_CREATE', { channel_id: CHANNEL, author: { id: OWNER }, content: text }, { channelId: CHANNEL, api: ctx.api });

    await handleEvent(msg('/new tiktok: a video about long-distance dads'), ctx);
    const commissioned = (await env.store.listByStatus('drafting')).find((i) => i.produced_by === 'telegram:/new');
    assert.ok(commissioned, 'commissioned item in drafting');
    assert.equal(commissioned.idea_id, null);

    await handleEvent(msg('/pause'), ctx);
    assert.equal(await env.store.getSetting('kill_switch'), true);
    await handleEvent(msg('/resume'), ctx);
    assert.equal(await env.store.getSetting('kill_switch'), false);

    await handleEvent(msg('try more matchday hooks'), ctx);
    assert.ok((await env.store.listOwnerNotes(10)).some((n) => n.text === 'try more matchday hooks'));

    await handleEvent(msg('/rule lead with the price #caption'), ctx);
    const rule = (await env.store.listPlaybookRules('active')).find((r) => r.rule === 'lead with the price');
    assert.equal(rule.category, 'caption');
  } finally {
    await fake.stop();
  }
});

test('scanner sends one card per pending item with buttons, deduped across cycles', async () => {
  const { env, fake, api } = await boot();
  try {
    await seed(env);
    const pending = await env.store.listByStatus('pending_review');
    const r1 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: new Date('2026-07-14T12:00:00Z') });
    assert.equal(r1.byKind.card, pending.length);
    // Cards carry components (attachment path uses multipart payload_json).
    const withComponents = fake
      .messages()
      .filter((m) => (m.body?.components || m.body?.payload?.components || []).length > 0);
    assert.ok(withComponents.length >= pending.length, 'cards carry button components');

    const r2 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: new Date('2026-07-14T12:01:00Z') });
    assert.equal(r2.byKind.card || 0, 0, 'no duplicate cards');
  } finally {
    await fake.stop();
  }
});

test('quiet hours hold cards; critical failure alert passes', async () => {
  const { env, fake, api } = await boot();
  try {
    await seed(env);
    // Initialize the runs cursor (first boot alerts on nothing historical).
    await env.store.setSetting('telegram_runs_cursor', new Date('2026-07-13T23:00:00Z').toISOString());
    const run = await env.store.appendRun({ stage: 'generate', status: 'failed', driver: 'test', date: SLOT_DATE, started_at: '2026-07-14T00:10:00Z', error: 'boom' });
    await env.store.updateRun(run.id, { status: 'failed', error: 'boom', finished_at: '2026-07-14T00:11:00Z' });
    const night = new Date('2026-07-14T00:30:00Z'); // 02:30 Tirane
    const r = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: night });
    assert.equal(r.byKind.card || 0, 0);
    assert.ok((r.byKind.alert || 0) >= 1);
  } finally {
    await fake.stop();
  }
});

test('first boot: cursor initializes to now, NO historical failure back-fill; cards still send', async () => {
  const { env, fake, api } = await boot();
  try {
    await seed(env);
    // A pile of OLD failures that must NOT become alerts on first boot.
    for (let i = 0; i < 5; i++) {
      const run = await env.store.appendRun({ stage: 'generate', status: 'failed', driver: 'test', date: SLOT_DATE, started_at: `2026-07-13T1${i}:00:00Z`, error: 'stale kit-loss failure' });
      await env.store.updateRun(run.id, { status: 'failed', error: 'stale kit-loss failure', finished_at: `2026-07-13T1${i}:01:00Z` });
    }
    assert.equal(await env.store.getSetting('telegram_runs_cursor'), undefined, 'no cursor before first boot');

    const now = new Date('2026-07-14T12:00:00Z');
    const r1 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now });
    assert.equal(r1.byKind.alert || 0, 0, 'no stale-failure alert flood on first boot');
    assert.ok((r1.byKind.card || 0) > 0, 'cards still send on first boot');
    assert.equal(await env.store.getSetting('telegram_runs_cursor'), now.toISOString(), 'cursor anchored to now');

    // A NEW failure after the cursor does alert on the next cycle.
    const run = await env.store.appendRun({ stage: 'render', status: 'failed', driver: 'test', date: SLOT_DATE, started_at: '2026-07-14T12:05:00Z', error: 'fresh boom' });
    await env.store.updateRun(run.id, { status: 'failed', error: 'fresh boom', finished_at: '2026-07-14T12:06:00Z' });
    const r2 = await runScanCycle({ store: env.store, config: env.config, api, chatId: CHANNEL, now: new Date('2026-07-14T12:07:00Z') });
    assert.ok((r2.byKind.alert || 0) >= 1, 'post-cursor failures still alert');
  } finally {
    await fake.stop();
  }
});

/* ── adversarial ────────────────────────────────────────────────────────── */

test('double-tap approve → one approval row, second tap acks "already decided"', async () => {
  const { env, fake, api, ctx } = await boot();
  try {
    await seed(env);
    const target = (await env.store.listByStatus('pending_review'))[0];
    const tap = () =>
      handleEvent(toNeutralEvent('INTERACTION_CREATE', buttonInteraction(target.id, 'approve'), { channelId: CHANNEL, api }), ctx);
    const first = await tap();
    const second = await tap();
    assert.equal(first.decision, 'approved');
    assert.equal(second.conflict, true);
    const approvals = (await env.store.listApprovals(target.id)).filter((a) => a.decision === 'approved');
    assert.equal(approvals.length, 1);
  } finally {
    await fake.stop();
  }
});

test('non-owner author is ignored: no store change, no outbound call', async () => {
  const { env, fake, api, ctx } = await boot();
  try {
    const ev = toNeutralEvent(
      'MESSAGE_CREATE',
      { channel_id: CHANNEL, author: { id: '424242' }, content: '/pause' },
      { channelId: CHANNEL, api },
    );
    const res = await handleEvent(ev, ctx);
    assert.equal(res.ignored, true);
    assert.equal(await env.store.getSetting('kill_switch'), undefined);
    assert.equal(fake.sent.length, 0);
  } finally {
    await fake.stop();
  }
});

test('bot and foreign-channel messages never become events', async () => {
  const { fake, api } = await boot();
  try {
    assert.equal(
      toNeutralEvent('MESSAGE_CREATE', { channel_id: CHANNEL, author: { id: OWNER, bot: true }, content: 'x' }, { channelId: CHANNEL, api }),
      null,
      'bot-authored messages are dropped (loop protection)',
    );
    assert.equal(
      toNeutralEvent('MESSAGE_CREATE', { channel_id: '777', author: { id: OWNER }, content: 'x' }, { channelId: CHANNEL, api }),
      null,
      'other channels are dropped',
    );
    assert.equal(
      toNeutralEvent('INTERACTION_CREATE', { type: 3, data: { custom_id: 'garbage' }, channel_id: CHANNEL }, { channelId: CHANNEL, api }),
      null,
      'malformed custom_id is dropped',
    );
  } finally {
    await fake.stop();
  }
});

test('snowflake-size message ids survive the ledger round-trip as strings', async () => {
  const { env, fake } = await boot();
  try {
    const bigMsg = '9007199254740993777'; // > 2^53
    await env.store.tgClaim({ kind: 'card', dedup_key: 'card:snow:1', item_id: null, chat_id: CHANNEL, payload: { text: 'x' } });
    await env.store.tgMarkSent('card:snow:1', { message_id: bigMsg });
    const found = await env.store.tgFindByMessage(CHANNEL, bigMsg);
    assert.ok(found, 'found by exact string id');
    assert.equal(found.message_id, bigMsg, 'no precision loss');
  } finally {
    await fake.stop();
  }
});
