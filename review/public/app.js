// Autopilot station — v3 (AP-834). Vanilla JS, no build step, no deps.
//
// The station is the owner's half of the human-in-the-loop contract:
//   Review   — the queue, one honest detail panel per item: the actual media
//              (no phone mocks), the caption, the model's THINKING, the
//              SOURCES it pulled from, the decision timeline, and the four
//              decisions (approve / edit / request changes / reject).
//   Planned  — the week ahead, with the planner's own reasoning per slot.
//   History  — every decision taken, filterable.
//   Playbook — standing guidance: owner rules (live at the next generation,
//              cited by id in every draft's thinking log) + a free-form
//              suggestion inbox. This is where "tell the autopilot" lives.
//   Activity — the employee's worklog: pipeline runs + decisions, merged.
//
// API: GET /api/items · POST /api/decide · GET /api/activity ·
//      GET/POST /api/playbook* — see review/lib/app.mjs.

const REASON_TAGS = ['hook-weak', 'off-voice', 'wrong-world', 'too-salesy', 'timing', 'duplicate', 'other'];
const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok' };
const FORMAT_LABELS = { reel: 'Reel', image: 'Image', carousel: 'Carousel', story: 'Story', video: 'Video', tiktok_video: 'Video' };
const OUTCOME_LABELS = {
  approved: 'Approved',
  edited: 'Edited & approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  skipped: 'Skipped',
};
const RULE_CATEGORIES = ['hook', 'caption', 'format', 'timing', 'world', 'visual'];
const RISK_TOOLTIP =
  'Risk class controls approval strictness: evergreen may auto-publish at L2 · standard always needs your tap · sensitive requires typed confirmation';
// Items the EMPLOYEE currently owes work on (your change requests + QA
// bounces + mid-render). The tick sweeps these every ~30 minutes; each label
// says which stage the item is waiting on / inside.
const REWORK_LABELS = {
  drafting: 'queued for redraft',
  drafted: 'redrafted — waiting to render',
  rendering: 'rendering now',
  rendered: 'in QA',
  qa_failed: 'failed QA — retrying',
};
const REWORK_STATUSES = new Set(Object.keys(REWORK_LABELS));

