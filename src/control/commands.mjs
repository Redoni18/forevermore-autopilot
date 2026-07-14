/**
 * @file Inbound event router (channel-neutral): decision buttons, replies,
 * slash-style text commands, freeform text. Everything the allowlisted owner
 * sends flows through the SAME store/decide paths the Station uses — the chat
 * channel is never a second source of truth.
 *
 * The transport (src/discord/bot.mjs) normalizes its wire events into:
 *   {kind:'button', itemId, action, ack(text), channelId, messageId, authorId}
 *   {kind:'text',   text, authorId, channelId, replyToMessageId?, replyToText?}
 * Non-owner events are ignored (logged, no reply — never confirm the bot
 * exists to strangers).
 */

import { spawn } from 'node:child_process';
import { decide, listGroupedItems } from '../decide/index.mjs';
import { parseNewCommand, commissionItem } from './newitem.mjs';
import * as cards from './cards.mjs';
import { localToday } from '../util/time.mjs';

const RULE_CATEGORIES = ['hook', 'caption', 'format', 'timing', 'world', 'visual'];

/**
 * Handle one normalized inbound event.
 * @param {Object} ev  neutral event (see file header)
 * @param {Object} ctx  { store, config, api, channelId, ownerId, log, bin,
 *                        spawnTick?, spawnDoctor? }
 */
export async function handleEvent(ev, ctx) {
  const { ownerId, log } = ctx;
  if (String(ev.authorId) !== String(ownerId)) {
    if (log) await log({ event: 'control.ignored', from: ev.authorId, kind: ev.kind });
    return { ignored: true };
  }
  if (ev.kind === 'button') return handleButton(ev, ctx);
  if (ev.kind === 'text') return handleText(ev, ctx);
  return { skipped: true };
}

/* ------------------------------- buttons ------------------------------- */

async function handleButton(ev, ctx) {
  const { store, config, api } = ctx;
  const { itemId, action } = ev;

  if (action === 'changes') {
    // Arm the pending-note state: the owner's NEXT plain message becomes the
    // change note for this item (no Discord reply mechanics needed — seen live
    // 2026-07-14: the owner typed a normal message after tapping Changes and
    // it fell into the suggestion box). Replying to the card still works too.
    await store.setSetting('pending_change_note', { itemId, at: new Date().toISOString() });
    await ev.ack(`✏️ Now send your change note for ${itemId} (any message counts)`);
    return { handled: true, action };
  }

  const decision = action === 'approve' ? 'approved' : 'rejected';
  const reasonTags = action === 'skip' ? ['skipped-via-chat'] : [];
  const res = await decide({
    store,
    itemId,
    decision,
    reasonTags,
    via: 'telegram', // the chat-surface via value (migration 0004); channel-neutral by intent
    regenMax: config.retry?.regen_max ?? 2,
  });

  if (!res.ok) {
    await ev.ack(res.status === 409 ? 'already decided' : res.error || 'failed');
    return { handled: true, action, conflict: res.status === 409 };
  }

  const label = action === 'approve' ? '✅ approved' : '⏭ skipped';
  await ev.ack(label);
  // Freeze the card: strip its buttons so it can't be re-tapped.
  if (ev.channelId && ev.messageId) {
    await api.editMessageComponents(ev.channelId, ev.messageId, []).catch(() => {});
  }
  const extra = res.autoSkipped ? ` (${res.autoSkipped} sibling${res.autoSkipped > 1 ? 's' : ''} auto-skipped)` : '';
  await api.sendMessage(ctx.channelId, `${label} **${cards.esc(itemId)}**${extra}`);
  if (ctx.log) await ctx.log({ event: 'control.decision', itemId, decision });
  return { handled: true, action, decision };
}

/* -------------------------------- text --------------------------------- */

const PENDING_NOTE_TTL_MS = 10 * 60 * 1000;

