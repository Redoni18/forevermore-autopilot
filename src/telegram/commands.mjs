/**
 * @file Inbound update router: slash commands, decision callbacks, replies,
 * freeform text. Everything an allowlisted owner sends flows through here into
 * the SAME store/decide paths the Station uses — Telegram is never a second
 * source of truth.
 *
 * Non-owner chats are ignored (logged, no reply — never confirm the bot exists).
 */

import { spawn } from 'node:child_process';
import { decide, listGroupedItems } from '../decide/index.mjs';
import { parseCallback } from './callbacks.mjs';
import { parseNewCommand, commissionItem } from './newitem.mjs';
import * as cards from './cards.mjs';
import { localToday } from '../util/time.mjs';

const RULE_CATEGORIES = ['hook', 'caption', 'format', 'timing', 'world', 'visual'];

/**
 * Handle one Telegram update. Pure-ish: all side effects go through `store`,
 * `api`, and the injected `spawnTick`/`spawnDoctor` (tests stub these).
 * @param {Object} update  raw Telegram update
 * @param {Object} ctx  { store, config, api, chatId, log, bin }
 */
export async function handleUpdate(update, ctx) {
  const { chatId, log } = ctx;
  const from = update.callback_query
    ? update.callback_query.message?.chat?.id ?? update.callback_query.from?.id
    : update.message?.chat?.id;

  // Allowlist: ignore + log everything not from the owner chat.
  if (String(from) !== String(chatId)) {
    if (log) await log({ event: 'telegram.ignored', from, kind: update.callback_query ? 'callback' : 'message' });
    return { ignored: true };
  }

  if (update.callback_query) return handleCallback(update.callback_query, ctx);
  if (update.message) return handleMessage(update.message, ctx);
  return { skipped: true };
}

/* ------------------------------- callbacks ------------------------------- */

async function handleCallback(cq, ctx) {
  const { store, config, api } = ctx;
  const parsed = parseCallback(cq.data);
  if (!parsed) {
    await api.answerCallbackQuery(cq.id, { text: 'unrecognized' });
    return { handled: false };
  }
  const { itemId, action } = parsed;

  if (action === 'changes') {
    // Prompt for the note via ForceReply; the reply becomes the change request.
    await api.sendMessage(ctx.chatId, `✏️ Reply with your change note for <b>${cards.esc(itemId)}</b>`, {
      forceReply: true,
    });
    await api.answerCallbackQuery(cq.id, { text: 'reply with a note' });
    return { handled: true, action };
  }

  const decision = action === 'approve' ? 'approved' : 'rejected';
  const reasonTags = action === 'skip' ? ['skipped-via-telegram'] : [];
  const res = await decide({
    store,
    itemId,
    decision,
    reasonTags,
    via: 'telegram',
    regenMax: config.retry?.regen_max ?? 2,
  });

  if (!res.ok) {
    // 409 = already decided (double-tap safe) → friendly toast, no state change.
    const msg = res.status === 409 ? 'already decided' : res.error || 'failed';
    await api.answerCallbackQuery(cq.id, { text: msg });
    return { handled: true, action, conflict: res.status === 409 };
  }

  const label = action === 'approve' ? '✅ approved' : '⏭ skipped';
  await api.answerCallbackQuery(cq.id, { text: label });
  // Freeze the card's buttons so it can't be re-tapped.
  if (cq.message) {
    await api
      .editMessageReplyMarkup(ctx.chatId, cq.message.message_id, { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] })
      .catch(() => {});
  }
  const extra = res.autoSkipped ? ` (${res.autoSkipped} sibling${res.autoSkipped > 1 ? 's' : ''} auto-skipped)` : '';
  await api.sendMessage(ctx.chatId, `${label} <b>${cards.esc(itemId)}</b>${extra}`);
  if (ctx.log) await ctx.log({ event: 'telegram.decision', itemId, decision, via: 'telegram' });
  return { handled: true, action, decision };
}

/* -------------------------------- messages ------------------------------- */

async function handleMessage(msg, ctx) {
  const text = (msg.text || '').trim();
  if (!text) return { skipped: true };

  // A reply to a card/prompt = a change-request note on that item.
  if (msg.reply_to_message) {
    return handleReply(msg, ctx);
  }

  if (text.startsWith('/')) return handleCommand(text, ctx);

  // Freeform (non-reply, non-command) → suggestion box.
  await ctx.store.insertOwnerNote(text);
  await ctx.api.sendMessage(ctx.chatId, '✎ noted');
  return { handled: true, kind: 'note' };
}

async function handleReply(msg, ctx) {
  const { store, config, api } = ctx;
  const itemId = extractItemId(msg.reply_to_message?.text || '');
  if (!itemId) {
    // Reply to something we can't map → treat as a suggestion, don't lose it.
    await store.insertOwnerNote(msg.text);
    await api.sendMessage(ctx.chatId, '✎ noted (could not tie it to an item)');
    return { handled: true, kind: 'note-orphan' };
  }
  const res = await decide({
    store,
    itemId,
    decision: 'changes_requested',
    reasonTags: ['owner-note'],
    note: msg.text,
    via: 'telegram',
    regenMax: config.retry?.regen_max ?? 2,
  });
  if (!res.ok) {
    await api.sendMessage(ctx.chatId, `couldn't request changes on ${cards.esc(itemId)}: ${cards.esc(res.error || res.status)}`);
    return { handled: true, kind: 'changes', ok: false };
  }
  await api.sendMessage(ctx.chatId, `✏️ changes requested on <b>${cards.esc(itemId)}</b> — redraft on the next tick`);
  if (ctx.log) await ctx.log({ event: 'telegram.decision', itemId, decision: 'changes_requested', via: 'telegram' });
  return { handled: true, kind: 'changes', ok: true };
}