const state = {
  view: 'review', // review | planned | history | playbook | activity
  data: null, // /api/items payload
  activity: null, // /api/activity payload
  playbook: null, // /api/playbook payload
  items: new Map(), // id -> item
  pendingOrder: [], // pending item ids, queue order
  selectedId: null,
  historyFilter: 'all',
  busy: new Set(),
  detail: { editing: false, captionValue: null, reason: null, slide: 0, unlocked: false, error: null },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------- API */

const API = {
  async items() {
    const res = await fetch('/api/items');
    if (!res.ok) throw new Error(`GET /api/items -> ${res.status}`);
    return res.json();
  },
  async activity() {
    try {
      const res = await fetch('/api/activity');
      return res.ok ? res.json() : { runs: [] };
    } catch {
      return { runs: [] };
    }
  },
  async playbook() {
    try {
      const res = await fetch('/api/playbook');
      return res.ok ? res.json() : { rules: { active: [], proposed: [], retired: [] }, notes: [] };
    } catch {
      return { rules: { active: [], proposed: [], retired: [] }, notes: [] };
    }
  },
  async post(path, payload) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `POST ${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  decide(payload) { return this.post('/api/decide', payload); },
};

/* ------------------------------------------------------------- formatting */

function formatSlot(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}
function formatDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(d);
}
function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}
function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}
function relSlot(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (Math.abs(mins) < 60) return mins >= 0 ? `in ${mins}m` : `${-mins}m ago`;
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return hours >= 0 ? `in ${hours}h` : `${-hours}h ago`;
  const days = Math.round(hours / 24);
  return days >= 0 ? `in ${days}d` : `${-days}d ago`;
}
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function assetUrl(itemId, assetPath) {
  return `/assets/${encodeURIComponent(itemId)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}
function isVideoAsset(asset) {
  return asset && (asset.kind === 'video' || /\.(mp4|mov|webm|m4v)$/i.test(asset.path || ''));
}
function fmtTokens(n) {
  if (n == null) return '?';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/* ------------------------------------------------------------------ toast */

function toast(msg, kind = 'success') {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 4600 : 3200);
}

function describeOutcome(result) {
  const d = result.decision.decision;
  const base = {
    approved: 'Approved.',
    edited: 'Approved with your caption edit.',
    changes_requested: 'Sent back for a redraft with your notes.',
    rejected: 'Rejected — it will not post.',
  }[d] || 'Saved.';
  const n = result.autoSkipped?.length || 0;
  return n ? `${base} ${n} sibling candidate${n > 1 ? 's' : ''} auto-skipped.` : base;
}

/* ------------------------------------------------------------------ icons */

const ICON = {
  chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
};

/* ------------------------------------------------------------ data shaping */

function ingest(data) {
  state.data = data;
  state.items = new Map();
  state.pendingOrder = [];
  state.reworkOrder = [];
  for (const group of data.groups || []) {
    for (const item of group.items) {
      item._group = { candidate_group: group.candidate_group, slot_at: group.slot_at, platform: group.platform, format: group.format };
      state.items.set(item.id, item);
      if (item.status === 'pending_review') state.pendingOrder.push(item.id);
      else if (REWORK_STATUSES.has(item.status) && (item.attempt || 1) > 1) state.reworkOrder.push(item.id);
    }
  }
  // rework list: soonest slot first, so tonight's redrafts sit on top
  state.reworkOrder.sort((a, b) => new Date(state.items.get(a).slot_at) - new Date(state.items.get(b).slot_at));
  const selectable = new Set([...state.pendingOrder, ...state.reworkOrder]);
  if (!state.selectedId || !selectable.has(state.selectedId)) {
    state.selectedId = state.pendingOrder[0] || state.reworkOrder[0] || null;
  }
}

/** j/k travel order: your queue first, then everything in rework. */
function navOrder() {
  return [...state.pendingOrder, ...state.reworkOrder];
}

function selectedItem() {
  return state.selectedId ? state.items.get(state.selectedId) : null;
}

function resetDetail() {
  state.detail = { editing: false, captionValue: null, reason: null, slide: 0, unlocked: false, error: null };
}

function decidedItems() {
  return [...state.items.values()]
    .filter((i) => i.decision)
    .sort((a, b) => new Date(b.decision.decided_at || 0) - new Date(a.decision.decided_at || 0));
}

/** EVERY decision on record, newest first — sourced from each item's full
 *  decision history, so a redrafted (re-pending) item's past decisions still
 *  count in stats and the activity feed. */
function allDecisions() {
  const out = [];
  for (const it of state.items.values()) {
    for (const f of it.feedback_history || []) {
      out.push({ item: it, ...f });
    }
  }
  return out.sort((a, b) => new Date(b.decided_at || 0) - new Date(a.decided_at || 0));
}

/* ------------------------------------------------------------------ header */

function renderHeader() {
  const data = state.data || { pending_count: 0 };
  const badge = $('#nav-review-badge');
  if (data.pending_count > 0) {
    badge.hidden = false;
    badge.textContent = data.pending_count;
  } else badge.hidden = true;

  const pbBadge = $('#nav-playbook-badge');
  const activeRules = state.playbook?.rules?.active?.length || 0;
  if (activeRules > 0) {
    pbBadge.hidden = false;
    pbBadge.textContent = activeRules;
  } else pbBadge.hidden = true;

  const killEl = $('#hd-kill');
  const killLabel = $('#hd-kill-label');
  const killSwitch = data.settings ? data.settings.kill_switch : undefined;
  if (typeof killSwitch === 'boolean') {
    killEl.hidden = false;
    killEl.classList.toggle('kill-on', killSwitch);
    killLabel.textContent = killSwitch ? 'Kill switch on' : 'Running';
  } else killEl.hidden = true;
}

/* ------------------------------------------------------------ view routing */

function setView(view, { push = true } = {}) {
  state.view = view;
  $$('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (push) {
    const hash = view === 'review' && state.selectedId ? `#/review/${state.selectedId}` : `#/${view}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }
  closeSidebar();
  render();
}

function applyHash() {
  const m = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash || '');
  const view = m && ['review', 'planned', 'history', 'playbook', 'activity'].includes(m[1]) ? m[1] : 'review';
  if (view === 'review' && m && m[2] && state.items.has(m[2])) {
    state.selectedId = m[2];
    resetDetail();
  }
  setView(view, { push: false });
}

function render() {
  if (!state.data) return;
  const content = $('#content');
  content.textContent = '';
  if (state.view === 'review') renderReview(content);
  else if (state.view === 'planned') renderPlanned(content);
  else if (state.view === 'history') renderHistory(content);
  else if (state.view === 'playbook') renderPlaybook(content);
  else renderActivity(content);
}

function viewHead(title, sub) {
  const el = document.createElement('div');
  el.className = 'view-head';
  el.innerHTML = `<div class="view-title">${esc(title)}</div><div class="view-sub">${sub}</div>`;
  return el;
}

function emptyState(title, htmlBody, isError = false) {
  const el = document.createElement('div');
  el.className = `empty${isError ? ' is-error' : ''}`;
  el.innerHTML = `<div class="empty-title">${esc(title)}</div><div>${htmlBody}</div>`;
  return el;
}

function platformBadge(platform) {
  const cls = platform === 'instagram' ? 'badge-ig' : platform === 'tiktok' ? 'badge-tt' : '';
  return `<span class="chip badge-platform ${cls}">${esc(PLATFORM_LABELS[platform] || platform)}</span>`;
}

/* ==========================================================================
   REVIEW — stats strip + queue rail + detail panel
   ========================================================================== */

function renderReview(content) {
  content.appendChild(buildStatStrip());

  if (!state.pendingOrder.length && !state.reworkOrder.length) {
    content.appendChild(emptyState(
      'Queue is clear',
      'Nothing is waiting on you and nothing is in rework. New candidates land here after the next <code>generate</code> run — see <b>Planned</b> for what\'s coming.',
    ));
    return;
  }

  const split = document.createElement('div');
  split.className = 'review-split';
  split.appendChild(buildQueueRail());
  const pane = document.createElement('div');
  pane.className = 'detail-pane';
  const it = selectedItem();
  if (it) pane.appendChild(buildDetail(it));
  else if (!state.pendingOrder.length) {
    pane.appendChild(emptyState('Nothing waiting on you',
      `${state.reworkOrder.length} item${state.reworkOrder.length === 1 ? ' is' : 's are'} being reworked — select one on the left to watch its progress.`));
  }
  split.appendChild(pane);
  content.appendChild(split);
}

/* ------------------------------------------------------------- stat strip */

function weekWindow() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Mon=0
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const end = new Date(start.getTime() + 7 * 86400000);
  return [start, end];
}

function buildStatStrip() {
  const strip = document.createElement('div');
  strip.className = 'stat-strip';

  const pending = state.data.pending_count;

  // next slot with pending work
  const nextGroup = (state.data.groups || [])
    .filter((g) => g.items.some((i) => i.status === 'pending_review'))
    .sort((a, b) => new Date(a.slot_at) - new Date(b.slot_at))[0];

  // your decisions this week (Mon–Sun) — from the FULL decision log, so a
  // change request still counts after its item re-enters the queue
  const [ws, we] = weekWindow();
  const weekDecisions = allDecisions().filter((f) => {
    const d = new Date(f.decided_at || 0);
    return d >= ws && d < we && !(f.reason_tags || []).includes('candidate-not-chosen');
  });
  const approvedWeek = weekDecisions.filter((f) => f.decision === 'approved' || f.decision === 'edited').length;
  const decidedWeek = weekDecisions.length;

  // last pipeline run
  const lastRun = (state.activity?.runs || [])[0] || null;
  const runFailed = lastRun && lastRun.status === 'failed';

  const rework = state.reworkOrder.length;

  strip.innerHTML = `
    <div class="stat">
      <div class="stat-label">Waiting on you</div>
      <div class="stat-value">${pending}</div>
      <div class="stat-hint">${pending ? 'candidates to review' : 'queue clear'}</div>
    </div>
    <div class="stat${rework ? ' stat-work' : ''}">
      <div class="stat-label">In rework</div>
      <div class="stat-value">${rework}</div>
      <div class="stat-hint">${rework ? 'redrafts in the pipeline' : 'no open change requests'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Next slot</div>
      <div class="stat-value">${nextGroup ? esc(formatClock(nextGroup.slot_at)) : '—'}</div>
      <div class="stat-hint">${nextGroup ? `${esc(formatDay(nextGroup.slot_at))} · ${esc(relSlot(nextGroup.slot_at))}` : 'nothing pending'}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Decided this week</div>
      <div class="stat-value">${decidedWeek} <small>· ${approvedWeek} approved</small></div>
      <div class="stat-hint">Mon–Sun, your decisions</div>
    </div>
    <div class="stat${runFailed ? ' stat-alert' : ''}">
      <div class="stat-label">Last pipeline run</div>
      <div class="stat-value">${lastRun ? esc(lastRun.stage) : '—'}</div>
      <div class="stat-hint">${lastRun ? `${esc(lastRun.status)} · ${esc(formatTime(lastRun.started_at))}` : 'no runs recorded'}</div>
    </div>`;
  return strip;
}

/* ------------------------------------------------------------- queue rail */

function railThumb(item) {
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const first = assets[0];
  if (!first) return '<div class="rail-thumb"></div>';
  const url = assetUrl(item.id, first.path);
  const kind = isVideoAsset(first) ? `${Math.round(first.dur_s || 0)}s` : (assets.length > 1 ? `${assets.length}⧉` : 'img');
  const media = isVideoAsset(first)
    ? `<video muted playsinline preload="metadata" src="${url}"></video>`
    : `<img src="${url}" alt="" loading="lazy" />`;
  return `<div class="rail-thumb">${media}<span class="thumb-kind">${esc(kind)}</span></div>`;
}

function lintLevel(item) {
  const v = item.lint?.violations || [];
  if (v.some((x) => x.severity === 'block')) return 'block';
  if (v.some((x) => x.severity === 'warn')) return 'warn';
  return 'pass';
}

function buildQueueRail() {
  const rail = document.createElement('div');
  rail.className = 'queue-rail';
  rail.id = 'queue-rail';

  const groups = (state.data.groups || []).filter((g) => g.items.some((i) => i.status === 'pending_review'));
  for (const group of groups) {
    const sec = document.createElement('div');
    sec.className = 'rail-group';
    sec.innerHTML = `
      <div class="rail-group-head">
        ${platformBadge(group.platform)}
        <span class="chip">${esc(FORMAT_LABELS[group.format] || group.format)}</span>
        <span class="slot-when">${esc(formatSlot(group.slot_at))}</span>
      </div>`;
    const cards = document.createElement('div');
    cards.className = 'rail-cards';
    for (const item of group.items) {
      if (item.status !== 'pending_review') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-card';
      btn.dataset.id = item.id;
      if (item.id === state.selectedId) btn.classList.add('is-selected');
      if (state.busy.has(item.id)) btn.classList.add('is-busy');
      const attempt = (item.attempt || 1) > 1 ? `<span class="chip">attempt ${item.attempt}</span>` : '';
      const think = item.rationale ? '' : '<span class="chip" title="No thinking log — generated before thinking logs shipped">no log</span>';
      btn.innerHTML = `
        ${railThumb(item)}
        <span class="rail-body">
          <span class="rail-hook">${esc(item.overlays?.hook || item.caption || '(no hook)')}</span>
          <span class="rail-meta">
            <span class="mini-dot lint-${lintLevel(item)}" title="lint: ${lintLevel(item)}"></span>
            ${item.pillar ? `<span class="chip">${esc(item.pillar)}</span>` : ''}
            ${item.risk !== 'standard' ? `<span class="chip risk-${esc(item.risk)}">${esc(item.risk)}</span>` : ''}
            ${attempt}${think}
          </span>
        </span>`;
      btn.addEventListener('click', () => selectItem(item.id));
      cards.appendChild(btn);
    }
    sec.appendChild(cards);
    rail.appendChild(sec);
  }

  // In rework — the employee's open workload from your change requests + QA
  // bounces. Selectable to inspect progress; decided elsewhere never.
  if (state.reworkOrder.length) {
    const sec = document.createElement('div');
    sec.className = 'rail-group';
    sec.innerHTML = `
      <div class="rail-group-head rail-group-rework">
        <span class="work-pulse" aria-hidden="true"></span>
        In rework
        <span class="slot-when">${state.reworkOrder.length} item${state.reworkOrder.length === 1 ? '' : 's'}</span>
      </div>`;
    const cards = document.createElement('div');
    cards.className = 'rail-cards';
    for (const id of state.reworkOrder) {
      const item = state.items.get(id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-card is-rework';
      btn.dataset.id = item.id;
      if (item.id === state.selectedId) btn.classList.add('is-selected');
      const note = reworkNote(item);
      btn.innerHTML = `
        ${railThumb(item)}
        <span class="rail-body">
          <span class="rail-hook">${esc(item.overlays?.hook || item.caption || item.id)}</span>
          <span class="rail-meta">
            <span class="chip chip-work">${esc(REWORK_LABELS[item.status] || item.status)}</span>
            <span class="chip">attempt ${item.attempt || 1}</span>
          </span>
          ${note ? `<span class="rail-note">“${esc(note.length > 70 ? `${note.slice(0, 70)}…` : note)}”</span>` : ''}
        </span>`;
      btn.addEventListener('click', () => selectItem(item.id));
      cards.appendChild(btn);
    }
    sec.appendChild(cards);
    rail.appendChild(sec);
  }
  return rail;
}

/** The owner note driving an item's rework: the live feedback envelope, else
 *  the most recent changes_requested decision on record. */
function reworkNote(item) {
  if (item.feedback?.note) return item.feedback.note;
  const fh = Array.isArray(item.feedback_history) ? item.feedback_history : [];
  const last = fh.filter((f) => f.decision === 'changes_requested')
    .sort((a, b) => new Date(b.decided_at || 0) - new Date(a.decided_at || 0))[0];
  return last?.note || null;
}

function selectItem(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  resetDetail();
  history.replaceState(null, '', `#/review/${id}`);
  render();
  const sel = document.querySelector(`.rail-card[data-id="${CSS.escape(id)}"]`);
  sel?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
  const order = navOrder();
  if (!order.length) return;
  let idx = order.indexOf(state.selectedId);
  if (idx === -1) idx = 0;
  const next = Math.min(Math.max(idx + delta, 0), order.length - 1);
  if (order[next] !== state.selectedId) selectItem(order[next]);
}

/* ----------------------------------------------------------- detail panel */

function buildDetail(item) {
  const card = document.createElement('article');
  card.className = 'detail-card';
  card.dataset.id = item.id;

  // head
  const head = document.createElement('div');
  head.className = 'detail-head';
  const idx = state.pendingOrder.indexOf(item.id);
  head.innerHTML = `
    ${platformBadge(item.platform)}
    <span class="chip chip-strong">${esc(FORMAT_LABELS[item.format] || item.format)}</span>
    <span class="chip">${esc(formatSlot(item.slot_at))}</span>
    ${item.pillar ? `<span class="chip">${esc(item.pillar)}</span>` : ''}
    <span class="chip risk-${esc(item.risk)}" title="${esc(RISK_TOOLTIP)}">risk: ${esc(item.risk)}</span>
    ${(item.attempt || 1) > 1 ? `<span class="chip">attempt ${item.attempt}</span>` : ''}
    <span class="item-id">${esc(item.id)}${idx >= 0 ? ` · ${idx + 1}/${state.pendingOrder.length}` : ''}</span>`;
  card.appendChild(head);

  // grid: media | body
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  grid.appendChild(buildMediaCol(item));

  const body = document.createElement('div');
  body.className = 'detail-body';
  const isRework = item.status !== 'pending_review';
  if (isRework) body.appendChild(buildReworkBanner(item));
  else if ((item.attempt || 1) > 1 && reworkNote(item)) body.appendChild(buildFeedbackBanner(item));
  body.appendChild(buildCaptionSection(item));
  body.appendChild(buildThinkingSection(item));
  body.appendChild(buildSourcesSection(item));
  const tl = buildTimelineSection(item);
  if (tl) body.appendChild(tl);
  grid.appendChild(body);
  card.appendChild(grid);

  if (isRework) {
    // No decisions on an item the employee still owes work on — show where it
    // is instead. (The media above is the PREVIOUS render until it re-renders.)
    const bar = document.createElement('div');
    bar.className = 'rework-bar';
    bar.innerHTML = `
      <span class="work-pulse" aria-hidden="true"></span>
      <span><b>${esc(REWORK_LABELS[item.status] || item.status)}</b> · attempt ${item.attempt || 1} — the tick sweeps every ~30 minutes; the redraft lands back in your queue when QA passes.</span>`;
    card.appendChild(bar);
    return card;
  }

  // sensitive gate
  if (item.risk === 'sensitive' && !state.detail.unlocked) {
    const gate = document.createElement('div');
    gate.className = 'sensitive-gate';
    gate.innerHTML = `
      <div class="sensitive-gate-label">Sensitive content (memorial / kids / UGC) — type CONFIRM to unlock decisions.</div>
      <input type="text" class="confirm-input" placeholder="type CONFIRM" autocomplete="off" spellcheck="false" aria-label="Type CONFIRM to unlock actions" />`;
    const input = gate.querySelector('.confirm-input');
    input.addEventListener('input', () => {
      if (input.value === 'CONFIRM') {
        state.detail.unlocked = true;
        render();
      }
    });
    card.appendChild(gate);
  }

  // error line
  if (state.detail.error) {
    const err = document.createElement('div');
    err.className = 'card-error';
    err.textContent = state.detail.error;
    card.appendChild(err);
  }

  // reason panel or action bar
  if (state.detail.reason) card.appendChild(buildReasonPanel(item));
  card.appendChild(buildActionBar(item));

  return card;
}

function buildFeedbackBanner(item) {
  // Post-redraft the live feedback envelope is consumed by the pipeline; the
  // note survives in the decision history, so derive from either.
  const note = reworkNote(item);
  const tags = (item.feedback?.reason_tags || []).join(', ');
  const el = document.createElement('div');
  el.className = 'feedback-banner';
  el.innerHTML = `<b>Redraft — attempt ${item.attempt}.</b> Addressing your feedback${tags ? ` (${esc(tags)})` : ''}${note ? `: “${esc(note)}”` : '.'}`;
  return el;
}

function buildReworkBanner(item) {
  const note = reworkNote(item);
  const el = document.createElement('div');
  el.className = 'feedback-banner';
  el.innerHTML = `<b>Being reworked — ${esc(REWORK_LABELS[item.status] || item.status)}.</b>${note ? ` Your note in the redraft prompt: “${esc(note)}”` : ''}`;
  return el;
}

/* media column */

function buildMediaCol(item) {
  const col = document.createElement('div');
  col.className = 'detail-media-col';

  const assets = Array.isArray(item.assets) ? item.assets : [];
  const box = document.createElement('div');
  box.className = 'media-box';

  if (!assets.length) {
    box.classList.add('no-asset');
    box.textContent = 'no media rendered yet';
    col.appendChild(box);
    return col;
  }

  const isCarousel = assets.length > 1;
  state.detail.slide = Math.min(Math.max(state.detail.slide, 0), assets.length - 1);
  const current = assets[state.detail.slide];
  const url = assetUrl(item.id, current.path);

  if (isVideoAsset(current)) {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    box.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = esc(item.overlays?.hook || 'candidate media');
    box.appendChild(img);
  }

  if (isCarousel) {
    box.insertAdjacentHTML('beforeend', `
      <button type="button" class="media-nav media-nav-prev" aria-label="Previous slide" ${state.detail.slide === 0 ? 'disabled' : ''}>${ICON.chevL}</button>
      <button type="button" class="media-nav media-nav-next" aria-label="Next slide" ${state.detail.slide === assets.length - 1 ? 'disabled' : ''}>${ICON.chevR}</button>
      <span class="media-count">${state.detail.slide + 1}/${assets.length}</span>`);
    box.querySelector('.media-nav-prev').addEventListener('click', () => { state.detail.slide--; render(); });
    box.querySelector('.media-nav-next').addEventListener('click', () => { state.detail.slide++; render(); });
  }
  col.appendChild(box);

  if (isCarousel) {
    const strip = document.createElement('div');
    strip.className = 'slide-strip';
    assets.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `slide-thumb${i === state.detail.slide ? ' is-active' : ''}`;
      b.setAttribute('aria-label', `Slide ${i + 1}`);
      b.innerHTML = `<img src="${assetUrl(item.id, a.path)}" alt="" loading="lazy" />`;
      b.addEventListener('click', () => { state.detail.slide = i; render(); });
      strip.appendChild(b);
    });
    col.appendChild(strip);
  }

  // raw files, quietly
  const files = document.createElement('div');
  files.className = 'media-files';
  files.innerHTML = assets.map((a) => {
    const u = assetUrl(item.id, a.path);
    const dims = a.w && a.h ? `${a.w}×${a.h}` : '';
    const dur = a.dur_s ? ` · ${a.dur_s}s` : '';
    return `<div class="file-row">
      <span class="file-name">${esc(a.path.split('/').pop())}</span>
      <span>${dims}${dur} · <a href="${u}" target="_blank" rel="noopener">open</a> · <a href="${u}" download>download</a></span>
    </div>`;
  }).join('');
  col.appendChild(files);

  return col;
}

/* caption section */

function buildCaptionSection(item) {
  const sec = document.createElement('section');
  sec.className = 'section';
  const editable = item.status === 'pending_review';
  const tags = Array.isArray(item.hashtags) ? item.hashtags : [];
  sec.innerHTML = `
    <div class="section-head">Caption ${editable ? '<span class="section-note">click text to edit</span>' : '<span class="section-note">previous draft — being rewritten</span>'}</div>
    <div class="section-body"></div>`;
  const body = sec.querySelector('.section-body');

  if (state.detail.editing && editable) {
    const ta = document.createElement('textarea');
    ta.className = 'caption-edit';
    ta.value = state.detail.captionValue ?? (item.caption || '');
    ta.addEventListener('input', () => { state.detail.captionValue = ta.value; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); } });
    body.appendChild(ta);
    const hint = document.createElement('div');
    hint.className = 'caption-hint';
    hint.textContent = 'Editing — “Save & approve” posts your version. esc reverts.';
    body.appendChild(hint);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  } else {
    const cap = document.createElement('div');
    cap.className = `caption-text${item.caption ? '' : ' is-empty'}${editable ? '' : ' is-readonly'}`;
    cap.textContent = item.caption || (editable ? 'no caption — click to add one' : 'no caption yet');
    if (editable) {
      cap.title = 'Click to edit';
      cap.addEventListener('click', () => startEdit(item));
    }
    body.appendChild(cap);
  }

  if (tags.length) {
    const wrap = document.createElement('div');
    wrap.className = 'hashtags';
    wrap.innerHTML = tags.map((t) => `<span class="tag-chip">#${esc(t)}</span>`).join('');
    body.appendChild(wrap);
  }

  const ov = item.overlays || {};
  if (ov.hook || (ov.beats || []).length || ov.cta) {
    const lines = document.createElement('div');
    lines.className = 'overlay-lines';
    let html = '';
    if (ov.hook) html += `<div><b>On-screen hook</b> — ${esc(ov.hook)}</div>`;
    (ov.beats || []).forEach((b, i) => { html += `<div><b>Beat ${i + 1}</b> — ${esc(b)}</div>`; });
    if (ov.cta) html += `<div><b>CTA</b> — ${esc(ov.cta)}</div>`;
    lines.innerHTML = html;
    body.appendChild(lines);
  }
  return sec;
}

