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
  card.dataset.format = item.format || '';
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
  if (!frame || frame.classList.contains('no-asset')) return;

  // AP-830: the inline thumbnail is now a LAUNCHER. Clicking the media opens
  // the full-screen preview modal (device-framed, inspectable) instead of
  // playing/expanding inline — inline was the owner's "impossible to inspect"
  // complaint. The modal owns playback, carousel swiping and the IG-post mock.
  frame.style.cursor = 'zoom-in';
  frame.setAttribute('role', 'button');
  frame.setAttribute('tabindex', '0');
  frame.setAttribute('aria-label', 'Open full preview');
  frame.title = 'Open full preview (p)';
  frame.classList.add('is-launcher');
  frame.addEventListener('click', (e) => { e.stopPropagation(); openPreview(item.id); });
  frame.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openPreview(item.id); }
  });

  // A carousel's slide strip (if rendered) deep-links straight to that slide.
  const strip = card.querySelector('.slide-strip');
  if (strip) {
    strip.querySelectorAll('.slide-thumb').forEach((thumb, i) => {
      thumb.addEventListener('click', (e) => { e.stopPropagation(); openPreview(item.id, { slide: i }); });
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

// Shared reason validation (card panel + modal reason sheet). Returns an error
// string to show, or null when the tags/note pass. Mirrors the server-side
// REASON_REQUIRED_DECISIONS guard so the user never round-trips for it.
function validateReason(tags, note) {
  if (!tags.length && !note) return 'Pick at least one reason tag or add a note.';
  if (tags.includes('other') && !note) return "Add a note explaining 'other'.";
  return null;
}

function submitReasonPanel(wrap, card, it) {
  const panel = wrap.querySelector('.reason-panel');
  const decisionType = panel.dataset.decision;
  const tags = [...panel.querySelectorAll('.reason-chip.is-selected')].map((b) => b.dataset.tag);
  const note = panel.querySelector('.note-box').value.trim();
  const errEl = panel.querySelector('.reason-error');

  const reasonError = validateReason(tags, note);
  if (reasonError) {
    errEl.textContent = reasonError;
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  attemptDecide(wrap, card, it, decisionType, { reasonTags: tags, note: note || null });
}

// Shared decide core — the queue card AND the preview modal both go through
// this so there is a single decision path. Fires POST /api/decide, shows the
// outcome toast, and reloads the queue. Throws on failure so each surface can
// render the error where it makes sense (card error line / modal footer).
async function submitDecision({ itemId, decision, reasonTags = [], note = null, captionAfter = null }) {
  const result = await API.decide({ itemId, decision, reasonTags, note, captionAfter });
  toast(describeOutcome(result), 'success');
  await reload();
  return result;
}

async function attemptDecide(wrap, card, it, decision, extra = {}) {
  if (!guardSensitive(card, it)) return;
  if (state.busy.has(it.id)) return;

  state.busy.add(it.id);
  card.classList.add('is-busy');
  clearCardError(wrap);

  try {
    await submitDecision({
      itemId: it.id,
      decision,
      reasonTags: extra.reasonTags || [],
      note: extra.note ?? null,
      captionAfter: extra.captionAfter ?? null,
    });
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
    // While the preview modal is open it owns the keyboard (its own capture
    // listener handles esc / arrows / a·e·c·r and traps Tab), so the queue
    // shortcuts below must not also fire behind the scrim.
    if (isPreviewOpen()) return;

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
      case 'p': { const c = focusedCtx(); if (c) openPreview(c.item.id); break; }
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

// ============================================================================
// PREVIEW MODAL (AP-830) — full-screen device preview + inspector.
//
// Opened from a card's media (or `p` on the focused card). Shows the post in
// its real platform context — a 9:16 TikTok/Reels player or a 4:5 Instagram
// feed post — inside a phone frame, beside a tabbed inspector (Details / Why
// this? / Files). Decisions in the footer run the SAME submitDecision() path
// the queue cards use, then advance to the next pending item.
//
// The AP-831 payload additions (item.rationale / item.provenance /
// item.feedback_history) are rendered ONLY when present and degrade silently
// when absent.
// ============================================================================

const ICON = {
  chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  reel: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  heartFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5a8.4 8.4 0 0 1-.9-3.9A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>',
  shareArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
  paperplane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

const preview = {
  open: false,
  itemId: null,
  mode: 'reel', // 'reel' (9:16 video) | 'post' (4:5 IG feed)
  reelPlatform: 'tiktok', // 'tiktok' | 'instagram'
  slide: 0,
  reason: null, // 'changes_requested' | 'rejected' | null
  editing: false,
  captionValue: null,
  activeTab: 'details',
  unlocked: false, // sensitive gate cleared
  restoreFocus: null,
  video: null,
  els: {},
};

function isPreviewOpen() { return preview.open; }

function primaryMediaKind(item) {
  const assets = Array.isArray(item?.assets) ? item.assets : [];
  if (assets[0] && isVideoAsset(assets[0])) return 'video';
  if (['reel', 'tiktok_video', 'video'].includes(item?.format)) return 'video';
  return 'image';
}

// ------------------------------------------------------------ shell + lifecycle

function wirePreview() {
  const scrim = document.createElement('div');
  scrim.className = 'pv-scrim';
  scrim.id = 'pv-scrim';
  scrim.hidden = true;
  scrim.innerHTML = `
    <div class="pv-frame">
      <button type="button" class="pv-arrow pv-arrow-prev" aria-label="Previous pending item">${ICON.chevL}</button>
      <div class="pv-modal" role="dialog" aria-modal="true" aria-label="Post preview">
        <div class="pv-stage" id="pv-stage"></div>
        <aside class="pv-side">
          <button type="button" class="pv-close" id="pv-close" aria-label="Close preview">${ICON.x}</button>
          <div class="pv-tabs" id="pv-tabs" role="tablist"></div>
          <div class="pv-tabpanels" id="pv-tabpanels"></div>
          <div class="pv-actions" id="pv-actions"></div>
        </aside>
      </div>
      <button type="button" class="pv-arrow pv-arrow-next" aria-label="Next pending item">${ICON.chevR}</button>
    </div>`;
  document.body.appendChild(scrim);

  preview.els = {
    scrim,
    frame: scrim.querySelector('.pv-frame'),
    modal: scrim.querySelector('.pv-modal'),
    stage: scrim.querySelector('#pv-stage'),
    tabs: scrim.querySelector('#pv-tabs'),
    panels: scrim.querySelector('#pv-tabpanels'),
    actions: scrim.querySelector('#pv-actions'),
    prev: scrim.querySelector('.pv-arrow-prev'),
    next: scrim.querySelector('.pv-arrow-next'),
    close: scrim.querySelector('#pv-close'),
  };

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim || e.target === preview.els.frame) closePreview();
  });
  preview.els.close.addEventListener('click', closePreview);
  preview.els.prev.addEventListener('click', () => modalNavigate(-1));
  preview.els.next.addEventListener('click', () => modalNavigate(1));

  // capture phase so this runs BEFORE the queue keyboard handler and can trap keys
  document.addEventListener('keydown', onPreviewKeydown, true);
}

function lockBodyScroll(on) {
  if (on) {
    const sw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sw > 0) document.body.style.paddingRight = `${sw}px`; // no layout shift when the scrollbar vanishes
  } else {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

function teardownVideo() {
  if (preview.video) {
    try { preview.video.pause(); preview.video.removeAttribute('src'); preview.video.load(); } catch { /* noop */ }
    preview.video = null;
  }
}

function resetPreviewItemState(it) {
  preview.slide = 0;
  preview.reason = null;
  preview.editing = false;
  preview.captionValue = null;
  preview.unlocked = false;
  preview.mode = primaryMediaKind(it) === 'video' ? 'reel' : 'post';
  preview.reelPlatform = it.platform === 'tiktok' ? 'tiktok' : 'instagram';
  if (preview.activeTab === 'why' && !it.rationale) preview.activeTab = 'details';
}

function openPreview(itemId, opts = {}) {
  const it = state.items.get(itemId);
  if (!it) return;
  preview.restoreFocus = document.activeElement;
  preview.open = true;
  preview.itemId = itemId;
  preview.activeTab = 'details';
  resetPreviewItemState(it);
  preview.slide = opts.slide || 0;

  lockBodyScroll(true);
  preview.els.scrim.hidden = false;
  void preview.els.scrim.offsetWidth; // reflow so the fade-in transition runs
  preview.els.scrim.classList.add('is-open');
  renderPreview();
  preview.els.close.focus();
}

function closePreview() {
  if (!preview.open) return;
  teardownVideo();
  preview.open = false;
  const scrim = preview.els.scrim;
  scrim.classList.remove('is-open');
  setTimeout(() => { if (!preview.open) { scrim.hidden = true; preview.els.stage.textContent = ''; } }, 180);
  lockBodyScroll(false);

  const restore = preview.restoreFocus;
  preview.restoreFocus = null;
  preview.itemId = null;
  if (restore && document.contains(restore) && typeof restore.focus === 'function') {
    try { restore.focus(); } catch { /* noop */ }
  } else {
    const el = state.focusId ? state.cardEls.get(state.focusId) : null;
    el?.querySelector('.media-frame')?.focus?.();
  }
}

function renderPreview() {
  const it = state.items.get(preview.itemId);
  if (!it) { closePreview(); return; }
  renderStage(it);
  renderTabs(it);
  renderTabPanels(it);
  renderActions(it);
  updateNavArrows();
}

// ------------------------------------------------------------ item navigation

function pendingIndex() { return state.pendingOrder.indexOf(preview.itemId); }

function updateNavArrows() {
  const idx = pendingIndex();
  const n = state.pendingOrder.length;
  preview.els.prev.disabled = !(idx > 0);
  preview.els.next.disabled = !(idx >= 0 && idx < n - 1);
}

function modalNavigate(delta) {
  const idx = pendingIndex();
  if (idx === -1) return;
  const next = idx + delta;
  if (next < 0 || next >= state.pendingOrder.length) return;
  teardownVideo();
  preview.itemId = state.pendingOrder[next];
  const it = state.items.get(preview.itemId);
  resetPreviewItemState(it);
  state.focusId = preview.itemId; // keep the queue behind the modal in sync
  applyFocusStyles();
  renderPreview();
}

// left/right page through a carousel's slides first, then spill over into the
// prev/next pending item — so the arrow keys drive both, as the ticket asks.
function previewArrow(dir) {
  const it = state.items.get(preview.itemId);
  const slideCount = (it?.assets?.length) || 1;
  if (preview.mode === 'post' && slideCount > 1) {
    const nextSlide = preview.slide + dir;
    if (nextSlide >= 0 && nextSlide < slideCount) {
      preview.slide = nextSlide;
      const media = preview.els.stage.querySelector('.ig-media');
      const post = preview.els.stage.querySelector('.ig-post');
      if (media && post) updateIgCarousel(media, post, slideCount);
      return;
    }
  }
  modalNavigate(dir);
}

// --------------------------------------------------------------- phone stage

function renderStage(it) {
  const stage = preview.els.stage;
  teardownVideo();
  stage.textContent = '';

  const top = document.createElement('div');
  top.className = 'pv-stage-top';
  top.appendChild(buildModeSwitch(it));
  stage.appendChild(top);

  const phone = document.createElement('div');
  phone.className = 'pv-phone';
  phone.dataset.mode = preview.mode;
  const screen = document.createElement('div');
  screen.className = 'pv-screen';
  phone.appendChild(screen);
  stage.appendChild(phone);

  if (preview.mode === 'reel') buildReel(screen, it);
  else buildPost(screen, it);

  const counter = document.createElement('div');
  counter.className = 'pv-counter';
  const idx = pendingIndex();
  const n = state.pendingOrder.length;
  counter.innerHTML = (idx >= 0 && n) ? `<b>${idx + 1}</b> of <b>${n}</b> pending` : esc(it.id);
  stage.appendChild(counter);
}

function buildModeSwitch(it) {
  const wrap = document.createElement('div');
  wrap.className = 'pv-stage-switches';
  wrap.style.display = 'flex';
  wrap.style.gap = '8px';
  wrap.style.alignItems = 'center';

  const seg = document.createElement('div');
  seg.className = 'pv-modeswitch';
  seg.innerHTML = `
    <button type="button" class="pv-seg${preview.mode === 'reel' ? ' is-active' : ''}" data-mode="reel">${ICON.reel} Reel</button>
    <button type="button" class="pv-seg${preview.mode === 'post' ? ' is-active' : ''}" data-mode="post">${ICON.grid} Post</button>`;
  seg.querySelectorAll('.pv-seg').forEach((b) => b.addEventListener('click', () => setPreviewMode(b.dataset.mode)));
  wrap.appendChild(seg);

  if (preview.mode === 'reel') {
    const plat = document.createElement('div');
    plat.className = 'pv-modeswitch';
    plat.innerHTML = `
      <button type="button" class="pv-seg${preview.reelPlatform === 'tiktok' ? ' is-active' : ''}" data-plat="tiktok">TikTok</button>
      <button type="button" class="pv-seg${preview.reelPlatform === 'instagram' ? ' is-active' : ''}" data-plat="instagram">Reels</button>`;
    plat.querySelectorAll('.pv-seg').forEach((b) => b.addEventListener('click', () => {
      preview.reelPlatform = b.dataset.plat;
      renderStage(state.items.get(preview.itemId));
    }));
    wrap.appendChild(plat);
  }
  return wrap;
}

function setPreviewMode(mode) {
  if (preview.mode === mode) return;
  preview.mode = mode;
  preview.slide = 0;
  renderStage(state.items.get(preview.itemId));
}

// ------------------------------------------------------------ reel (9:16)

function buildReel(screen, it) {
  const assets = Array.isArray(it.assets) ? it.assets : [];
  const first = assets[0];
  const platform = preview.reelPlatform;
  screen.classList.remove('is-paused');

  const reel = document.createElement('div');
  reel.className = 'pv-reel';
  reel.dataset.platform = platform;

  let mediaEl;
  if (first && isVideoAsset(first)) {
    const v = document.createElement('video');
    v.className = 'pv-video';
    v.src = assetUrl(it.id, first.path);
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.preload = 'auto';
    preview.video = v;
    mediaEl = v;
  } else if (first) {
    const img = document.createElement('img');
    img.className = 'pv-video';
    img.src = assetUrl(it.id, first.path);
    img.alt = esc(it.overlays?.hook || 'preview');
    mediaEl = img;
  } else {
    mediaEl = document.createElement('div');
    mediaEl.className = 'pv-video';
    mediaEl.style.cssText = 'display:grid;place-items:center;color:#64748b;font-size:12px';
    mediaEl.textContent = 'no asset';
  }
  reel.appendChild(mediaEl);
  reel.insertAdjacentHTML('beforeend', '<div class="pv-reel-topgrad"></div><div class="pv-reel-grad"></div>');

  if (preview.video) {
    const tap = document.createElement('button');
    tap.type = 'button';
    tap.className = 'pv-tap';
    tap.setAttribute('aria-label', 'Play or pause');
    tap.addEventListener('click', () => { const v = preview.video; if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); } });
    reel.appendChild(tap);
    reel.insertAdjacentHTML('beforeend', `<div class="pv-pausebadge">${ICON.play}</div>`);
  }

  const topBar = document.createElement('div');
  topBar.className = 'pv-reel-top';
  topBar.innerHTML = `<div class="pv-progress"><div class="pv-progress-fill"></div></div>
    <button type="button" class="pv-mute" aria-label="Toggle sound">${ICON.muted}</button>`;
  reel.appendChild(topBar);

  const rail = document.createElement('div');
  rail.className = 'pv-rail';
  rail.setAttribute('aria-hidden', 'true');
  rail.innerHTML = platform === 'tiktok'
    ? `<button type="button" tabindex="-1">${ICON.heartFill}<span>12.4k</span></button>
       <button type="button" tabindex="-1">${ICON.comment}<span>318</span></button>
       <button type="button" tabindex="-1">${ICON.bookmark}<span>Save</span></button>
       <button type="button" tabindex="-1">${ICON.shareArrow}<span>Share</span></button>
       <div class="pv-disc"></div>`
    : `<button type="button" tabindex="-1">${ICON.heart}<span>12.4k</span></button>
       <button type="button" tabindex="-1">${ICON.comment}<span>318</span></button>
       <button type="button" tabindex="-1">${ICON.paperplane}<span>Share</span></button>
       <button type="button" tabindex="-1">${ICON.bookmark}<span></span></button>`;
  reel.appendChild(rail);

  const meta = document.createElement('div');
  meta.className = 'pv-reel-meta';
  const tags = Array.isArray(it.hashtags) ? it.hashtags : [];
  const full = [it.caption || '', tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('  ');
  meta.innerHTML = `
    <div class="pv-handle">@getforevermore</div>
    <div class="pv-reel-caption"></div>
    ${platform === 'tiktok' ? `<div class="pv-reel-music">${ICON.music}<span>original sound — getforevermore</span></div>` : ''}`;
  const capEl = meta.querySelector('.pv-reel-caption');
  if (full.length > 100) {
    capEl.textContent = `${full.slice(0, 100).trimEnd()}… `;
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'pv-more'; more.textContent = 'more';
    more.addEventListener('click', () => { capEl.textContent = full; });
    capEl.appendChild(more);
  } else {
    capEl.textContent = full || '(no caption)';
  }
  reel.appendChild(meta);

  screen.appendChild(reel);
  if (preview.video) wireReelVideo(screen, topBar);
}

function wireReelVideo(screen, topBar) {
  const v = preview.video;
  const fill = topBar.querySelector('.pv-progress-fill');
  const progress = topBar.querySelector('.pv-progress');
  const mute = topBar.querySelector('.pv-mute');

  v.addEventListener('timeupdate', () => { if (v.duration) fill.style.width = `${(v.currentTime / v.duration) * 100}%`; });
  v.addEventListener('play', () => screen.classList.remove('is-paused'));
  v.addEventListener('pause', () => screen.classList.add('is-paused'));
  progress.addEventListener('click', (e) => {
    const rect = progress.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    if (v.duration) v.currentTime = ratio * v.duration;
  });
  mute.addEventListener('click', () => { v.muted = !v.muted; mute.innerHTML = v.muted ? ICON.muted : ICON.volume; });
  v.play().then(() => screen.classList.remove('is-paused')).catch(() => screen.classList.add('is-paused'));
}

// -------------------------------------------------------- instagram post (4:5)

function igTimeLabel(it) {
  const d = new Date(it.slot_at);
  if (Number.isNaN(d.getTime())) return 'preview';
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(d);
}

function buildPost(screen, it) {
  const assets = Array.isArray(it.assets) ? it.assets : [];
  const slides = assets.length ? assets : [null];
  const isCarousel = slides.length > 1;
  preview.slide = Math.min(Math.max(preview.slide, 0), slides.length - 1);

  const post = document.createElement('div');
  post.className = 'pv-post';
  const cap = it.caption || '';
  const tags = Array.isArray(it.hashtags) ? it.hashtags : [];
  const tagline = tags.length ? ' ' + tags.map((t) => `<span class="ig-tag">#${esc(t)}</span>`).join(' ') : '';

  post.innerHTML = `
    <article class="ig-post">
      <header class="ig-head">
        <span class="ig-avatar"><span class="ig-avatar-inner"></span></span>
        <span class="ig-user">getforevermore<span>Sponsored</span></span>
        <button type="button" class="ig-more" tabindex="-1" aria-hidden="true">•••</button>
      </header>
      <div class="ig-media" data-count="${slides.length}"></div>
      ${isCarousel ? '<div class="ig-dots"></div>' : ''}
      <div class="ig-actions">
        <span class="ig-act">${ICON.heart}</span>
        <span class="ig-act">${ICON.comment}</span>
        <span class="ig-act">${ICON.paperplane}</span>
        <span class="ig-act ig-act-save">${ICON.bookmark}</span>
      </div>
      <div class="ig-likes">Liked by <b>you</b> and <b>1,204 others</b></div>
      <div class="ig-caption"><span class="ig-uinline">getforevermore</span>${esc(cap)}${tagline}</div>
      <div class="ig-time">${esc(igTimeLabel(it))}</div>
    </article>`;

  buildIgMedia(post.querySelector('.ig-media'), it, slides, isCarousel, post);
  screen.appendChild(post);
}

function buildIgMedia(media, it, slides, isCarousel, post) {
  const track = document.createElement('div');
  track.className = 'ig-track';
  slides.forEach((asset, i) => {
    const slide = document.createElement('div');
    slide.className = 'ig-slide';
    if (!asset) {
      slide.style.cssText = 'display:grid;place-items:center;color:#8e8e8e;font-size:12px';
      slide.textContent = 'no asset';
    } else if (isVideoAsset(asset)) {
      const v = document.createElement('video');
      v.src = assetUrl(it.id, asset.path);
      v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
      if (i === 0) { preview.video = v; v.play?.().catch(() => {}); }
      slide.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = assetUrl(it.id, asset.path);
      img.alt = `Slide ${i + 1}`;
      img.draggable = false;
      slide.appendChild(img);
    }
    track.appendChild(slide);
  });
  media.appendChild(track);

  if (!isCarousel) { track.style.transform = 'translateX(0)'; return; }

  media.insertAdjacentHTML('beforeend', `
    <button type="button" class="ig-arrow ig-arrow-prev" aria-label="Previous slide">${ICON.chevL}</button>
    <button type="button" class="ig-arrow ig-arrow-next" aria-label="Next slide">${ICON.chevR}</button>
    <div class="ig-count"></div>`);
  post.querySelector('.ig-dots').innerHTML = slides.map(() => '<span class="ig-dot"></span>').join('');

  const goTo = (i) => { preview.slide = Math.min(Math.max(i, 0), slides.length - 1); updateIgCarousel(media, post, slides.length); };
  media.querySelector('.ig-arrow-prev').addEventListener('click', () => goTo(preview.slide - 1));
  media.querySelector('.ig-arrow-next').addEventListener('click', () => goTo(preview.slide + 1));
  wireIgDrag(media, track, slides.length, goTo);
  updateIgCarousel(media, post, slides.length);
}

function updateIgCarousel(media, post, count) {
  const track = media.querySelector('.ig-track');
  const i = preview.slide;
  track.style.transform = `translateX(-${i * 100}%)`;
  const counter = media.querySelector('.ig-count');
  if (counter) counter.textContent = `${i + 1}/${count}`;
  const prev = media.querySelector('.ig-arrow-prev');
  const next = media.querySelector('.ig-arrow-next');
  if (prev) prev.hidden = i === 0;
  if (next) next.hidden = i === count - 1;
  post.querySelectorAll('.ig-dot').forEach((d, k) => d.classList.toggle('is-active', k === i));
}

function wireIgDrag(media, track, count, goTo) {
  let startX = 0, dx = 0, dragging = false, width = 0;
  media.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ig-arrow')) return;
    dragging = true; startX = e.clientX; dx = 0; width = media.clientWidth || 1;
    track.classList.add('is-dragging');
    try { media.setPointerCapture(e.pointerId); } catch { /* noop */ }
  });
  media.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const base = -preview.slide * width;
    let offset = dx;
    if ((preview.slide === 0 && dx > 0) || (preview.slide === count - 1 && dx < 0)) offset = dx * 0.35; // rubber-band at ends
    track.style.transform = `translateX(${base + offset}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('is-dragging');
    const threshold = width * 0.18;
    if (dx <= -threshold) goTo(preview.slide + 1);
    else if (dx >= threshold) goTo(preview.slide - 1);
    else goTo(preview.slide);
  };
  media.addEventListener('pointerup', end);
  media.addEventListener('pointercancel', end);
}

// --------------------------------------------------------------- side tabs

function renderTabs(it) {
  const tabs = preview.els.tabs;
  const hasWhy = !!it.rationale;
  if (preview.activeTab === 'why' && !hasWhy) preview.activeTab = 'details';
  const defs = [{ id: 'details', label: 'Details' }];
  if (hasWhy) defs.push({ id: 'why', label: 'Why this?' });
  defs.push({ id: 'files', label: 'Files' });
  tabs.innerHTML = defs.map((d) => `<button type="button" role="tab" class="pv-tab${preview.activeTab === d.id ? ' is-active' : ''}" data-tab="${d.id}" aria-selected="${preview.activeTab === d.id}">${esc(d.label)}</button>`).join('');
  tabs.querySelectorAll('.pv-tab').forEach((b) => b.addEventListener('click', () => {
    preview.activeTab = b.dataset.tab;
    renderTabs(it);
    renderTabPanels(it);
  }));
}

function renderTabPanels(it) {
  const panels = preview.els.panels;
  panels.textContent = '';
  if (preview.activeTab === 'why' && it.rationale) panels.appendChild(buildWhyTab(it));
  else if (preview.activeTab === 'files') panels.appendChild(buildFilesTab(it));
  else panels.appendChild(buildDetailsTab(it));
}

function fieldSection(label) {
  const s = document.createElement('div');
  s.innerHTML = `<div class="pv-field-label">${esc(label)}</div>`;
  return s;
}

function buildDetailsTab(it) {
  const panel = document.createElement('div');
  panel.className = 'pv-tabpanel';

  const capSection = fieldSection('Caption');
  if (preview.editing) {
    const ta = document.createElement('textarea');
    ta.className = 'pv-caption-edit';
    ta.value = preview.captionValue ?? (it.caption || '');
    ta.addEventListener('input', () => { preview.captionValue = ta.value; });
    capSection.appendChild(ta);
    const hint = document.createElement('div');
    hint.className = 'pv-edit-hint';
    hint.textContent = 'Editing caption — Approve saves it as an edit, or press esc to revert.';
    capSection.appendChild(hint);
  } else {
    const box = document.createElement('div');
    box.className = 'pv-caption-box' + (it.caption ? '' : ' is-empty');
    box.textContent = it.caption || '(no caption)';
    capSection.appendChild(box);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm pv-copy';
    copy.textContent = 'Copy caption';
    copy.addEventListener('click', () => copyText(it.caption || '', copy));
    capSection.appendChild(copy);
  }
  panel.appendChild(capSection);

  const tags = Array.isArray(it.hashtags) ? it.hashtags : [];
  if (tags.length) {
    const s = fieldSection('Hashtags');
    s.insertAdjacentHTML('beforeend', `<div class="pv-tags">${tags.map((t) => `<span class="pv-tag-chip">#${esc(t)}</span>`).join('')}</div>`);
    panel.appendChild(s);
  }

  const ov = it.overlays || {};
  if (ov.hook || (ov.beats && ov.beats.length) || ov.cta) {
    const s = fieldSection('Overlays');
    let html = '<div class="pv-overlays">';
    if (ov.hook) html += `<div class="pv-overlay-line"><span class="pv-ol-k">Hook:</span> ${esc(ov.hook)}</div>`;
    if (ov.beats && ov.beats.length) html += `<div class="pv-overlay-line"><span class="pv-ol-k">Beats</span></div><ol class="pv-beats">${ov.beats.map((b) => `<li>${esc(b)}</li>`).join('')}</ol>`;
    if (ov.cta) html += `<div class="pv-overlay-line"><span class="pv-ol-k">CTA:</span> ${esc(ov.cta)}</div>`;
    html += '</div>';
    s.insertAdjacentHTML('beforeend', html);
    panel.appendChild(s);
  }

  const meta = fieldSection('Post');
  meta.insertAdjacentHTML('beforeend', `
    <dl class="pv-meta-grid">
      <dt>Slot</dt><dd>${esc(formatSlot(it.slot_at))}</dd>
      <dt>Platform</dt><dd>${esc(PLATFORM_LABELS[it.platform] || it.platform || '—')}</dd>
      <dt>Format</dt><dd>${esc(FORMAT_LABELS[it.format] || it.format || '—')}</dd>
      <dt>Pillar</dt><dd>${esc(it.pillar || '—')}</dd>
      <dt>Risk</dt><dd>${esc(it.risk || '—')}</dd>
      <dt>Attempt</dt><dd>${esc(String(it.attempt || 1))}</dd>
    </dl>`);
  panel.appendChild(meta);

  const lintSection = fieldSection('Lint');
  const violations = it.lint?.violations || [];
  if (!violations.length) lintSection.insertAdjacentHTML('beforeend', '<span class="pv-lint-ok">Passed — no violations</span>');
  else lintSection.insertAdjacentHTML('beforeend', `<ul class="pv-lint-list">${violations.map((v) => `<li class="pv-lint-item sev-${esc(v.severity || 'warn')}"><b>${esc(v.rule || 'rule')}</b>${v.excerpt ? ` — ${esc(v.excerpt)}` : ''}</li>`).join('')}</ul>`);
  panel.appendChild(lintSection);

  if (it.dedupe) {
    const pct = Math.round((it.dedupe.hook_sim ?? 0) * 100);
    const dd = fieldSection('Dedupe');
    dd.insertAdjacentHTML('beforeend', `<div class="why-body">Hook similarity <b>${pct}%</b>${it.dedupe.nearest_item ? ` vs <code>${esc(it.dedupe.nearest_item)}</code>` : ''} <span style="color:var(--text-2)">(${esc(it.dedupe.method || '')})</span></div>`);
    panel.appendChild(dd);
  }
  return panel;
}

function copyText(text, btn) {
  const done = () => {
    btn.classList.add('is-copied');
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.classList.remove('is-copied'); btn.textContent = label; }, 1400);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* noop */ }
  ta.remove();
}

function whyBlock(h, body) {
  const el = document.createElement('div');
  el.className = 'why-block';
  el.innerHTML = `<div class="why-h">${esc(h)}</div><div class="why-body"></div>`;
  el.querySelector('.why-body').textContent = body;
  return el;
}

function buildWhyTab(it) {
  const r = it.rationale || {};
  const panel = document.createElement('div');
  panel.className = 'pv-tabpanel';

  if (r.summary) {
    const p = document.createElement('p');
    p.className = 'why-summary';
    p.textContent = r.summary;
    panel.appendChild(p);
  }
  if (r.hook_reasoning) panel.appendChild(whyBlock('The hook', r.hook_reasoning));

  const strat = r.strategy;
  if (strat) {
    const block = document.createElement('div');
    block.className = 'why-block';
    let html = '<div class="why-h">Strategy</div><div class="why-strategy">';
    html += `<div class="why-idea">${strat.idea_id ? `<span class="why-idea-id">${esc(strat.idea_id)}</span>` : ''}${esc(strat.idea_title || '')}</div>`;
    if (strat.pillar) html += `<div class="why-body" style="color:var(--text-2)">Pillar ${esc(strat.pillar)}</div>`;
    const rules = Array.isArray(strat.playbook_rules) ? strat.playbook_rules : [];
    if (rules.length) html += `<ul class="why-rules">${rules.map((pr) => `<li class="why-rule">${pr.id ? `<span class="why-rule-id">${esc(pr.id)}</span>` : ''}“${esc(pr.rule || '')}”</li>`).join('')}</ul>`;
    html += '</div>';
    block.innerHTML = html;
    panel.appendChild(block);
  }

  const craft = Array.isArray(r.craft) ? r.craft : [];
  if (craft.length) {
    const block = document.createElement('div');
    block.className = 'why-block';
    block.innerHTML = `<div class="why-h">Craft notes</div><ul class="why-list">${craft.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
    panel.appendChild(block);
  }

  if (r.audience) panel.appendChild(whyBlock('Audience', r.audience));

  const limits = Array.isArray(r.limits) ? r.limits : [];
  if (limits.length) {
    const block = document.createElement('div');
    block.className = 'why-limits';
    block.innerHTML = `<div class="why-h">Limits &amp; honest caveats</div><ul>${limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    panel.appendChild(block);
  }

  if (it.provenance) panel.appendChild(buildProvenance(it.provenance));
  const fh = Array.isArray(it.feedback_history) ? it.feedback_history : [];
  if (fh.length) panel.appendChild(buildFeedbackHistory(fh));
  return panel;
}

function buildProvenance(p) {
  const cells = [];
  if (p.model) cells.push(`model <b>${esc(p.model)}</b>`);
  if (p.driver) cells.push(`driver <b>${esc(p.driver)}</b>`);
  if (p.tokens_in != null || p.tokens_out != null) cells.push(`tokens <b>${esc(String(p.tokens_in ?? '?'))}/${esc(String(p.tokens_out ?? '?'))}</b>`);
  if (p.cost_usd != null) cells.push(`cost <b>$${esc(Number(p.cost_usd).toFixed(4))}</b>`);
  if (p.prompt_sha) cells.push(`prompt <b>${esc(String(p.prompt_sha).slice(0, 10))}</b>`);
  if (p.attempt != null) cells.push(`attempt <b>${esc(String(p.attempt))}</b>`);
  if (p.run_id) cells.push(`run <b>${esc(p.run_id)}</b>`);
  const el = document.createElement('div');
  el.className = 'prov';
  el.innerHTML = `<div class="why-h" style="margin-bottom:6px">Provenance</div>
    <div class="prov-grid">${cells.map((c) => `<span class="prov-cell">${c}</span>`).join('<span class="prov-sep">·</span>')}</div>
    ${p.generated_at ? `<div class="prov-grid" style="margin-top:5px"><span class="prov-cell">generated ${esc(formatTime(p.generated_at))}</span></div>` : ''}`;
  return el;
}

function buildFeedbackHistory(fh) {
  const sorted = fh.slice().sort((a, b) => new Date(b.decided_at || 0) - new Date(a.decided_at || 0));
  const el = document.createElement('div');
  el.className = 'why-block';
  el.innerHTML = '<div class="why-h">Feedback history</div>';
  const tl = document.createElement('div');
  tl.className = 'fb-timeline';
  for (const f of sorted) {
    const label = OUTCOME_LABELS[f.decision] || f.decision || 'decided';
    const tags = Array.isArray(f.reason_tags) ? f.reason_tags.filter((t) => t !== 'candidate-not-chosen') : [];
    const entry = document.createElement('div');
    entry.className = 'fb-entry';
    entry.innerHTML = `
      <div class="fb-entry-head">
        <span class="fb-decision d-${esc(f.decision || '')}">${esc(label)}</span>
        <span class="fb-when">${f.decided_at ? esc(formatTime(f.decided_at)) : ''}</span>
      </div>
      ${tags.length ? `<div class="fb-tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${f.note ? `<div class="fb-note">“${esc(f.note)}”</div>` : ''}`;
    tl.appendChild(entry);
  }
  el.appendChild(tl);
  return el;
}

function buildFilesTab(it) {
  const panel = document.createElement('div');
  panel.className = 'pv-tabpanel';
  const assets = Array.isArray(it.assets) ? it.assets : [];
  if (!assets.length) {
    panel.innerHTML = '<div class="why-body" style="color:var(--text-2)">No assets attached.</div>';
    return panel;
  }
  for (const a of assets) {
    const url = assetUrl(it.id, a.path);
    const name = a.path.split('/').pop();
    const meta = [];
    if (a.kind) meta.push(esc(a.kind));
    if (a.w && a.h) meta.push(`${a.w}×${a.h}`);
    if (a.dur_s) meta.push(`${a.dur_s}s`);
    if (a.sha256) meta.push(`sha ${esc(String(a.sha256).slice(0, 10))}`);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <div class="file-name">${esc(a.path)}</div>
      <div class="file-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      <div class="file-links">
        <a class="file-link" href="${url}" target="_blank" rel="noopener">${ICON.external} Open raw</a>
        <a class="file-link" href="${url}" download="${esc(name)}">${ICON.download} Download</a>
      </div>`;
    panel.appendChild(row);
  }
  return panel;
}

// ------------------------------------------------------------ footer actions

function isModalUnlocked() {
  const it = state.items.get(preview.itemId);
  return !it || it.risk !== 'sensitive' || preview.unlocked;
}
function flashSensitive() {
  const input = preview.els.actions.querySelector('.confirm-input');
  if (input) { input.focus(); input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); }
}

function renderActions(it) {
  const actions = preview.els.actions;
  actions.textContent = '';
  actions.classList.remove('is-busy');

  if (preview.reason) { actions.appendChild(buildReasonSheet(it, preview.reason)); return; }

  const sensitive = it.risk === 'sensitive';
  if (sensitive) {
    const gate = document.createElement('div');
    gate.className = 'sensitive-gate pv-sensitive-gate';
    gate.innerHTML = `
      <div class="sensitive-gate-label">Sensitive — type CONFIRM to unlock actions.</div>
      <input type="text" class="confirm-input" placeholder="type CONFIRM" autocomplete="off" spellcheck="false" aria-label="Type CONFIRM to unlock actions" value="${preview.unlocked ? 'CONFIRM' : ''}" />`;
    actions.appendChild(gate);
  }

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn-primary btn-block';
  approve.innerHTML = `${preview.editing ? 'Save &amp; approve' : 'Approve'} <kbd>a</kbd>`;
  approve.addEventListener('click', modalApprove);

  const row = document.createElement('div');
  row.className = 'pv-action-grid';
  row.append(
    actionBtn(preview.editing ? 'Cancel edit' : 'Edit', 'e', modalEditApprove),
    actionBtn('Changes', 'c', () => modalOpenReason('changes_requested')),
    actionBtn('Reject', 'r', () => modalOpenReason('rejected'), 'btn-danger-ghost'),
  );

  actions.append(approve, row);

  if (sensitive) {
    const input = actions.querySelector('.confirm-input');
    const btns = actions.querySelectorAll('.btn');
    btns.forEach((b) => { b.disabled = !preview.unlocked; });
    input.addEventListener('input', () => {
      preview.unlocked = input.value === 'CONFIRM';
      btns.forEach((b) => { b.disabled = !preview.unlocked; });
    });
  }
}

function actionBtn(label, key, handler, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${extraClass}`.trim();
  b.innerHTML = `${esc(label)} <kbd>${key}</kbd>`;
  b.addEventListener('click', handler);
  return b;
}

function buildReasonSheet(it, kind) {
  const sheet = document.createElement('div');
  sheet.className = 'pv-reason';
  sheet.innerHTML = `
    <div class="pv-reason-title">${kind === 'rejected' ? 'Reject — why?' : 'Request changes — what should improve?'}</div>
    <div class="reason-chips">${REASON_TAGS.map((t) => `<button type="button" class="reason-chip" data-tag="${t}">${t}</button>`).join('')}</div>
    <textarea class="note-box" placeholder="Optional note (required if you pick 'other')" aria-label="Note"></textarea>
    <div class="pv-error" hidden></div>
    <div class="pv-reason-actions">
      <button type="button" class="btn" data-act="cancel">Cancel <kbd>esc</kbd></button>
      <button type="button" class="btn btn-primary" data-act="submit">Submit</button>
    </div>`;
  sheet.querySelectorAll('.reason-chip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('is-selected')));
  sheet.querySelector('[data-act="cancel"]').addEventListener('click', () => { preview.reason = null; renderActions(it); });
  sheet.querySelector('[data-act="submit"]').addEventListener('click', () => {
    const tags = [...sheet.querySelectorAll('.reason-chip.is-selected')].map((b) => b.dataset.tag);
    const note = sheet.querySelector('.note-box').value.trim();
    const err = validateReason(tags, note);
    const errEl = sheet.querySelector('.pv-error');
    if (err) { errEl.textContent = err; errEl.hidden = false; return; }
    errEl.hidden = true;
    modalDecide(kind, { reasonTags: tags, note: note || null });
  });
  return sheet;
}

function modalApprove() {
  const it = state.items.get(preview.itemId);
  if (!it) return;
  if (!isModalUnlocked()) { flashSensitive(); return; }
  if (preview.editing) {
    const after = preview.captionValue ?? (it.caption || '');
    if (after !== (it.caption || '')) { modalDecide('edited', { captionAfter: after }); return; }
  }
  modalDecide('approved');
}

function modalEditApprove() {
  const it = state.items.get(preview.itemId);
  if (!it) return;
  if (!isModalUnlocked()) { flashSensitive(); return; }
  preview.editing = !preview.editing;
  preview.captionValue = preview.editing ? (it.caption || '') : null;
  if (preview.editing) preview.activeTab = 'details';
  renderTabs(it);
  renderTabPanels(it);
  renderActions(it);
  if (preview.editing) {
    const ta = preview.els.panels.querySelector('.pv-caption-edit');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function modalOpenReason(kind) {
  const it = state.items.get(preview.itemId);
  if (!it) return;
  if (!isModalUnlocked()) { flashSensitive(); return; }
  preview.reason = kind;
  renderActions(it);
  preview.els.actions.querySelector('.note-box')?.focus();
}

function showModalError(msg) {
  let el = preview.els.actions.querySelector('.pv-error');
  if (!el) { el = document.createElement('div'); el.className = 'pv-error'; preview.els.actions.prepend(el); }
  el.textContent = msg;
  el.hidden = false;
}

async function modalDecide(decision, extra = {}) {
  const it = state.items.get(preview.itemId);
  if (!it || state.busy.has(it.id)) return;
  const prevIndex = pendingIndex();
  state.busy.add(it.id);
  preview.els.actions.classList.add('is-busy');
  try {
    await submitDecision({
      itemId: it.id,
      decision,
      reasonTags: extra.reasonTags || [],
      note: extra.note ?? null,
      captionAfter: extra.captionAfter ?? null,
    });
    preview.reason = null;
    preview.editing = false;
    preview.captionValue = null;
    advanceAfterDecision(prevIndex);
  } catch (err) {
    showModalError(err.message || 'Failed to save decision.');
    toast(err.message || 'Failed to save decision.', 'error');
    preview.els.actions.classList.remove('is-busy');
  } finally {
    state.busy.delete(it.id);
  }
}

// After a decision the queue has reloaded (state.pendingOrder is fresh). Land on
// the item that shifted into the decided one's slot; close when none remain.
function advanceAfterDecision(prevIndex) {
  const order = state.pendingOrder;
  if (!order.length) { closePreview(); return; }
  const idx = Math.min(Math.max(prevIndex, 0), order.length - 1);
  teardownVideo();
  preview.itemId = order[idx];
  const it = state.items.get(preview.itemId);
  resetPreviewItemState(it);
  state.focusId = preview.itemId;
  applyFocusStyles();
  renderPreview();
}

// ---------------------------------------------------------- modal keyboard

function onPreviewKeydown(e) {
  if (!preview.open) return;
  const active = document.activeElement;
  const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

  if (e.key === 'Tab') { trapFocus(e); return; }

  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    const it = state.items.get(preview.itemId);
    if (preview.reason) { preview.reason = null; renderActions(it); return; }
    if (preview.editing) { preview.editing = false; preview.captionValue = null; renderTabPanels(it); renderActions(it); return; }
    closePreview();
    return;
  }

  if (inField) return; // let the note / caption / confirm inputs type freely

  switch (e.key) {
    case 'ArrowLeft': previewArrow(-1); break;
    case 'ArrowRight': previewArrow(1); break;
    case 'a': modalApprove(); break;
    case 'e': modalEditApprove(); break;
    case 'c': modalOpenReason('changes_requested'); break;
    case 'r': modalOpenReason('rejected'); break;
    case 'p': case 'j': case 'k': case 'n': case '?': break; // swallow queue shortcuts
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function trapFocus(e) {
  const modal = preview.els.modal;
  const list = [...modal.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
  wirePreview();
  wireGlobalKeyboard();
  renderSkeleton();
  await reload();
}

init();