async function handleCommand(text, ctx) {
  const { store, config, api } = ctx;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = text.slice(cmd.length).trim();
  const base = cmd.replace(/@\w+$/, '').toLowerCase();

  switch (base) {
    case '/status': {
      await api.sendMessage(ctx.chatId, await buildStatus(ctx));
      return { handled: true, cmd: 'status' };
    }
    case '/queue': {
      const { groups } = await listGroupedItems({ store });
      const pending = [];
      for (const g of groups) for (const it of g.items || []) if (it.status === 'pending_review') pending.push(it);
      const lines = pending.length
        ? pending.map((i) => `• <b>${cards.esc(i.id)}</b> ${cards.esc(i.platform)} ${cards.esc(i.format)} — attempt ${i.attempt || 1}`)
        : ['(nothing awaiting review)'];
      await api.sendMessage(ctx.chatId, ['<b>Queue</b>', ...lines].join('\n'));
      return { handled: true, cmd: 'queue' };
    }
    case '/new': {
      const parsed = parseNewCommand(text);
      if (!parsed.ok) {
        await api.sendMessage(ctx.chatId, parsed.error);
        return { handled: true, cmd: 'new', ok: false };
      }
      const created = await commissionItem({ store, config, ...parsed });
      const when = /T(\d{2}:\d{2})/.exec(created.slot_at)?.[1] || '';
      await api.sendMessage(
        ctx.chatId,
        `🆕 <b>${cards.esc(created.id)}</b> planned — ${cards.esc(created.platform)} ${cards.esc(created.format)} at ${cards.esc(when)}, drafting on next tick`,
      );
      if (ctx.log) await ctx.log({ event: 'telegram.commission', itemId: created.id });
      return { handled: true, cmd: 'new', id: created.id };
    }
    case '/rule': {
      if (!arg) {
        await api.sendMessage(ctx.chatId, 'usage: /rule <text> [#hook|#caption|#format|#timing|#world|#visual]');
        return { handled: true, cmd: 'rule', ok: false };
      }
      const catMatch = arg.match(/#(\w+)/);
      const category = catMatch && RULE_CATEGORIES.includes(catMatch[1]) ? catMatch[1] : 'hook';
      const ruleText = arg.replace(/#\w+/g, '').trim();
      await store.insertPlaybookRule({ rule: ruleText, category, weight: 5, status: 'active', source: 'owner' });
      await api.sendMessage(ctx.chatId, `✓ rule added (${category})`);
      return { handled: true, cmd: 'rule' };
    }
    case '/pause': {
      await store.setSetting('kill_switch', true);
      await api.sendMessage(ctx.chatId, '⏸ paused — the next tick will no-op until /resume');
      return { handled: true, cmd: 'pause' };
    }
    case '/resume': {
      await store.setSetting('kill_switch', false);
      await api.sendMessage(ctx.chatId, '▶️ resumed');
      return { handled: true, cmd: 'resume' };
    }
    case '/tick': {
      await api.sendMessage(ctx.chatId, '⚙️ running a tick…');
      const spawnTick = ctx.spawnTick || defaultSpawn(ctx.bin, ['tick']);
      spawnTick()
        .then((r) => api.sendMessage(ctx.chatId, `tick done (exit ${r.code})`))
        .catch((e) => api.sendMessage(ctx.chatId, `tick error: ${cards.esc(e.message)}`));
      return { handled: true, cmd: 'tick' };
    }
    case '/digest': {
      await api.sendMessage(ctx.chatId, await buildDigest(ctx));
      return { handled: true, cmd: 'digest' };
    }
    case '/doctor': {
      await api.sendMessage(ctx.chatId, '🩺 running doctor…');
      const spawnDoctor = ctx.spawnDoctor || defaultSpawn(ctx.bin, ['doctor']);
      spawnDoctor()
        .then((r) => api.sendMessage(ctx.chatId, `<pre>${cards.esc(truncate(r.stdout || r.stderr || '(no output)', 3000))}</pre>`))
        .catch((e) => api.sendMessage(ctx.chatId, `doctor error: ${cards.esc(e.message)}`));
      return { handled: true, cmd: 'doctor' };
    }
    case '/help':
    case '/start': {
      await api.sendMessage(ctx.chatId, cards.helpText());
      return { handled: true, cmd: 'help' };
    }
    default: {
      await api.sendMessage(ctx.chatId, `unknown command ${cards.esc(base)}. /help`);
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
    quiet: (await store.getSetting('quiet_hours')) || config.telegram.quietHours,
  });
}

async function buildDigest(ctx) {
  const { store } = ctx;
  const { groups } = await listGroupedItems({ store });
  const byStatus = {};
  for (const g of groups) for (const it of g.items || []) byStatus[it.status] = (byStatus[it.status] || 0) + 1;
  const lines = Object.entries(byStatus).map(([k, v]) => `  ${k}: ${v}`);
  return ['<b>Digest</b>', lines.length ? lines.join('\n') : '  (empty)'].join('\n');
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