function startEdit(item) {
  state.detail.editing = true;
  state.detail.captionValue = item.caption || '';
  render();
}
function cancelEdit() {
  state.detail.editing = false;
  state.detail.captionValue = null;
  render();
}

/* thinking section */

function buildThinkingSection(item) {
  const sec = document.createElement('section');
  sec.className = 'section';
  const r = item.rationale;
  sec.innerHTML = `<div class="section-head">Why the autopilot made this${r ? '' : ''}</div><div class="section-body"></div>`;
  const body = sec.querySelector('.section-body');

  if (!r) {
    sec.classList.add('is-empty');
    body.textContent = 'No thinking log — this candidate was generated before thinking logs shipped. Every new draft records one; request changes to get a redraft with its reasoning.';
    return sec;
  }

  if (r.summary) body.insertAdjacentHTML('beforeend', `<div class="think-summary">${esc(r.summary)}</div>`);
  if (r.hook_reasoning) {
    body.insertAdjacentHTML('beforeend', `<div class="think-block"><div class="think-h">Why this hook</div><div class="think-body">${esc(r.hook_reasoning)}</div></div>`);
  }

  const strat = r.strategy;
  if (strat) {
    const rules = Array.isArray(strat.playbook_rules) ? strat.playbook_rules : [];
    let html = '<div class="think-block"><div class="think-h">Strategy</div>';
    if (strat.idea_title || strat.idea_id) {
      html += `<div class="think-body">${strat.idea_id ? `<code>${esc(strat.idea_id)}</code> ` : ''}${esc(strat.idea_title || '')}${strat.pillar ? ` <span style="color:var(--text-3)">· pillar ${esc(strat.pillar)}</span>` : ''}</div>`;
    }
    if (rules.length) {
      html += `<div class="think-h" style="margin-top:8px">Your rules it applied</div>`;
      html += rules.map((pr) => `<div class="rule-cite"><span class="rule-id">${esc(String(pr.id || '').slice(0, 8))}</span><span>“${esc(pr.rule || '')}”</span></div>`).join('');
    }
    html += '</div>';
    body.insertAdjacentHTML('beforeend', html);
  }

  const craft = Array.isArray(r.craft) ? r.craft : [];
  if (craft.length) {
    body.insertAdjacentHTML('beforeend', `<div class="think-block"><div class="think-h">Craft choices</div><ul class="think-list">${craft.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`);
  }
  if (r.audience) {
    body.insertAdjacentHTML('beforeend', `<div class="think-block"><div class="think-h">Who it's for</div><div class="think-body">${esc(r.audience)}</div></div>`);
  }
  const limits = Array.isArray(r.limits) ? r.limits : [];
  if (limits.length) {
    body.insertAdjacentHTML('beforeend', `<div class="limits-box"><div class="think-h">Honest limits</div><ul>${limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`);
  }
  return sec;
}

