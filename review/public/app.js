// Autopilot review station — vanilla JS, no build step, no deps.
// Standard SaaS dashboard UI (AP-821). Talks to GET /api/items + POST
// /api/decide. See autopilot/review/lib/app.mjs for the API contract.

const REASON_TAGS = ['hook-weak', 'off-voice', 'wrong-world', 'too-salesy', 'timing', 'duplicate', 'other'];
const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok' };
const FORMAT_LABELS = { reel: 'Reel', image: 'Image', carousel: 'Carousel', video: 'Video' };
const OUTCOME_LABELS = {
  approved: 'Approved',
  edited: 'Edited & approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  skipped: 'Rejected',
};
const RISK_TOOLTIP =
  'Risk class controls approval strictness: evergreen may auto-publish at L2 · standard always needs your tap · sensitive requires typed confirmation';

const state = {
  view: 'queue', // queue | history | planned
  data: null, // last /api/items payload
  items: new Map(), // id -> item (current view)
  cardEls: new Map(), // id -> pending card element (current view)
  groupOrder: [], // candidate_group keys in render order (queue)
  pendingOrder: [], // pending item ids in reading order (j/k)
  focusId: null,
  busy: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
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
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
}
function assetUrl(itemId, assetPath) {
  return `/assets/${encodeURIComponent(itemId)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function isVideoAsset(asset) {
  return asset && (asset.kind === 'video' || /\.(mp4|mov|webm|m4v)$/i.test(asset.path || ''));
}

// -------------------------------------------------------------------- toast

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
    edited: 'Approved with edited caption.',
    changes_requested: 'Changes requested — sent back for a redraft.',
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

  $('#hd-pending-count').textContent = data.pending_count;

  const badge = $('#nav-queue-badge');
  if (data.pending_count > 0) {
    badge.hidden = false;
    badge.textContent = data.pending_count;
  } else {
    badge.hidden = true;
  }

  const killEl = $('#hd-kill');
  const killLabel = $('#hd-kill-label');
  const killSwitch = data.settings ? data.settings.kill_switch : undefined;
  if (typeof killSwitch === 'boolean') {
    killEl.hidden = false;
    killEl.classList.toggle('kill-on', killSwitch);
    killLabel.textContent = killSwitch ? 'Kill switch on' : 'Live';
  } else {
    killEl.hidden = true;
  }
}

// ------------------------------------------------------------ view routing

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  closeSidebar();
  render();
}

function render() {
  if (!state.data) return;
  if (state.view === 'queue') renderQueue(state.data);
  else if (state.view === 'history') renderHistory(state.data);
  else renderPlanned(state.data);
}

// --------------------------------------------------------------- queue view

function renderQueue(data) {
  state.items = new Map();
  state.cardEls = new Map();
  state.groupOrder = [];
  state.pendingOrder = [];

  const content = $('#content');
  content.textContent = '';

  const pendingGroups = data.groups.filter((g) => g.pending_count > 0);

  content.appendChild(viewHead('Queue', pendingGroups.length
    ? `${data.pending_count} item${data.pending_count === 1 ? '' : 's'} awaiting review across ${pendingGroups.length} slot${pendingGroups.length === 1 ? '' : 's'}.`
    : 'Everything is reviewed.'));

  if (!pendingGroups.length) {
    content.appendChild(emptyState(
      'Queue is clear',
      'No items are waiting for review. New candidates will appear here after the next <code>generate</code> run.',
    ));
    return;
  }

  for (const group of pendingGroups) {
    state.groupOrder.push(group.candidate_group);
    content.appendChild(buildGroupSection(group));
  }

  if (!state.focusId || !state.pendingOrder.includes(state.focusId)) {
    state.focusId = state.pendingOrder[0] || null;
  }
  applyFocusStyles();
}

function viewHead(title, sub) {
  const el = document.createElement('div');
  el.className = 'view-head';
  el.innerHTML = `<div class="view-title">${esc(title)}</div><div class="view-sub">${sub}</div>`;
  return el;
}

function platformBadge(platform) {
  const cls = platform === 'instagram' ? 'badge-ig' : platform === 'tiktok' ? 'badge-tt' : 'badge-neutral';
  return `<span class="badge badge-platform ${cls}">${esc(PLATFORM_LABELS[platform] || platform)}</span>`;
}

function buildGroupSection(group) {
  const section = document.createElement('section');
  section.className = 'group';
  section.dataset.group = group.candidate_group;

  const head = document.createElement('div');
  head.className = 'group-head';
  head.innerHTML = `
    ${platformBadge(group.platform)}
    <span class="chip">${esc(FORMAT_LABELS[group.format] || group.format)}</span>
    <span class="group-slot">${esc(formatSlot(group.slot_at))}</span>
    <span class="group-progress">${group.pending_count} of ${group.items.length} pending</span>`;
  section.appendChild(head);

  const cards = document.createElement('div');
  cards.className = 'group-cards';
  for (const item of group.items) {
    state.items.set(item.id, item);
    if (item.status === 'pending_review') {
      const wrap = buildPendingCard(item);
      cards.appendChild(wrap);
    }
    // decided siblings within a still-pending group are intentionally hidden
    // from Queue; they live in History. The "n of m pending" count above still
    // reflects them so the slot's full picture stays legible.
  }
  section.appendChild(cards);
  return section;
}

// ------------------------------------------------------------- pending card

function renderMedia(item) {
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const first = assets[0];
  if (!first) return `<div class="media-frame no-asset">no asset</div>`;

  const isCarousel = item.format === 'carousel' || assets.length > 1;
  const url = assetUrl(item.id, first.path);
  const alt = esc(item.overlays?.hook || 'candidate preview');

  if (isVideoAsset(first)) {
    const dur = first.dur_s ? `<span class="media-dur">${first.dur_s}s</span>` : '';
    return `<div class="media-frame" data-media="video">
      <video muted loop playsinline preload="metadata" src="${url}"></video>
      <span class="media-play" aria-hidden="true"></span>${dur}
    </div>`;
  }

  const countBadge = isCarousel ? `<span class="media-count">${assets.length} slide${assets.length > 1 ? 's' : ''}</span>` : '';
  return `<div class="media-frame" data-media="${isCarousel ? 'carousel' : 'image'}">
    <img src="${url}" alt="${alt}" loading="lazy" />${countBadge}
  </div>`;
}

function renderSlideStrip(item) {
  const assets = Array.isArray(item.assets) ? item.assets : [];
  if (!(item.format === 'carousel' || assets.length > 1)) return '';
  const thumbs = assets.map((a, i) => {
    const url = assetUrl(item.id, a.path);
    return `<button type="button" class="slide-thumb${i === 0 ? ' is-active' : ''}" data-slide="${i}" aria-label="Slide ${i + 1}">
      <img src="${url}" alt="Slide ${i + 1}" loading="lazy" />
    </button>`;
  }).join('');
  return `<div class="slide-strip" hidden>${thumbs}</div>`;
}

function renderLint(lint) {
  const violations = lint?.violations || [];
  const hasBlock = violations.some((v) => v.severity === 'block');
  const hasWarn = violations.some((v) => v.severity === 'warn');
  const level = hasBlock ? 'block' : hasWarn ? 'warn' : 'pass';
  if (level === 'pass') {
    return `<span class="lint lint-pass"><span class="lint-summary">Lint pass</span></span>`;
  }
  const label = `${violations.length} ${level === 'warn' ? 'warning' : 'blocker'}${violations.length > 1 ? 's' : ''}`;
  const list = violations.map((v) => `<li><b>${esc(v.rule)}</b> — ${esc(v.excerpt || '')}</li>`).join('');
  return `<details class="lint lint-${level}">
    <summary class="lint-summary">${esc(label)}</summary>
    <ul class="lint-list">${list}</ul>
  </details>`;
}

function renderDedupe(dedupe) {
  if (!dedupe) return '';
  const sim = dedupe.hook_sim ?? 0;
  const pct = Math.round(sim * 100);
  const level = sim >= 0.55 ? 'hot' : sim >= 0.4 ? 'warm' : 'cool';
  const near = dedupe.nearest_item ? ` vs ${esc(dedupe.nearest_item)}` : '';
  return `<span class="dedupe dedupe-${level}">dedupe ${pct}%${near}</span>`;
}

function renderFeedbackBanner(item) {
  const fb = item.feedback;
  if (!fb) return '';
  const attempt = item.attempt || 1;
  const tags = (fb.reason_tags || []).length
    ? `<div class="feedback-tags">${fb.reason_tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`
    : '';
  const note = fb.note ? `<div class="feedback-note">"${esc(fb.note)}"</div>` : '';
  const detail = tags || note;
  return `<details class="feedback-banner">
    <summary>Feedback addressed — attempt ${attempt}</summary>
    ${detail || '<div class="feedback-note">Previous note: (tags only)</div>'}
  </details>`;
}

function buildPendingCard(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card-wrap';
  wrap.dataset.id = item.id;

  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = item.id;
  if (item.risk === 'sensitive') card.classList.add('is-sensitive');

  const attemptBadge = (item.attempt || 1) > 1
    ? `<span class="chip attempt-badge">attempt ${item.attempt}</span>` : '';

  card.innerHTML = `
    <div class="card-media">
      <div class="media-wrap">${renderMedia(item)}</div>
      ${renderSlideStrip(item)}
    </div>
    <div class="card-body">
      <div class="card-hook">${esc(item.overlays?.hook || '(no hook)')}</div>
      ${renderFeedbackBanner(item)}
      ${item.risk === 'sensitive' ? `
      <div class="sensitive-gate">
        <div class="sensitive-gate-label">Sensitive — memorial / kids / UGC. Type CONFIRM to unlock actions.</div>
        <input type="text" class="confirm-input" placeholder="type CONFIRM" autocomplete="off" spellcheck="false" aria-label="Type CONFIRM to unlock actions" />
      </div>` : ''}
      <div class="caption">
        <div class="caption-display${item.caption ? '' : ' is-empty'}" role="textbox" tabindex="0" aria-label="Caption, click to edit">${esc(item.caption || '(no caption — click to add)')}</div>
      </div>
      <div class="card-meta">
        ${item.pillar ? `<span class="chip chip-strong">${esc(item.pillar)}</span>` : ''}
        <span class="chip risk-chip risk-${esc(item.risk)}" title="${esc(RISK_TOOLTIP)}">risk: ${esc(item.risk)}</span>
        ${attemptBadge}
        ${renderLint(item.lint)}
        ${renderDedupe(item.dedupe)}
        ${item.hashtags?.length ? `<span class="chip">${item.hashtags.length} tag${item.hashtags.length > 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <div class="card-actions">
      <button type="button" class="btn btn-primary" data-action="approve" aria-label="Approve">Approve <kbd>a</kbd></button>
      <button type="button" class="btn" data-action="edit" aria-label="Edit and approve">Edit & approve <kbd>e</kbd></button>
      <button type="button" class="btn" data-action="changes_requested" aria-label="Request changes">Request changes <kbd>c</kbd></button>
      <button type="button" class="btn btn-danger-ghost" data-action="rejected" aria-label="Reject">Reject <kbd>r</kbd></button>
    </div>`;

  wrap.appendChild(card);

  const panel = document.createElement('div');
  panel.className = 'reason-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="reason-panel-title"></div>
    <div class="reason-chips">${REASON_TAGS.map((t) => `<button type="button" class="reason-chip" data-tag="${t}">${t}</button>`).join('')}</div>
    <textarea class="note-box" placeholder="Optional note (required if you pick 'other')" aria-label="Note"></textarea>
    <div class="reason-error" hidden></div>
    <div class="reason-actions">
      <button type="button" class="btn" data-action="cancel-reason">Cancel <kbd>esc</kbd></button>
      <button type="button" class="btn btn-primary" data-action="submit-reason">Submit</button>
    </div>`;
  wrap.appendChild(panel);

  const errEl = document.createElement('div');
  errEl.className = 'card-error';
  errEl.hidden = true;
  wrap.appendChild(errEl);

  state.cardEls.set(item.id, card);
  state.pendingOrder.push(item.id);
  wirePendingCard(wrap, card, item);
  return wrap;
}

function wirePendingCard(wrap, card, item) {
  const originalCaption = item.caption || '';
  const captionWrap = card.querySelector('.caption');
  const display = card.querySelector('.caption-display');
  const panel = wrap.querySelector('.reason-panel');

  // Any interaction with the card makes it the keyboard-focused card. Fields
  // and the caption editor manage their own text focus on top of this.
  card.addEventListener('mousedown', () => {
    state.focusId = item.id;
    applyFocusStyles();
  });

  // caption click-to-edit: display div -> textarea, exactly like before.
  display.addEventListener('click', () => enterCaptionEdit(card, originalCaption));
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterCaptionEdit(card, originalCaption); }
  });

  // media: video play toggle + carousel slide strip
  wireMedia(card, item);

  if (item.risk === 'sensitive') {
    const confirmInput = card.querySelector('.confirm-input');
    const actionButtons = card.querySelectorAll('.card-actions .btn');
    actionButtons.forEach((b) => { b.disabled = true; });
    confirmInput.addEventListener('input', () => {
      const ok = confirmInput.value === 'CONFIRM';
      card.classList.toggle('is-confirmed', ok);
      actionButtons.forEach((b) => { b.disabled = !ok; });
    });
  }

  card.querySelector('[data-action="approve"]').addEventListener('click', () => submitApprove(wrap, card, item));
  card.querySelector('[data-action="edit"]').addEventListener('click', () => enterCaptionEdit(card, originalCaption, true));
  card.querySelector('[data-action="changes_requested"]').addEventListener('click', () => openReasonPanel(wrap, card, 'changes_requested'));
  card.querySelector('[data-action="rejected"]').addEventListener('click', () => openReasonPanel(wrap, card, 'rejected'));
  panel.querySelector('[data-action="cancel-reason"]').addEventListener('click', () => closeReasonPanel(wrap, card));
  panel.querySelector('[data-action="submit-reason"]').addEventListener('click', () => submitReasonPanel(wrap, card, item));
  panel.querySelectorAll('.reason-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('is-selected'));
  });

  // keep originalCaption + dirty-tracking accessible on the card element
  card._originalCaption = originalCaption;
}

function wireMedia(card, item) {
  const frame = card.querySelector('.media-frame');
  if (!frame) return;
  const video = frame.querySelector('video');
  if (video) {
    frame.addEventListener('click', () => {
      if (video.paused) {
        video.play().then(() => frame.classList.add('is-playing')).catch(() => {});
      } else {
        video.pause();
        frame.classList.remove('is-playing');
      }
    });
    video.addEventListener('pause', () => frame.classList.remove('is-playing'));
    video.addEventListener('ended', () => frame.classList.remove('is-playing'));
    return;
  }
  // carousel: click cover toggles the slide strip; strip thumbs swap the cover
  const strip = card.querySelector('.slide-strip');
  if (strip) {
    const cover = frame.querySelector('img');
    frame.addEventListener('click', () => { strip.hidden = !strip.hidden; });
    strip.querySelectorAll('.slide-thumb').forEach((thumb, i) => {
      thumb.addEventListener('click', () => {
        const src = thumb.querySelector('img').src;
        if (cover) cover.src = src;
        strip.querySelectorAll('.slide-thumb').forEach((t) => t.classList.remove('is-active'));
        thumb.classList.add('is-active');
      });
    });
  }
}

// caption editing --------------------------------------------------

function enterCaptionEdit(card, originalCaption, selectEnd = false) {
  const captionWrap = card.querySelector('.caption');
  if (captionWrap.querySelector('.caption-edit')) {
    captionWrap.querySelector('.caption-edit').focus();
    return;
  }
  const display = captionWrap.querySelector('.caption-display');
  const ta = document.createElement('textarea');
  ta.className = 'caption-edit';
  ta.value = card._originalCaption ?? originalCaption;
  ta.rows = 3;
  const hint = document.createElement('div');
  hint.className = 'caption-editing-hint';
  hint.textContent = 'Editing caption — approve to save your edit, or press esc to revert.';

  display.hidden = true;
  captionWrap.appendChild(ta);
  captionWrap.appendChild(hint);

  ta.addEventListener('input', () => {
    captionWrap.classList.toggle('is-dirty', ta.value !== (card._originalCaption ?? originalCaption));
    display.textContent = ta.value || '(no caption — click to add)';
    display.classList.toggle('is-empty', !ta.value);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); exitCaptionEdit(card, true); }
  });

  ta.focus();
  if (selectEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
  card._captionDirty = () => captionWrap.classList.contains('is-dirty');
  card._captionValue = () => ta.value;
}

function exitCaptionEdit(card, revert = false) {
  const captionWrap = card.querySelector('.caption');
  const ta = captionWrap.querySelector('.caption-edit');
  const hint = captionWrap.querySelector('.caption-editing-hint');
  const display = captionWrap.querySelector('.caption-display');
  if (!ta) return;
  if (revert) {
    display.textContent = card._originalCaption || '(no caption — click to add)';
    display.classList.toggle('is-empty', !card._originalCaption);
    captionWrap.classList.remove('is-dirty');
  }
  ta.remove();
  hint?.remove();
  display.hidden = false;
}

// sensitive gate ---------------------------------------------------

function guardSensitive(card, item) {
  if (item.risk !== 'sensitive' || card.classList.contains('is-confirmed')) return true;
  const input = card.querySelector('.confirm-input');
  if (input) {
    input.focus();
    input.classList.remove('shake');
    void input.offsetWidth; // restart the animation on repeated attempts
    input.classList.add('shake');
  }
  return false;
}

// reason panel -----------------------------------------------------

function openReasonPanel(wrap, card, decisionType) {
  if (!guardSensitive(card, item(card))) return;
  const panel = wrap.querySelector('.reason-panel');
  panel.dataset.decision = decisionType;
  panel.hidden = false;
  panel.querySelector('.reason-panel-title').textContent =
    decisionType === 'rejected' ? 'Reject — why?' : 'Request changes — what should improve?';
  panel.querySelectorAll('.reason-chip').forEach((b) => b.classList.remove('is-selected'));
  panel.querySelector('.note-box').value = '';
  panel.querySelector('.reason-error').hidden = true;
  card.classList.add('is-panel-open');
  panel.querySelector('.note-box').focus();
}

function closeReasonPanel(wrap, card) {
  const panel = wrap.querySelector('.reason-panel');
  panel.hidden = true;
  card.classList.remove('is-panel-open');
}

function item(card) {
  return state.items.get(card.dataset.id);
}

function submitApprove(wrap, card, it) {
  const dirty = typeof card._captionDirty === 'function' && card._captionDirty();
  if (dirty) {
    const captionAfter = card._captionValue();
    attemptDecide(wrap, card, it, 'edited', { captionAfter });
  } else {
    attemptDecide(wrap, card, it, 'approved');
  }
}

function submitReasonPanel(wrap, card, it) {
  const panel = wrap.querySelector('.reason-panel');
  const decisionType = panel.dataset.decision;
  const tags = [...panel.querySelectorAll('.reason-chip.is-selected')].map((b) => b.dataset.tag);
  const note = panel.querySelector('.note-box').value.trim();
  const errEl = panel.querySelector('.reason-error');

  if (!tags.length && !note) {
    errEl.textContent = 'Pick at least one reason tag or add a note.';
    errEl.hidden = false;
    return;
  }
  if (tags.includes('other') && !note) {
    errEl.textContent = "Add a note explaining 'other'.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  attemptDecide(wrap, card, it, decisionType, { reasonTags: tags, note: note || null });
}

async function attemptDecide(wrap, card, it, decision, extra = {}) {
  if (!guardSensitive(card, it)) return;
  if (state.busy.has(it.id)) return;

  state.busy.add(it.id);
  card.classList.add('is-busy');
  clearCardError(wrap);

  try {
    const result = await API.decide({
      itemId: it.id,
      decision,
      reasonTags: extra.reasonTags || [],
      note: extra.note ?? null,
      captionAfter: extra.captionAfter ?? null,
    });
    toast(describeOutcome(result), 'success');
    await reload();
  } catch (err) {
    showCardError(wrap, err.message || 'Failed to save decision.');
    toast(err.message || 'Failed to save decision.', 'error');
  } finally {
    state.busy.delete(it.id);
    card.classList.remove('is-busy');
  }
}

function showCardError(wrap, msg) {
  const el = wrap.querySelector('.card-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function clearCardError(wrap) {
  const el = wrap?.querySelector('.card-error');
  if (el) el.hidden = true;
}

// ------------------------------------------------------------- history view

function renderHistory(data) {
  const content = $('#content');
  content.textContent = '';

  const decided = data.groups
    .flatMap((g) => g.items)
    .filter((i) => i.decision)
    .sort((a, b) => new Date(b.decision.decided_at || 0) - new Date(a.decision.decided_at || 0));

  content.appendChild(viewHead('History',
    decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'}, newest first.` : 'No decisions yet.'));

  if (!decided.length) {
    content.appendChild(emptyState('No decisions yet', 'Approvals, edits and rejections will show up here once you start reviewing.'));
    return;
  }

  const list = document.createElement('div');
  list.className = 'history-list';
  for (const it of decided) list.appendChild(buildHistoryRow(it));
  content.appendChild(list);
}