async function handleText(ev, ctx) {
  const text = (ev.text || '').trim();
  if (!text) return { skipped: true };

  if (ev.replyToMessageId || ev.replyToText) return handleReply(ev, ctx);
  if (text.startsWith('/')) return handleCommand(text, ctx);

  // A recent ✏️ Changes tap arms the next plain message as that item's change
  // note (10-min fuse) — the natural "tap, then type" flow.
  const pending = await ctx.store.getSetting('pending_change_note');
  if (pending && pending.itemId && Date.now() - new Date(pending.at).getTime() < PENDING_NOTE_TTL_MS) {
    await ctx.store.setSetting('pending_change_note', null);
    return applyChangeNote(pending.itemId, text, ctx);
  }

  await ctx.store.insertOwnerNote(text);
  await ctx.api.sendMessage(ctx.channelId, '✎ noted');
  return { handled: true, kind: 'note' };
}

async function handleReply(ev, ctx) {
  const { store, config, api } = ctx;
  // Prefer the ledger mapping (message id → item); fall back to the quoted text.
  let itemId = null;
  if (ev.replyToMessageId) {
    const row = await store.tgFindByMessage(String(ev.channelId), String(ev.replyToMessageId));
    if (row && row.item_id) itemId = row.item_id;
  }
  if (!itemId) itemId = extractItemId(ev.replyToText || '');

  if (!itemId) {
    await store.insertOwnerNote(ev.text);
    await api.sendMessage(ctx.channelId, '✎ noted (could not tie it to an item)');
    return { handled: true, kind: 'note-orphan' };
  }
  return applyChangeNote(itemId, ev.text, ctx);
}

/** The one change-request path (reply-to-card AND pending-note both land here). */
async function applyChangeNote(itemId, note, ctx) {
  const { store, config, api } = ctx;
  const res = await decide({
    store,
    itemId,
    decision: 'changes_requested',
    reasonTags: ['owner-note'],
    note,
    via: 'telegram',
    regenMax: config.retry?.regen_max ?? 2,
  });
  if (!res.ok) {
    await api.sendMessage(ctx.channelId, `couldn't request changes on ${cards.esc(itemId)}: ${cards.esc(String(res.error || res.status))}`);
    return { handled: true, kind: 'changes', ok: false };
  }
  await api.sendMessage(ctx.channelId, `✏️ changes requested on **${cards.esc(itemId)}** — redraft on the next tick`);
  if (ctx.log) await ctx.log({ event: 'control.decision', itemId, decision: 'changes_requested' });
  return { handled: true, kind: 'changes', ok: true };
}