/* sources section */

function buildSourcesSection(item) {
  const sec = document.createElement('section');
  sec.className = 'section';
  sec.innerHTML = `<div class="section-head">What it pulled from</div><div class="section-body"></div>`;
  const body = sec.querySelector('.section-body');

  const src = item.sources || {};
  const plan = src.plan;
  const gen = src.generation;
  const prov = item.provenance;

  if (!plan && !gen && !prov) {
    sec.classList.add('is-empty');
    body.textContent = 'No source log — this candidate predates source logging. New drafts record the knowledge files, skills and rules they were built from.';
    return sec;
  }

  if (plan) {
    const facts = [
      `score ${plan.score}`,
      plan.format_fit ? `fit: ${plan.format_fit.label}` : null,
      plan.recency_penalty != null ? `recency ×${plan.recency_penalty}` : null,
      plan.pool_size != null ? `pool of ${plan.pool_size}` : null,
      plan.reused_this_week ? 'same-week reuse' : null,
    ].filter(Boolean);
    const runners = (plan.runners_up || []).map((ru) => `${ru.id} (${ru.score})`).join(', ');
    body.insertAdjacentHTML('beforeend', `
      <div class="src-block">
        <div class="think-h">Planner's pick — why this idea got the slot</div>
        <div class="plan-quote">${esc(plan.picked_because || '')}</div>
        <div class="plan-facts">${facts.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}${runners ? `<span class="chip" title="Nearest ideas that lost the slot">beat: ${esc(runners)}</span>` : ''}</div>
      </div>`);
  }

  if (gen) {
    const rows = [];
    if (gen.brand_guide) {
      rows.push(`<div class="src-row"><span class="src-kind">Brand law</span><span class="src-main"><span class="mono">${esc(gen.brand_guide.path || 'brand-guide.md')}</span> — ${esc(gen.brand_guide.sections || '')}</span>${gen.brand_guide.sha ? `<span class="src-meta">${esc(gen.brand_guide.sha)}</span>` : ''}</div>`);
    }
    if (gen.skill) {
      rows.push(`<div class="src-row"><span class="src-kind">Skill</span><span class="src-main">${esc(gen.skill.stage || '')} — <span class="mono">${esc(gen.skill.path || '')}</span></span>${gen.skill.sha ? `<span class="src-meta">${esc(gen.skill.sha)}</span>` : ''}</div>`);
    }
    const rules = Array.isArray(gen.playbook_rules) ? gen.playbook_rules : [];
    rows.push(`<div class="src-row"><span class="src-kind">Your rules</span><span class="src-main">${rules.length ? rules.map((r) => `“${esc(r.rule)}” <span class="mono">(w${esc(String(r.weight))}${r.category ? ` · ${esc(r.category)}` : ''})</span>`).join('<br/>') : 'none active at generation time'}</span></div>`);
    if (gen.idea) {
      rows.push(`<div class="src-row"><span class="src-kind">Idea</span><span class="src-main"><span class="mono">${esc(gen.idea.id || '')}</span> ${esc(gen.idea.title || '')}${(gen.idea.worlds || []).length ? ` · worlds: ${esc(gen.idea.worlds.join(', '))}` : ''}</span></div>`);
    }
    if (gen.format_spec && (gen.format_spec.platform || gen.format_spec.format)) {
      rows.push(`<div class="src-row"><span class="src-kind">Format spec</span><span class="src-main">${esc(gen.format_spec.platform || '')} · ${esc(gen.format_spec.format || '')} (hook length, hashtag caps, safe areas)</span></div>`);
    }
    rows.push(`<div class="src-row"><span class="src-kind">Dedupe</span><span class="src-main">${gen.recent_posts ? `checked against ${gen.recent_posts} recent post${gen.recent_posts > 1 ? 's' : ''}` : 'no recent posts on record'}</span></div>`);
    if (Array.isArray(gen.feedback) && gen.feedback.length) {
      rows.push(`<div class="src-row"><span class="src-kind">Your feedback</span><span class="src-main">${gen.feedback.map((f) => `“${esc(f)}”`).join('<br/>')}</span></div>`);
    }
    if (gen.variant) {
      rows.push(`<div class="src-row"><span class="src-kind">Variant</span><span class="src-main">candidate ${esc(String(gen.variant))} of its slot — prompted to take a distinct angle</span></div>`);
    }
    body.insertAdjacentHTML('beforeend', `<div class="src-block"><div class="think-h">Injected into the brain for this draft</div>${rows.join('')}</div>`);
  }

  if (prov) {
    const bits = [];
    if (prov.model) bits.push(`model ${prov.model}`);
    if (prov.driver) bits.push(prov.driver);
    if (prov.tokens_in != null || prov.tokens_out != null) bits.push(`${fmtTokens(prov.tokens_in)}→${fmtTokens(prov.tokens_out)} tok`);
    if (prov.cost_usd != null) bits.push(`$${Number(prov.cost_usd).toFixed(4)}`);
    const sha = item.sources?.generation?.prompt_sha || prov.prompt_sha;
    if (sha) bits.push(`prompt ${String(sha).slice(0, 10)}`);
    if (prov.generated_at) bits.push(formatTime(prov.generated_at));
    if (bits.length) body.insertAdjacentHTML('beforeend', `<div class="prov-line">${esc(bits.join(' · '))}</div>`);
  }

  return sec;
}