function buildHistoryRow(it) {
  const d = it.decision || {};
  let decisionKey = d.decision || it.status;
  if (it.status === 'skipped' && d.reason_tags?.includes('candidate-not-chosen')) decisionKey = 'skipped';
  const label = OUTCOME_LABELS[decisionKey] || OUTCOME_LABELS[it.status] || it.status;
  const autoSkip = d.reason_tags?.includes('candidate-not-chosen');

  const row = document.createElement('div');
  row.className = `history-row decision-${decisionKey}`;

  const tags = (d.reason_tags || []).filter((t) => t !== 'candidate-not-chosen');
  const detailBits = [];
  if (tags.length) detailBits.push(`<div class="history-tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`);
  if (d.note) detailBits.push(`<div class="note-quote">"${esc(d.note)}"</div>`);
  if (d.caption_diff) {
    detailBits.push(`<div class="caption-diff">
      <div class="diff-line diff-before"><span class="diff-label">before</span>${esc(d.caption_diff.before)}</div>
      <div class="diff-line diff-after"><span class="diff-label">after</span>${esc(d.caption_diff.after)}</div>
    </div>`);
  } else if (it.caption) {
    detailBits.push(`<div>${esc(it.caption)}</div>`);
  }
  if (it.feedback) {
    detailBits.push(`<div class="note-quote">feedback for redraft: ${esc(it.feedback.note || '(tags only)')}</div>`);
  }

  row.innerHTML = `
    <button type="button" class="history-summary" aria-expanded="false">
      <span class="decision-dot" aria-hidden="true"></span>
      <span class="history-hook">${esc(it.overlays?.hook || it.caption || it.id)}</span>
      <span class="history-id">${esc(it.id)}</span>
      <span class="history-decision">${esc(label)}${autoSkip ? ' (auto)' : ''}</span>
      <span class="history-via">${esc(d.via || '')}</span>
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

// ------------------------------------------------------------- planned view

function renderPlanned(data) {
  const content = $('#content');
  content.textContent = '';

  // Upcoming shells = candidate groups that still have work to do (anything not
  // fully decided). Grouped by the calendar day of their slot, soonest first.
  const shells = data.groups
    .filter((g) => g.items.some((i) => i.status !== 'skipped' && i.status !== 'archived' && i.status !== 'measured'))
    .slice()
    .sort((a, b) => new Date(a.slot_at) - new Date(b.slot_at));

  content.appendChild(viewHead('Planned',
    shells.length ? `${shells.length} upcoming slot${shells.length === 1 ? '' : 's'} on the schedule.` : 'Nothing scheduled.'));

  if (!shells.length) {
    content.appendChild(emptyState('Nothing planned', 'Scheduled slots will appear here as the planner fills the calendar.'));
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
    const grid = groups.map(buildShellCard).join('');
    dayEl.innerHTML = `<div class="day-head">${esc(label)}</div><div class="shell-grid">${grid}</div>`;
    content.appendChild(dayEl);
  }
}

function buildShellCard(group) {
  const pending = group.items.filter((i) => i.status === 'pending_review').length;
  const approved = group.items.filter((i) => i.status === 'approved' || i.status === 'scheduled' || i.status === 'published').length;
  const other = group.items.length - pending - approved;
  const bits = [];
  if (pending) bits.push(`<span class="dot pending">${pending} pending</span>`);
  if (approved) bits.push(`<span class="dot approved">${approved} approved</span>`);
  if (other) bits.push(`<span class="dot other">${other} other</span>`);
  return `<div class="slot-shell">
    <div class="shell-head">
      ${platformBadge(group.platform)}
      <span class="chip">${esc(FORMAT_LABELS[group.format] || group.format)}</span>
      <span class="shell-time">${esc(formatClock(group.slot_at))}</span>
    </div>
    <div class="shell-status">${bits.join('') || '<span class="dot other">no items</span>'}</div>
  </div>`;
}

// -------------------------------------------------------------- shared UI

function emptyState(title, htmlBody, isError = false) {
  const el = document.createElement('div');
  el.className = `empty${isError ? ' is-error' : ''}`;
  el.innerHTML = `<div class="empty-title">${esc(title)}</div><div>${htmlBody}</div>`;
  return el;
}

function renderSkeleton() {
  const content = $('#content');
  content.innerHTML = `
    <div class="view-head"><div class="view-title">Queue</div></div>
    <div class="skeleton">
      ${[0, 1].map(() => `
        <div class="sk-group">
          <div class="sk-head"></div>
          ${[0, 1].map(() => `
            <div class="sk-card">
              <div class="sk-media"></div>
              <div class="sk-body">
                <div class="sk-line w-70"></div>
                <div class="sk-line w-90"></div>
                <div class="sk-line w-50"></div>
                <div class="sk-line w-40"></div>
              </div>
              <div class="sk-actions">
                <div class="sk-btn"></div><div class="sk-btn"></div><div class="sk-btn"></div>
              </div>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;
}

// -------------------------------------------------------------- keyboard nav

function applyFocusStyles() {
  document.querySelectorAll('.card.is-focused').forEach((c) => c.classList.remove('is-focused'));
  const el = state.focusId ? state.cardEls.get(state.focusId) : null;
  if (el) el.classList.add('is-focused');
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

function focusedCtx() {
  if (!state.focusId) return null;
  const it = state.items.get(state.focusId);
  const card = state.cardEls.get(state.focusId);
  if (!it || !card) return null;
  return { item: it, card, wrap: card.closest('.card-wrap') };
}

function wireGlobalKeyboard() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    if (e.key === 'Escape') {
      if (!$('#cheatsheet').hidden) { closeCheatsheet(); return; }
      if (inField) {
        if (active.classList.contains('caption-edit')) { exitCaptionEdit(active.closest('.card'), true); return; }
        active.blur();
        return;
      }
      document.querySelectorAll('.card.is-panel-open').forEach((c) => closeReasonPanel(c.closest('.card-wrap'), c));
      return;
    }

    if (e.key === '?' && !inField) { toggleCheatsheet(); e.preventDefault(); return; }

    if (inField) return; // let normal typing through
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.view !== 'queue') return; // shortcuts act on the queue only

    switch (e.key) {
      case 'j': moveFocus(1); break;
      case 'k': moveFocus(-1); break;
      case 'n': jumpNextGroup(); break;
      case 'a': { const c = focusedCtx(); if (c) submitApprove(c.wrap, c.card, c.item); break; }
      case 'e': { const c = focusedCtx(); if (c) enterCaptionEdit(c.card, c.item.caption || '', true); break; }
      case 'c': { const c = focusedCtx(); if (c) openReasonPanel(c.wrap, c.card, 'changes_requested'); break; }
      case 'r': { const c = focusedCtx(); if (c) openReasonPanel(c.wrap, c.card, 'rejected'); break; }
      default: return;
    }
    e.preventDefault();
  });
}