async function handleCommand(text, ctx) {
  const { store, config, api } = ctx;
  const [cmd] = text.split(/\s+/);
  const arg = text.slice(cmd.length).trim();
  const base = cmd.toLowerCase();

  switch (base) {
    case '/status': {
      await api.sendMessage(ctx.channelId, await buildStatus(ctx));
      return { handled: true, cmd: 'status' };
    }
    case '/queue': {
      const { groups } = await listGroupedItems({ store });
      const pending = [];
      for (const g of groups) for (const it of g.items || []) if (it.status === 'pending_review') pending.push(it);
      const lines = pending.length
        ? pending.map((i) => `• **${cards.esc(i.id)}** ${cards.esc(i.platform)} ${cards.esc(i.format)} — attempt ${i.attempt || 1}`)
        : ['(nothing awaiting review)'];
      await api.sendMessage(ctx.channelId, ['**Queue**', ...lines].join('\n'));
      return { handled: true, cmd: 'queue' };
    }
    case '/new': {
      const parsed = parseNewCommand(text);
      if (!parsed.ok) {
        await api.sendMessage(ctx.channelId, parsed.error);
        return { handled: true, cmd: 'new', ok: false };
      }
      const created = await commissionItem({ store, config, ...parsed });
      const when = /T(\d{2}:\d{2})/.exec(created.slot_at)?.[1] || '';
      await api.sendMessage(
        ctx.channelId,
        `🆕 **${cards.esc(created.id)}** planned — ${cards.esc(created.platform)} ${cards.esc(created.format)} at ${cards.esc(when)}, drafting on next tick`,
      );
      if (ctx.log) await ctx.log({ event: 'control.commission', itemId: created.id });
      return { handled: true, cmd: 'new', id: created.id };
    }
    case '/rule': {
      if (!arg) {
        await api.sendMessage(ctx.channelId, 'usage: /rule <text> [#hook|#caption|#format|#timing|#world|#visual]');
        return { handled: true, cmd: 'rule', ok: false };
      }
      const catMatch = arg.match(/#(\w+)/);
      const category = catMatch && RULE_CATEGORIES.includes(catMatch[1]) ? catMatch[1] : 'hook';
      const ruleText = arg.replace(/#\w+/g, '').trim();
      await store.insertPlaybookRule({ rule: ruleText, category, weight: 5, status: 'active', source: 'owner' });
      await api.sendMessage(ctx.channelId, `✓ rule added (${category})`);
      return { handled: true, cmd: 'rule' };
    }
    case '/pause': {
      await store.setSetting('kill_switch', true);
      await api.sendMessage(ctx.channelId, '⏸ paused — the next tick will no-op until /resume');
      return { handled: true, cmd: 'pause' };
    }
    case '/resume': {
      await store.setSetting('kill_switch', false);
      await api.sendMessage(ctx.channelId, '▶️ resumed');
      return { handled: true, cmd: 'resume' };
    }
    case '/tick': {
      await api.sendMessage(ctx.channelId, '⚙️ running a tick…');
      const spawnTick = ctx.spawnTick || defaultSpawn(ctx.bin, ['tick']);
      spawnTick()
        .then((r) => api.sendMessage(ctx.channelId, `tick done (exit ${r.code})`))
        .catch((e) => api.sendMessage(ctx.channelId, `tick error: ${cards.esc(e.message)}`));
      return { handled: true, cmd: 'tick' };
    }
    case '/digest': {
      await api.sendMessage(ctx.channelId, await buildDigest(ctx));
      return { handled: true, cmd: 'digest' };
    }
    case '/doctor': {
      await api.sendMessage(ctx.channelId, '🩺 running doctor…');
      const spawnDoctor = ctx.spawnDoctor || defaultSpawn(ctx.bin, ['doctor']);
      spawnDoctor()
        .then((r) => api.sendMessage(ctx.channelId, codeBlock(truncate(r.stdout || r.stderr || '(no output)', 1800))))
        .catch((e) => api.sendMessage(ctx.channelId, `doctor error: ${cards.esc(e.message)}`));
      return { handled: true, cmd: 'doctor' };
    }
    case '/help':
    case '/start': {
      await api.sendMessage(ctx.channelId, cards.helpText());
      return { handled: true, cmd: 'help' };
    }
    default: {
      await api.sendMessage(ctx.channelId, `unknown command ${cards.esc(base)}. /help`);
      return { handled: true, cmd: 'unknown' };
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

/** Pull the item id out of a card/prompt body (the `ci_...` token). */
export function extractItemId(text) {
  const m = /\bci_\d{8}_[a-z]{2}_[a-z]?\d+\b/.exec(String(text || ''));
  return m ? m[0] : null;
}

async function buildStatus(ctx) {
  const { store, config } = ctx;
  const items = await store.listItems();
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  const today = localToday();
  return cards.statusText({
    counts,
    lastTickAt: (await store.getSetting('last_tick_at'))?.at,
    spend: await store.dailySpend(today),
    cap: Number((await store.getSetting('daily_spend_cap_usd')) ?? config.daily_spend_cap_usd ?? 0),
    paused: (await store.getSetting('kill_switch')) === true || config.envKillSwitch,
    quiet: (await store.getSetting('quiet_hours')) || config.discord?.quietHours,
  });
}

async function buildDigest(ctx) {
  const { store } = ctx;
  const { groups } = await listGroupedItems({ store });
  const byStatus = {};
  for (const g of groups) for (const it of g.items || []) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  const lines = Object.entries(byStatus).map(([k, v]) => `  ${k}: ${v}`);
  return ['**Digest**', lines.length ? lines.join('\n') : '  (empty)'].join('\n');
}

function defaultSpawn(bin, args) {
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function codeBlock(s) {
  return '```\n' + String(s).replace(/```/g, "'''") + '\n```';
}