/* timeline section */

function buildTimelineSection(item) {
  const fh = Array.isArray(item.feedback_history) ? item.feedback_history : [];
  if (!fh.length) return null;
  const sec = document.createElement('section');
  sec.className = 'section';
  sec.innerHTML = `<div class="section-head">Decision history</div><div class="section-body"><div class="tl"></div></div>`;
  const tl = sec.querySelector('.tl');
  const sorted = fh.slice().sort((a, b) => new Date(b.decided_at || 0) - new Date(a.decided_at || 0));
  for (const f of sorted) {
    const tags = (f.reason_tags || []).filter((t) => t !== 'candidate-not-chosen');
    const entry = document.createElement('div');
    entry.className = 'tl-entry';
    entry.innerHTML = `
      <span class="tl-dot d-${esc(f.decision || '')}"></span>
      <div class="tl-main">
        <div class="tl-head"><span class="tl-what">${esc(OUTCOME_LABELS[f.decision] || f.decision || 'decided')}</span><span class="tl-when">${f.decided_at ? esc(formatTime(f.decided_at)) : ''}</span></div>
        ${tags.length ? `<div class="tl-tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        ${f.note ? `<div class="tl-note">“${esc(f.note)}”</div>` : ''}
      </div>`;
    tl.appendChild(entry);
  }
  return sec;
}

/* actions */

function detailLocked(item) {
  return item.risk === 'sensitive' && !state.detail.unlocked;
}

function buildActionBar(item) {
  const bar = document.createElement('div');
  bar.className = 'action-bar';
  const locked = detailLocked(item);
  const busy = state.busy.has(item.id);
  const editing = state.detail.editing;
  const dirty = editing && (state.detail.captionValue ?? '') !== (item.caption || '');

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn-primary';
  approve.innerHTML = `${dirty ? 'Save & approve' : 'Approve'} <kbd>a</kbd>`;
  approve.disabled = locked || busy;
  approve.addEventListener('click', () => actApprove(item));

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn';
  edit.innerHTML = `${editing ? 'Cancel edit' : 'Edit caption'} <kbd>e</kbd>`;
  edit.disabled = locked || busy;
  edit.addEventListener('click', () => (editing ? cancelEdit() : startEdit(item)));

  const changes = document.createElement('button');
  changes.type = 'button';
  changes.className = 'btn';
  changes.innerHTML = 'Request changes <kbd>c</kbd>';
  changes.disabled = locked || busy;
  changes.addEventListener('click', () => openReason(item, 'changes_requested'));

  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'btn btn-danger-ghost';
  reject.innerHTML = 'Reject <kbd>r</kbd>';
  reject.disabled = locked || busy;
  reject.addEventListener('click', () => openReason(item, 'rejected'));

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  bar.append(approve, edit, spacer, changes, reject);
  return bar;
}

function openReason(item, kind) {
  if (detailLocked(item)) return flashGate();
  state.detail.reason = kind;
  render();
  setTimeout(() => $('.reason-panel .note-box')?.focus(), 0);
}

function flashGate() {
  const input = $('.sensitive-gate .confirm-input');
  if (input) {
    input.focus();
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
  }
}

function validateReason(tags, note) {
  if (!tags.length && !note) return 'Pick at least one reason tag or add a note.';
  if (tags.includes('other') && !note) return "Add a note explaining 'other'.";
  return null;
}

function buildReasonPanel(item) {
  const kind = state.detail.reason;
  const panel = document.createElement('div');
  panel.className = 'reason-panel';
  panel.dataset.decision = kind;
  panel.innerHTML = `
    <div class="reason-panel-title">${kind === 'rejected' ? 'Reject — why? (this trains the playbook)' : 'Request changes — the note goes straight into the redraft prompt'}</div>
    <div class="reason-chips">${REASON_TAGS.map((t) => `<button type="button" class="reason-chip" data-tag="${t}">${t}</button>`).join('')}</div>
    <textarea class="note-box" placeholder="${kind === 'rejected' ? 'Optional note (required if you pick other)' : 'What should change? Be concrete — the model reads this verbatim.'}" aria-label="Note"></textarea>
    <div class="reason-error" hidden></div>
    <div class="reason-actions">
      <button type="button" class="btn" data-act="cancel">Cancel <kbd>esc</kbd></button>
      <button type="button" class="btn btn-primary" data-act="submit">${kind === 'rejected' ? 'Reject' : 'Send for redraft'}</button>
    </div>`;
  panel.querySelectorAll('.reason-chip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('is-selected')));
  panel.querySelector('[data-act="cancel"]').addEventListener('click', () => { state.detail.reason = null; render(); });
  panel.querySelector('[data-act="submit"]').addEventListener('click', () => {
    const tags = [...panel.querySelectorAll('.reason-chip.is-selected')].map((b) => b.dataset.tag);
    const note = panel.querySelector('.note-box').value.trim();
    const err = validateReason(tags, note);
    const errEl = panel.querySelector('.reason-error');
    if (err) { errEl.textContent = err; errEl.hidden = false; return; }
    errEl.hidden = true;
    decide(item, kind, { reasonTags: tags, note: note || null });
  });
  return panel;
}

function actApprove(item) {
  if (detailLocked(item)) return flashGate();
  const editing = state.detail.editing;
  const after = state.detail.captionValue;
  if (editing && after != null && after !== (item.caption || '')) {
    decide(item, 'edited', { captionAfter: after });
  } else {
    decide(item, 'approved');
  }
}

async function decide(item, decision, extra = {}) {
  if (state.busy.has(item.id)) return;
  state.busy.add(item.id);
  state.detail.error = null;
  render();
  const prevIndex = state.pendingOrder.indexOf(item.id);
  try {
    const result = await API.decide({
      itemId: item.id,
      decision,
      reasonTags: extra.reasonTags || [],
      note: extra.note ?? null,
      captionAfter: extra.captionAfter ?? null,
    });
    toast(describeOutcome(result), 'success');
    await reloadData();
    // land on whatever moved into the decided item's slot in the queue
    const order = state.pendingOrder;
    state.selectedId = order.length ? order[Math.min(Math.max(prevIndex, 0), order.length - 1)] : null;
    resetDetail();
    if (state.selectedId) history.replaceState(null, '', `#/review/${state.selectedId}`);
    render();
    renderHeader();
  } catch (err) {
    state.detail.error = err.message || 'Failed to save the decision.';
    toast(state.detail.error, 'error');
    render();
  } finally {
    state.busy.delete(item.id);
  }
}