// --------------------------------------------------------------- cheatsheet

function toggleCheatsheet() {
  const sheet = $('#cheatsheet');
  if (sheet.hidden) openCheatsheet(); else closeCheatsheet();
}
function openCheatsheet() { $('#cheatsheet').hidden = false; }
function closeCheatsheet() { $('#cheatsheet').hidden = true; }

// ----------------------------------------------------------------- sidebar

function openSidebar() {
  $('#sidebar').classList.add('is-open');
  $('#sidebar-scrim').classList.add('is-open');
  $('#sidebar-scrim').hidden = false;
  $('#nav-toggle').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('#sidebar').classList.remove('is-open');
  $('#sidebar-scrim').classList.remove('is-open');
  $('#sidebar-scrim').hidden = true;
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

// ------------------------------------------------------------------- boot

async function reload() {
  try {
    const data = await API.items();
    state.data = data;
    renderHeader(data);
    render();
  } catch (err) {
    state.data = { groups: [], pending_count: 0 };
    $('#content').innerHTML = '';
    $('#content').appendChild(emptyState('Could not load queue', `Failed to load <code>/api/items</code>: ${esc(err.message)}`, true));
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
}

async function init() {
  wireChrome();
  wireGlobalKeyboard();
  renderSkeleton();
  await reload();
}

init();
