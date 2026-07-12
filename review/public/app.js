// Autopilot local review station — vanilla JS, no build step, no deps.
// Talks to GET /api/items + POST /api/decide. See autopilot/review/server.mjs.

const REASON_TAGS = ['hook-weak', 'off-voice', 'wrong-world', 'too-salesy', 'timing', 'duplicate', 'other'];
const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok' };
const OUTCOME_LABELS = { approved: 'Approved', changes_requested: 'Changes requested', skipped: 'Rejected' };

const state = {
  items: new Map(), // id -> item
  cardEls: new Map(), // id -> pending card element
  groupOrder: [], // candidate_group keys, in board render order
  pendingOrder: [], // pending item ids, in reading order (for j/k)
  focusId: null,
  busy: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------- API

const API = {
  async items() {
    const res = await fetch('/api/items');
    if (!res.ok) throw new Error(`GET /api/items -> ${res.status}`);
    return res.json();
  },
  async decide(payload) {
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `POST /api/decide -> ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  },
};

// ---------------------------------------------------------------- formatting

function formatSlot(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}
function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}
function assetUrl(itemId, assetPath) {
  return `/assets/${encodeURIComponent(itemId)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

// -------------------------------------------------------------------- toast

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.className = `toast toast-${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function describeOutcome(result) {
  const d = result.decision.decision;
  const base = {
    approved: 'Approved.',
    edited: 'Approved with edited caption.',
    changes_requested: 'Changes requested.',
    rejected: 'Rejected.',
  }[d] || 'Saved.';
  const n = result.autoSkipped?.length || 0;
  return n ? `${base} ${n} sibling candidate${n > 1 ? 's' : ''} auto-skipped.` : base;
}

// -------------------------------------------------------------------- header

function renderHeader(data) {
  $('#hd-date').textContent = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  }).format(new Date());
  $('#hd-pending').textContent = `${data.pending_count} pending`;

  const killEl = $('#hd-kill');
  const killSwitch = data.settings ? data.settings.kill_switch : undefined;
  if (typeof killSwitch === 'boolean') {
    killEl.hidden = false;
    killEl.textContent = killSwitch ? 'kill switch: ON' : 'kill switch: off';
    killEl.classList.toggle('kill-on', killSwitch);
  } else {
    killEl.hidden = true;
  }
}

// --------------------------------------------------------------------- board

function renderBoard(data) {
  state.items = new Map();
  state.cardEls = new Map();
  state.groupOrder = [];
  state.pendingOrder = [];

  const board = $('#board');
  board.textContent = '';

  if (!data.groups.length) {
    board.innerHTML = `<div class="empty">no items in the outbox yet. run <code>generate</code>, or point
      <code>--outbox</code> at <code>autopilot/fixtures/outbox-sample</code> to try the station.</div>`;
    return;
  }

  for (const group of data.groups) {
    state.groupOrder.push(group.candidate_group);

    const col = document.createElement('section');
    col.className = 'group';
    col.dataset.group = group.candidate_group;
    col.appendChild(renderGroupHeader(group));

    const stack = document.createElement('div');
    stack.className = 'stack';
    col.appendChild(stack);

    for (const item of group.items) {
      state.items.set(item.id, item);
      if (item.status === 'pending_review') {
        const card = buildPendingCard(item);
        state.cardEls.set(item.id, card);
        state.pendingOrder.push(item.id);
        stack.appendChild(card);
      } else {
        stack.appendChild(buildDecidedCard(item));
      }
    }

    board.appendChild(col);
  }

  if (!state.focusId || !state.pendingOrder.includes(state.focusId)) {
    state.focusId = state.pendingOrder[0] || null;
  }
  applyFocusStyles();
}

function renderGroupHeader(group) {
  const el = document.createElement('div');
  el.className = 'group-hd';
  el.innerHTML = `
    <div class="group-chips">
      <span class="chip plat">${esc(PLATFORM_LABELS[group.platform] || group.platform)}</span>
      <span class="chip">${esc(group.format)}</span>
      ${group.pillar ? `<span class="chip">${esc(group.pillar)}</span>` : ''}
    </div>
    <div class="group-slot">${esc(formatSlot(group.slot_at))}</div>
    <div class="group-count">${group.pending_count}/${group.items.length} pending</div>`;
  return el;
}

// ------------------------------------------------------------- pending card

function renderMedia(item) {
  const asset = item.assets && item.assets[0];
  if (!asset) return `<div class="media no-asset">no asset</div>`;
  const ratio = asset.w && asset.h ? `${asset.w} / ${asset.h}` : '9 / 16';
  const url = assetUrl(item.id, asset.path);
  const altText = esc(item.overlays?.hook || 'candidate preview');
  if (asset.kind === 'video') {
    return `<div class="media" style="aspect-ratio:${ratio}">
      <video muted loop autoplay playsinline controls preload="metadata" src="${url}"></video>
    </div>`;
  }
  return `<div class="media" style="aspect-ratio:${ratio}"><img src="${url}" alt="${altText}" loading="lazy" /></div>`;
}

function renderLintBadge(lint) {
  const violations = lint?.violations || [];
  const hasBlock = violations.some((v) => v.severity === 'block');
  const hasWarn = violations.some((v) => v.severity === 'warn');
  const level = hasBlock ? 'block' : hasWarn ? 'warn' : 'pass';
  const label = level === 'pass'
    ? 'lint pass'
    : `${violations.length} ${level === 'warn' ? 'warning' : 'blocker'}${violations.length > 1 ? 's' : ''}`;
  const list = violations.length
    ? `<ul class="lint-list">${violations.map((v) => `<li><b>${esc(v.rule)}</b> — ${esc(v.excerpt || '')}</li>`).join('')}</ul>`
    : '';
  return `<div class="lint-badge lint-${level}"><span class="lint-dot"></span>${esc(label)}${list}</div>`;
}

function renderDedupeNote(dedupe) {
  if (!dedupe) return '';
  const sim = dedupe.hook_sim ?? 0;
  const pct = Math.round(sim * 100);
  const level = sim >= 0.55 ? 'hot' : sim >= 0.4 ? 'warm' : 'cool';
  const near = dedupe.nearest_item ? ` vs ${esc(dedupe.nearest_item)}` : ' (no close match)';
  return `<span class="dedupe dedupe-${level}">similarity ${pct}%${near}</span>`;
}

function buildPendingCard(item) {
  const card = document.createElement('article');
  card.className = 'card pending';
  card.dataset.id = item.id;
  if (item.risk === 'sensitive') card.classList.add('sensitive');

  card.innerHTML = `
    ${item.risk === 'sensitive' ? `
      <div class="sensitive-banner">
        <span>Sensitive — memorial / kids / UGC risk</span>
        <div class="confirm-row">
          <input type="text" class="confirm-input" placeholder="type CONFIRM to unlock actions" autocomplete="off" spellcheck="false" />
        </div>
      </div>` : ''}
    <div class="media-wrap">${renderMedia(item)}</div>
    <div class="hook">${esc(item.overlays?.hook || '')}</div>
    <div class="caption-block">
      <textarea class="caption-edit" rows="3">${esc(item.caption || '')}</textarea>
      <div class="caption-hint">click caption or press <kbd>e</kbd> to edit</div>
    </div>
    <div class="meta-row">
      ${renderLintBadge(item.lint)}
      ${renderDedupeNote(item.dedupe)}
    </div>
    <div class="chips chips-meta">
      <span class="chip">${esc(PLATFORM_LABELS[item.platform] || item.platform)}</span>
      <span class="chip">${esc(item.format)}</span>
      ${item.pillar ? `<span class="chip">${esc(item.pillar)}</span>` : ''}
      <span class="chip risk-${esc(item.risk)}">${esc(item.risk)}</span>
      ${item.hashtags?.length ? `<span class="chip hashtags">${item.hashtags.length} tag${item.hashtags.length > 1 ? 's' : ''}</span>` : ''}
    </div>
    <div class="actions">
      <button type="button" class="btn approve" data-action="approve">Approve <kbd>a</kbd></button>
      <button type="button" class="btn edit" data-action="edit">Edit <kbd>e</kbd></button>
      <button type="button" class="btn changes" data-action="changes_requested">Request changes <kbd>c</kbd></button>
      <button type="button" class="btn reject" data-action="rejected">Reject <kbd>r</kbd></button>
    </div>
    <div class="reason-panel" hidden>
      <div class="reason-chips">${REASON_TAGS.map((t) => `<button type="button" class="reason-chip" data-tag="${t}">${t}</button>`).join('')}</div>
      <textarea class="note-box" placeholder="optional note… (required if you pick 'other')"></textarea>
      <div class="panel-error" hidden></div>
      <div class="reason-actions">
        <button type="button" class="btn ghost" data-action="cancel-reason">Cancel <kbd>esc</kbd></button>
        <button type="button" class="btn submit-reason" data-action="submit-reason">Submit</button>
      </div>
    </div>
    <div class="card-error" hidden></div>`;

  wirePendingCard(card, item);
  return card;
}

function wirePendingCard(card, item) {
  const originalCaption = item.caption || '';
  const captionBlock = card.querySelector('.caption-block');
  const captionEdit = card.querySelector('.caption-edit');
  const reasonPanel = card.querySelector('.reason-panel');

  card.addEventListener('click', () => {
    state.focusId = item.id;
    applyFocusStyles();
  });

  // Clicking anywhere in the caption block (not just the exact <textarea>
  // rect — including the hint text under it) focuses the editor. This
  // matters: if a click narrowly misses the textarea, the page never gains
  // field focus, and the next keystrokes of an intended caption edit would
  // instead fire the global j/k/n/a/e/c/r shortcuts (e.g. an 'a' typed as
  // part of a normal sentence would silently approve the card).
  captionBlock.addEventListener('click', (e) => {
    if (e.target !== captionEdit) captionEdit.focus();
  });

  captionEdit.addEventListener('input', () => {
    captionBlock.classList.toggle('dirty', captionEdit.value !== originalCaption);
  });

  if (item.risk === 'sensitive') {
    const confirmInput = card.querySelector('.confirm-input');
    const actionButtons = card.querySelectorAll('.actions .btn');
    actionButtons.forEach((b) => { b.disabled = true; });
    confirmInput.addEventListener('input', () => {
      const ok = confirmInput.value === 'CONFIRM';
      card.classList.toggle('confirmed', ok);
      actionButtons.forEach((b) => { b.disabled = !ok; });
    });
  }

  card.querySelector('[data-action="approve"]').addEventListener('click', () => submitApprove(card, item));
  card.querySelector('[data-action="edit"]').addEventListener('click', () => focusCaptionEditor(card));
  card.querySelector('[data-action="changes_requested"]').addEventListener('click', () => openReasonPanel(card, 'changes_requested'));
  card.querySelector('[data-action="rejected"]').addEventListener('click', () => openReasonPanel(card, 'rejected'));
  card.querySelector('[data-action="cancel-reason"]').addEventListener('click', () => closeReasonPanel(card));
  card.querySelector('[data-action="submit-reason"]').addEventListener('click', () => submitReasonPanel(card, item));

  reasonPanel.querySelectorAll('.reason-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });
}

function focusCaptionEditor(card) {
  const el = card.querySelector('.caption-edit');
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function guardSensitive(card, item) {
  if (item.risk !== 'sensitive' || card.classList.contains('confirmed')) return true;
  const input = card.querySelector('.confirm-input');
  if (input) {
    input.focus();
    input.classList.remove('shake');
    // eslint-disable-next-line no-unused-expressions
    void input.offsetWidth; // restart the animation on repeated attempts
    input.classList.add('shake');
  }
  return false;
}

function openReasonPanel(card, decisionType) {
  const panel = card.querySelector('.reason-panel');
  panel.dataset.decision = decisionType;
  panel.hidden = false;
  panel.querySelectorAll('.reason-chip').forEach((b) => b.classList.remove('selected'));
  panel.querySelector('.note-box').value = '';
  panel.querySelector('.panel-error').hidden = true;
  card.classList.add('panel-open');
  panel.querySelector('.note-box').focus();
}

function closeReasonPanel(card) {
  const panel = card.querySelector('.reason-panel');
  panel.hidden = true;
  card.classList.remove('panel-open');
}

function submitApprove(card, item) {
  const dirty = card.querySelector('.caption-block').classList.contains('dirty');
  const captionAfter = card.querySelector('.caption-edit').value;
  if (dirty) attemptDecide(card, item, 'edited', { captionAfter });
  else attemptDecide(card, item, 'approved');
}

function submitReasonPanel(card, item) {
  const panel = card.querySelector('.reason-panel');
  const decisionType = panel.dataset.decision;
  const tags = [...panel.querySelectorAll('.reason-chip.selected')].map((b) => b.dataset.tag);
  const note = panel.querySelector('.note-box').value.trim();
  const errEl = panel.querySelector('.panel-error');

  if (!tags.length && !note) {
    errEl.textContent = 'pick at least one reason tag or add a note.';
    errEl.hidden = false;
    return;
  }
  if (tags.includes('other') && !note) {
    errEl.textContent = "add a note explaining 'other'.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  attemptDecide(card, item, decisionType, { reasonTags: tags, note: note || null });
}

async function attemptDecide(card, item, decision, extra = {}) {
  if (!guardSensitive(card, item)) return;
  if (state.busy.has(item.id)) return;

  state.busy.add(item.id);
  card.classList.add('busy');
  clearCardError(card);

  try {
    const result = await API.decide({
      itemId: item.id,
      decision,
      reasonTags: extra.reasonTags || [],
      note: extra.note ?? null,
      captionAfter: extra.captionAfter ?? null,
    });
    toast(describeOutcome(result));
    await reload();
  } catch (err) {
    showCardError(card, err.message || 'failed to save decision');
  } finally {
    state.busy.delete(item.id);
    card.classList.remove('busy');
  }
}

function showCardError(card, msg) {
  const el = card.querySelector('.card-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function clearCardError(card) {
  const el = card?.querySelector('.card-error');
  if (el) el.hidden = true;
}

// ------------------------------------------------------------- decided card

function renderCaptionDiff(diff) {
  return `<div class="caption-diff">
    <div class="diff-before"><span class="diff-label">before</span>${esc(diff.before)}</div>
    <div class="diff-after"><span class="diff-label">after</span>${esc(diff.after)}</div>
  </div>`;
}

function buildDecidedCard(item) {
  const card = document.createElement('article');
  card.className = `card decided outcome-${item.status}`;
  card.dataset.id = item.id;

  const d = item.decision || {};
  let outcomeLabel = OUTCOME_LABELS[item.status] || item.status;
  if (item.status === 'approved' && d.decision === 'edited') outcomeLabel = 'Edited & approved';
  if (item.status === 'skipped' && d.reason_tags?.includes('candidate-not-chosen')) outcomeLabel = 'Not chosen (auto)';

  card.innerHTML = `
    <button type="button" class="decided-summary">
      <span class="outcome-dot"></span>
      <span class="outcome-label">${esc(outcomeLabel)}</span>
      <span class="outcome-time">${d.decided_at ? formatTime(d.decided_at) : ''}</span>
      <span class="chev">details</span>
    </button>
    <div class="decided-detail" hidden>
      <div class="hook">${esc(item.overlays?.hook || '')}</div>
      ${d.reason_tags?.length ? `<div class="chips">${d.reason_tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${d.note ? `<div class="note-quote">"${esc(d.note)}"</div>` : ''}
      ${d.caption_diff ? renderCaptionDiff(d.caption_diff) : `<div class="caption-final">${esc(item.caption || '')}</div>`}
      ${item.feedback ? `<div class="feedback"><b>feedback:</b> ${esc(item.feedback.note || '(tags only, no note)')}</div>` : ''}
    </div>`;

  card.querySelector('.decided-summary').addEventListener('click', () => {
    const detail = card.querySelector('.decided-detail');
    detail.hidden = !detail.hidden;
  });

  return card;
}

// -------------------------------------------------------------- keyboard nav

function applyFocusStyles() {
  document.querySelectorAll('.card.focused').forEach((c) => c.classList.remove('focused'));
  const el = state.focusId ? state.cardEls.get(state.focusId) : null;
  if (el) el.classList.add('focused');
}

function scrollFocusedIntoView() {
  const el = state.focusId ? state.cardEls.get(state.focusId) : null;
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function moveFocus(delta) {
  if (!state.pendingOrder.length) return;
  let idx = state.pendingOrder.indexOf(state.focusId);
  if (idx === -1) idx = 0;
  idx = Math.min(Math.max(idx + delta, 0), state.pendingOrder.length - 1);
  state.focusId = state.pendingOrder[idx];
  applyFocusStyles();
  scrollFocusedIntoView();
}

function jumpNextGroup() {
  if (!state.pendingOrder.length) return;
  if (!state.focusId) {
    state.focusId = state.pendingOrder[0];
    applyFocusStyles();
    scrollFocusedIntoView();
    return;
  }
  const current = state.items.get(state.focusId);
  const curGroupIdx = state.groupOrder.indexOf(current?.candidate_group);
  for (let i = curGroupIdx + 1; i < state.groupOrder.length; i++) {
    const g = state.groupOrder[i];
    const firstPending = state.pendingOrder.find((id) => state.items.get(id).candidate_group === g);
    if (firstPending) {
      state.focusId = firstPending;
      applyFocusStyles();
      scrollFocusedIntoView();
      return;
    }
  }
}

function focusedCardAndItem() {
  if (!state.focusId) return null;
  const item = state.items.get(state.focusId);
  const card = state.cardEls.get(state.focusId);
  return item && card ? { item, card } : null;
}

function wireGlobalKeyboard() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    if (e.key === 'Escape') {
      if (inField) { active.blur(); return; }
      document.querySelectorAll('.card.panel-open').forEach((c) => closeReasonPanel(c));
      return;
    }

    if (inField) return; // let normal typing through
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't hijack Cmd/Ctrl/Alt combos (copy, reload, etc.)

    const ctx = () => focusedCardAndItem();
    switch (e.key) {
      case 'j': moveFocus(1); break;
      case 'k': moveFocus(-1); break;
      case 'n': jumpNextGroup(); break;
      case 'a': { const c = ctx(); if (c) submitApprove(c.card, c.item); break; }
      case 'e': { const c = ctx(); if (c) focusCaptionEditor(c.card); break; }
      case 'c': { const c = ctx(); if (c) openReasonPanel(c.card, 'changes_requested'); break; }
      case 'r': { const c = ctx(); if (c) openReasonPanel(c.card, 'rejected'); break; }
      default: return;
    }
    e.preventDefault();
  });
}

// ------------------------------------------------------------------- boot

async function reload() {
  try {
    const data = await API.items();
    renderHeader(data);
    renderBoard(data);
  } catch (err) {
    $('#board').innerHTML = `<div class="empty error">failed to load /api/items: ${esc(err.message)}</div>`;
  }
}

async function init() {
  wireGlobalKeyboard();
  await reload();
}

init();