/* ==========================================================================
   PLANNED — the week ahead, with the planner's reasoning
   ========================================================================== */

const STAGE_DOTS = [
  ['pending_review', 'pending', 'waiting on you'],
  ['approved,scheduled,published', 'approved', 'approved'],
  ['planned,drafting,drafted,rendering,rendered,qa_failed', 'other', 'in pipeline'],
];

function renderPlanned(content) {
  const shells = (state.data.groups || [])
    .filter((g) => g.items.some((i) => !['skipped', 'archived', 'measured'].includes(i.status)))
    .sort((a, b) => new Date(a.slot_at) - new Date(b.slot_at));

  content.appendChild(viewHead('Planned',
    shells.length
      ? `${shells.length} slot${shells.length === 1 ? '' : 's'} on the calendar. Each shows the planner's own reasoning for its top pick.`
      : 'Nothing scheduled yet.'));

  if (!shells.length) {
    content.appendChild(emptyState('Nothing planned', 'Slots appear here after the next <code>plan</code> run fills the calendar.'));
    return;
  }

  const byDay = new Map();
  for (const g of shells) {
    const key = dayKey(g.slot_at);
    if (!byDay.has(key)) byDay.set(key, { label: formatDay(g.slot_at), groups: [] });
    byDay.get(key).groups.push(g);
  }

  for (const { label, groups } of byDay.values()) {
    const dayEl = document.createElement('div');
    dayEl.className = 'day-group';
    dayEl.innerHTML = `<div class="day-head">${esc(label)}</div>`;
    const grid = document.createElement('div');
    grid.className = 'shell-grid';
    for (const g of groups) grid.appendChild(buildShellCard(g));
    dayEl.appendChild(grid);
    content.appendChild(dayEl);
  }
}

function buildShellCard(group) {
  const counts = { pending: 0, approved: 0, other: 0 };
  for (const i of group.items) {
    if (i.status === 'pending_review') counts.pending++;
    else if (['approved', 'scheduled', 'published'].includes(i.status)) counts.approved++;
    else if (!['skipped', 'archived', 'measured'].includes(i.status)) counts.other++;
  }
  const bits = [];
  if (counts.pending) bits.push(`<span class="dot pending">${counts.pending} pending</span>`);
  if (counts.approved) bits.push(`<span class="dot approved">${counts.approved} approved</span>`);
  if (counts.other) bits.push(`<span class="dot other">${counts.other} in pipeline</span>`);

  // the slot's lead candidate + its plan-time reasoning
  const lead = group.items.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
  const plan = lead?.sources?.plan;

  const el = document.createElement('div');
  el.className = 'slot-shell';
  el.innerHTML = `
    <div class="shell-head">
      ${platformBadge(group.platform)}
      <span class="chip">${esc(FORMAT_LABELS[group.format] || group.format)}</span>
      <span class="shell-time">${esc(formatClock(group.slot_at))}</span>
    </div>
    <div class="shell-status">${bits.join('') || '<span class="dot other">no items</span>'}</div>
    ${plan?.idea ? `<div class="shell-idea">${esc(plan.idea.id || lead.idea_id || '')} ${esc(plan.idea.title || '')}</div>` : (lead?.idea_id ? `<div class="shell-idea">${esc(lead.idea_id)}</div>` : '')}
    ${plan?.picked_because ? `<div class="shell-why">${esc(plan.picked_because)}</div>` : ''}`;
  return el;
}

/* ==========================================================================
   HISTORY — every decision, filterable
   ========================================================================== */

function renderHistory(content) {
  const decided = decidedItems();
  content.appendChild(viewHead('History',
    decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'}, newest first.` : 'No decisions yet.'));

  if (!decided.length) {
    content.appendChild(emptyState('No decisions yet', 'Approvals, edits, change requests and rejections land here.'));
    return;
  }

  const FILTERS = [
    ['all', 'All'],
    ['approved', 'Approved'],
    ['changes_requested', 'Changes requested'],
    ['rejected', 'Rejected'],
  ];
  const row = document.createElement('div');
  row.className = 'filter-row';
  for (const [key, label] of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `filter-chip${state.historyFilter === key ? ' is-active' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => { state.historyFilter = key; render(); });
    row.appendChild(b);
  }
  content.appendChild(row);

  const filtered = decided.filter((it) => {
    if (state.historyFilter === 'all') return true;
    const d = it.decision.decision;
    if (state.historyFilter === 'approved') return d === 'approved' || d === 'edited';
    if (state.historyFilter === 'rejected') return d === 'rejected';
    return d === state.historyFilter;
  });

  const list = document.createElement('div');
  list.className = 'history-list';
  for (const it of filtered) list.appendChild(buildHistoryRow(it));
  content.appendChild(list);
}

function buildHistoryRow(it) {
  const d = it.decision || {};
  let decisionKey = d.decision || it.status;
  const autoSkip = (d.reason_tags || []).includes('candidate-not-chosen');
  if (it.status === 'skipped' && autoSkip) decisionKey = 'skipped';
  const label = OUTCOME_LABELS[decisionKey] || it.status;

  const row = document.createElement('div');
  row.className = `history-row decision-${decisionKey}`;

  const tags = (d.reason_tags || []).filter((t) => t !== 'candidate-not-chosen');
  const detailBits = [];
  if (tags.length) detailBits.push(`<div class="tl-tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`);
  if (d.note) detailBits.push(`<div class="note-quote">“${esc(d.note)}”</div>`);
  if (d.caption_diff) {
    detailBits.push(`<div class="caption-diff">
      <div class="diff-line diff-before"><span class="diff-label">before</span>${esc(d.caption_diff.before)}</div>
      <div class="diff-line diff-after"><span class="diff-label">after</span>${esc(d.caption_diff.after)}</div>
    </div>`);
  } else if (it.caption) {
    detailBits.push(`<div>${esc(it.caption)}</div>`);
  }
  if (it.feedback) detailBits.push(`<div class="note-quote">feedback for redraft: ${esc(it.feedback.note || '(tags only)')}</div>`);

  row.innerHTML = `
    <button type="button" class="history-summary" aria-expanded="false">
      <span class="decision-dot" aria-hidden="true"></span>
      <span class="history-hook">${esc(it.overlays?.hook || it.caption || it.id)}</span>
      <span class="history-decision">${esc(label)}${autoSkip ? ' (auto)' : ''}</span>
      <span class="history-time">${d.decided_at ? formatTime(d.decided_at) : ''}</span>
      <span class="history-chev" aria-hidden="true">▸</span>
    </button>
    <div class="history-detail" hidden>${detailBits.join('') || '<div class="note-quote">No note recorded.</div>'}</div>`;

  const summary = row.querySelector('.history-summary');
  const detail = row.querySelector('.history-detail');
  summary.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.classList.toggle('is-open', open);
    summary.setAttribute('aria-expanded', String(open));
  });
  return row;
}

/* ==========================================================================
   PLAYBOOK — standing guidance: rules (live) + suggestion inbox
   ========================================================================== */

function renderPlaybook(content) {
  content.appendChild(viewHead('Playbook',
    'Standing guidance you\'ve given the autopilot. Rules are injected into every generation and cited by id in each draft\'s thinking; suggestions are the free-form inbox.'));

  const pb = state.playbook || { rules: { active: [], proposed: [], retired: [] }, notes: [] };
  const grid = document.createElement('div');
  grid.className = 'pb-grid';
  grid.appendChild(buildRulesPanel(pb));
  grid.appendChild(buildNotesPanel(pb));
  content.appendChild(grid);
}

function buildRulesPanel(pb) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">Rules</div>
      <div class="panel-sub">One imperative sentence each. Goes live at the next generation — every draft that applies it cites it.</div>
    </div>
    <div class="panel-body">
      <div class="composer">
        <textarea id="rule-text" placeholder="e.g. Always show the real product within the first two beats."></textarea>
        <div class="composer-row">
          <select id="rule-category" aria-label="Category">
            ${RULE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <span class="weight-wrap">weight <input type="range" id="rule-weight" min="1" max="10" value="6" /> <b id="rule-weight-val">6</b></span>
          <button type="button" class="btn btn-primary" id="rule-add">Add rule</button>
        </div>
        <div class="composer-error" id="rule-error" hidden></div>
      </div>
      <div style="height:14px"></div>
      <div class="rule-list" id="rule-list"></div>
    </div>`;

  const weight = panel.querySelector('#rule-weight');
  const weightVal = panel.querySelector('#rule-weight-val');
  weight.addEventListener('input', () => { weightVal.textContent = weight.value; });

  panel.querySelector('#rule-add').addEventListener('click', async () => {
    const text = panel.querySelector('#rule-text').value.trim();
    const errEl = panel.querySelector('#rule-error');
    if (!text) { errEl.textContent = 'Write the rule first.'; errEl.hidden = false; return; }
    errEl.hidden = true;
    try {
      await API.post('/api/playbook/rules', {
        rule: text,
        category: panel.querySelector('#rule-category').value,
        weight: Number(weight.value),
      });
      toast('Rule added — live at the next generation.');
      state.playbook = await API.playbook();
      render();
      renderHeader();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  const list = panel.querySelector('#rule-list');
  const active = pb.rules.active || [];
  const retired = pb.rules.retired || [];
  const proposed = pb.rules.proposed || [];

  if (!active.length && !retired.length && !proposed.length) {
    list.innerHTML = '<div class="empty" style="padding:22px">No rules yet — the autopilot runs on brand law alone until you teach it.</div>';
  } else {
    for (const r of active) list.appendChild(buildRuleRow(r, 'active'));
    for (const r of proposed) list.appendChild(buildRuleRow(r, 'proposed'));
    if (retired.length) {
      const det = document.createElement('details');
      det.innerHTML = `<summary style="cursor:pointer;font-size:12px;color:var(--text-3);padding:5px 2px">${retired.length} retired rule${retired.length > 1 ? 's' : ''}</summary>`;
      const inner = document.createElement('div');
      inner.className = 'rule-list';
      inner.style.marginTop = '7px';
      for (const r of retired) inner.appendChild(buildRuleRow(r, 'retired'));
      det.appendChild(inner);
      list.appendChild(det);
    }
  }
  return panel;
}

function buildRuleRow(rule, status) {
  const row = document.createElement('div');
  row.className = `rule-row${status === 'retired' ? ' is-retired' : ''}`;
  row.innerHTML = `
    <span class="rule-weight" title="Injection priority (1–10)">${esc(String(rule.weight ?? 5))}</span>
    <div class="rule-main">
      <div class="rule-text">${esc(rule.rule)}</div>
      <div class="rule-meta">
        ${rule.category ? `<span class="chip">${esc(rule.category)}</span>` : ''}
        <span class="chip">${esc(rule.source || 'owner')}</span>
        ${status === 'proposed' ? '<span class="chip" style="color:var(--amber)">proposed</span>' : ''}
        <span class="rule-id">${esc(String(rule.id || '').slice(0, 8))}</span>
      </div>
    </div>
    <button type="button" class="btn btn-sm" data-act="${status === 'retired' ? 'active' : 'retired'}">
      ${status === 'retired' ? 'Re-activate' : 'Retire'}
    </button>`;
  row.querySelector('[data-act]').addEventListener('click', async (e) => {
    const target = e.currentTarget.dataset.act;
    try {
      await API.post('/api/playbook/rules/status', { id: rule.id, status: target });
      toast(target === 'retired' ? 'Rule retired — no longer injected.' : 'Rule re-activated.');
      state.playbook = await API.playbook();
      render();
      renderHeader();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  return row;
}

function buildNotesPanel(pb) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">Suggestion box</div>
      <div class="panel-sub">Anything on your mind — direction, content wishes, complaints. The reflect stage parses these into proposed rules; until then they're captured here instead of a chat thread.</div>
    </div>
    <div class="panel-body">
      <div class="composer">
        <textarea id="note-text" placeholder="e.g. Lean harder into the anniversary angle this month — and fewer claw-machine posts."></textarea>
        <div class="composer-row">
          <button type="button" class="btn btn-primary" id="note-add">Send to the autopilot</button>
        </div>
        <div class="composer-error" id="note-error" hidden></div>
      </div>
      <div style="height:14px"></div>
      <div class="note-list" id="note-list"></div>
    </div>`;

  panel.querySelector('#note-add').addEventListener('click', async () => {
    const text = panel.querySelector('#note-text').value.trim();
    const errEl = panel.querySelector('#note-error');
    if (!text) { errEl.textContent = 'Write the suggestion first.'; errEl.hidden = false; return; }
    errEl.hidden = true;
    try {
      await API.post('/api/playbook/notes', { text });
      toast('Suggestion captured.');
      state.playbook = await API.playbook();
      render();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  const list = panel.querySelector('#note-list');
  const notes = pb.notes || [];
  if (!notes.length) {
    list.innerHTML = '<div class="empty" style="padding:22px">No suggestions yet.</div>';
  } else {
    for (const n of notes) {
      const row = document.createElement('div');
      row.className = 'note-row';
      row.innerHTML = `
        <div>${esc(n.text)}</div>
        <div class="note-meta">
          <span class="note-flag${n.processed ? ' is-processed' : ''}">${n.processed ? 'processed' : 'waiting for reflection'}</span>
          <span>${esc(formatTime(n.created_at))}</span>
        </div>`;
      list.appendChild(row);
    }
  }
  return panel;
}

/* ==========================================================================
   ACTIVITY — the employee's worklog (runs + decisions, merged)
   ========================================================================== */

function renderActivity(content) {
  const runs = (state.activity?.runs || []).map((r) => ({
    kind: 'run',
    when: r.started_at,
    run: r,
  }));
  const decisions = allDecisions().map((f) => ({
    kind: 'decision',
    when: f.decided_at,
    entry: f,
  }));
  const entries = [...runs, ...decisions]
    .filter((e) => e.when)
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, 120);

  content.appendChild(viewHead('Activity',
    entries.length
      ? 'What the autopilot has been doing — pipeline runs and your decisions, newest first.'
      : 'No activity recorded yet.'));

  if (!entries.length) {
    content.appendChild(emptyState('Nothing yet', 'Pipeline runs and review decisions will appear here.'));
    return;
  }

  const list = document.createElement('div');
  list.className = 'act-list';
  let lastDay = null;
  for (const e of entries) {
    const day = dayKey(e.when);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement('div');
      h.className = 'act-day';
      h.textContent = formatDay(e.when);
      list.appendChild(h);
    }
    list.appendChild(e.kind === 'run' ? buildRunRow(e.run) : buildDecisionRow(e.entry));
  }
  content.appendChild(list);
}

const STAGE_BLURBS = {
  plan: 'planned the week\'s slots and picked ideas',
  generate: 'drafted candidate copy with the brain',
  render: 'rendered media for drafted candidates',
  qa: 'ran brand-law lint + dedupe checks',
  digest: 'built the daily review digest',
  publish: 'published approved posts',
  metrics: 'pulled platform metrics',
  reflect: 'distilled learnings into proposed rules',
  report: 'compiled the weekly report',
};

function buildRunRow(r) {
  const failed = r.status === 'failed';
  const row = document.createElement('div');
  row.className = 'act-row';
  const bits = [];
  if (r.driver) bits.push(r.driver);
  if (r.model) bits.push(r.model);
  if (r.tokens_in != null || r.tokens_out != null) bits.push(`${fmtTokens(r.tokens_in)}→${fmtTokens(r.tokens_out)} tok`);
  if (r.cost_usd != null) bits.push(`$${Number(r.cost_usd).toFixed(4)}`);
  row.innerHTML = `
    <span class="act-icon ${failed ? 'k-failed' : 'k-run'}">${failed ? '!' : esc((r.stage || '?')[0].toUpperCase())}</span>
    <div class="act-main">
      <div class="act-title">${esc(r.stage || 'run')} <span class="mono">${esc(r.status || '')}</span></div>
      <div class="act-sub">${esc(STAGE_BLURBS[r.stage] || 'pipeline stage')}${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</div>
      ${r.error ? `<div class="act-error">${esc(String(r.error).slice(0, 220))}</div>` : ''}
    </div>
    <span class="act-when">${esc(formatTime(r.started_at))}</span>`;
  return row;
}

function buildDecisionRow(d) {
  const it = d.item;
  const auto = (d.reason_tags || []).includes('candidate-not-chosen');
  const reworking = d.decision === 'changes_requested' && REWORK_STATUSES.has(it.status);
  const redone = d.decision === 'changes_requested' && it.status === 'pending_review' && (it.attempt || 1) > 1;
  const row = document.createElement('div');
  row.className = 'act-row';
  row.innerHTML = `
    <span class="act-icon k-decision">✓</span>
    <div class="act-main">
      <div class="act-title">${esc(OUTCOME_LABELS[d.decision] || d.decision)}${auto ? ' (auto)' : ''} <span class="mono">${esc(d.via || '')}</span></div>
      <div class="act-sub">${esc(it.overlays?.hook || it.caption || it.id)}</div>
      ${d.note && !auto ? `<div class="act-sub" style="font-style:italic">“${esc(d.note)}”</div>` : ''}
      ${reworking ? `<div class="act-sub" style="color:var(--violet);font-weight:600">→ ${esc(REWORK_LABELS[it.status])} (attempt ${it.attempt || 1})</div>` : ''}
      ${redone ? '<div class="act-sub" style="color:var(--green);font-weight:600">→ redrafted — back in your review queue</div>' : ''}
    </div>
    <span class="act-when">${esc(formatTime(d.decided_at))}</span>`;
  return row;
}

/* ==========================================================================
   keyboard, chrome, boot
   ========================================================================== */

function wireGlobalKeyboard() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.tagName === 'SELECT');

    if (e.key === 'Escape') {
      if (!$('#cheatsheet').hidden) { closeCheatsheet(); return; }
      if (inField) { active.blur(); return; }
      if (state.view === 'review') {
        if (state.detail.reason) { state.detail.reason = null; render(); return; }
        if (state.detail.editing) { cancelEdit(); return; }
      }
      return;
    }

    if (e.key === '?' && !inField) { toggleCheatsheet(); e.preventDefault(); return; }
    if (inField) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.view !== 'review') return;

    const it = selectedItem();
    const decidable = it && it.status === 'pending_review';
    switch (e.key) {
      case 'j': moveSelection(1); break;
      case 'k': moveSelection(-1); break;
      case 'a': if (decidable) actApprove(it); break;
      case 'e': if (decidable) (state.detail.editing ? cancelEdit() : startEdit(it)); break;
      case 'c': if (decidable) openReason(it, 'changes_requested'); break;
      case 'r': if (decidable) openReason(it, 'rejected'); break;
      case 'ArrowLeft': if (it && (it.assets || []).length > 1 && state.detail.slide > 0) { state.detail.slide--; render(); } break;
      case 'ArrowRight': if (it && (it.assets || []).length > 1 && state.detail.slide < it.assets.length - 1) { state.detail.slide++; render(); } break;
      default: return;
    }
    e.preventDefault();
  });
}

function toggleCheatsheet() {
  const sheet = $('#cheatsheet');
  sheet.hidden = !sheet.hidden;
}
function closeCheatsheet() { $('#cheatsheet').hidden = true; }

function openSidebar() {
  $('#sidebar').classList.add('is-open');
  $('#sidebar-scrim').hidden = false;
  $('#nav-toggle').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('#sidebar').classList.remove('is-open');
  $('#sidebar-scrim').hidden = true;
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

async function reloadData() {
  const [items, activity, playbook] = await Promise.all([API.items(), API.activity(), API.playbook()]);
  ingest(items);
  state.activity = activity;
  state.playbook = playbook;
}

async function reload() {
  try {
    await reloadData();
    renderHeader();
    render();
  } catch (err) {
    state.data = { groups: [], pending_count: 0 };
    $('#content').innerHTML = '';
    $('#content').appendChild(emptyState('Could not load the station', `Failed to load <code>/api/items</code>: ${esc(err.message)}`, true));
  }
}

async function refresh() {
  const btn = $('#hd-refresh');
  btn.classList.add('is-refreshing');
  btn.disabled = true;
  await reload();
  btn.classList.remove('is-refreshing');
  btn.disabled = false;
}

function renderSkeleton() {
  $('#content').innerHTML = `
    <div class="view-head"><div class="view-title">Review</div></div>
    <div class="skeleton">
      <div class="sk-rail">${'<div class="sk-card"></div>'.repeat(5)}</div>
      <div class="sk-detail"></div>
    </div>`;
}

function wireChrome() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('#hd-refresh').addEventListener('click', refresh);
  $('#hd-help').addEventListener('click', toggleCheatsheet);
  $('#cheatsheet-close').addEventListener('click', closeCheatsheet);
  $('#cheatsheet').addEventListener('click', (e) => { if (e.target === $('#cheatsheet')) closeCheatsheet(); });
  $('#nav-toggle').addEventListener('click', () => {
    if ($('#sidebar').classList.contains('is-open')) closeSidebar(); else openSidebar();
  });
  $('#sidebar-scrim').addEventListener('click', closeSidebar);
  window.addEventListener('hashchange', applyHash);
}

async function init() {
  wireChrome();
  wireGlobalKeyboard();
  renderSkeleton();
  await reload();
  applyHash();
}

init();
