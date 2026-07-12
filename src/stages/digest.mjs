/**
 * @file `digest` stage (v0). Writes a static, self-contained HTML summary of a
 * slot day's candidates to `digest/<date>.html` — candidate groups, per-item
 * status, hook/caption, and an inline media preview. No email (that is AP-503).
 * A pure projection of current state, so it is always safe to regenerate
 * (`--force` re-renders after the completion marker is set).
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { isoDatePart } from '../util/time.mjs';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Media preview `<img>`/`<video>` relative to the digest dir. */
function preview(item) {
  const a = (item.assets || [])[0];
  if (!a) return '<div class="ph">no asset yet</div>';
  const rel = `../outbox/${item.id}/${a.path}`;
  if (/\.(mp4|webm|mov)$/i.test(a.path)) {
    return `<video src="${esc(rel)}" controls preload="metadata" muted></video>`;
  }
  return `<img src="${esc(rel)}" alt="${esc(item.id)}" loading="lazy" />`;
}

/** Build the digest HTML for a set of items on `date`. */
export function renderDigestHtml(date, items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.candidate_group || it.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const groupBlocks = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cg, list]) => {
      const platform = list[0]?.platform || '';
      const slot = list[0]?.slot_at || '';
      const cards = list
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(
          (it) => `
        <article class="card">
          <div class="media">${preview(it)}</div>
          <div class="meta">
            <span class="badge s-${esc(it.status)}">${esc(it.status)}</span>
            <span class="tag">${esc(it.format)}</span>
            ${it.idea_id ? `<span class="tag">${esc(it.idea_id)}</span>` : ''}
            ${it.chosen ? '<span class="tag chosen">chosen</span>' : ''}
          </div>
          <p class="hook">${esc(it.overlays?.hook || '')}</p>
          <p class="caption">${esc(it.caption || '')}</p>
          <code class="id">${esc(it.id)}</code>
        </article>`,
        )
        .join('');
      return `
      <section class="group">
        <h2>${esc(platform)} · <span class="slot">${esc(slot)}</span> <span class="cg">${esc(cg)}</span></h2>
        <div class="cards">${cards}</div>
      </section>`;
    })
    .join('');

  const empty = groups.size === 0 ? '<p class="empty">No candidates for this date yet.</p>' : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Autopilot digest — ${esc(date)}</title>
<style>
  :root { --paper:#f4f4f0; --ink:#111; --pink:#ff90e8; --yellow:#ffc900; --green:#23a094; --peri:#90a8ed; --red:#dc341e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:32px; }
  header { display:flex; align-items:baseline; gap:16px; margin-bottom:24px; }
  h1 { font-size:28px; margin:0; letter-spacing:-0.02em; }
  .sub { color:#555; }
  .group { margin:0 0 40px; }
  .group h2 { font-size:16px; text-transform:lowercase; letter-spacing:0.02em; border-bottom:2px solid var(--ink); padding-bottom:6px; }
  .slot { color:#555; font-weight:400; }
  .cg { color:#999; font-weight:400; font-size:12px; float:right; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; margin-top:16px; }
  .card { background:#fff; border:2px solid var(--ink); border-radius:12px; overflow:hidden; box-shadow:6px 6px 0 var(--ink); }
  .media { aspect-ratio:9/16; background:#eee; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .media img, .media video { width:100%; height:100%; object-fit:cover; }
  .ph { color:#999; font-size:13px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; padding:10px 12px 0; }
  .badge, .tag { font-size:11px; padding:2px 8px; border-radius:999px; border:1.5px solid var(--ink); }
  .tag { background:#fff; }
  .tag.chosen { background:var(--green); color:#fff; }
  .badge { background:var(--yellow); font-weight:600; }
  .s-pending_review { background:var(--peri); }
  .s-approved { background:var(--green); color:#fff; }
  .s-skipped, .s-qa_failed, .s-publish_failed { background:var(--red); color:#fff; }
  .s-published { background:var(--green); color:#fff; }
  .hook { font-weight:600; padding:8px 12px 0; margin:0; }
  .caption { color:#333; font-size:13px; padding:6px 12px; margin:0; white-space:pre-wrap; }
  .id { display:block; padding:0 12px 10px; color:#999; font-size:11px; }
  .empty { color:#777; }
</style></head>
<body>
  <header>
    <h1>Autopilot digest</h1>
    <span class="sub">${esc(date)} · ${groups.size} slot group(s) · ${items.length} candidate(s)</span>
  </header>
  ${empty}
  ${groupBlocks}
</body></html>
`;
}

/** @param {Object} ctx */
export async function digestStage(ctx) {
  const { config, store, date, dryRun, log } = ctx;
  const items = (await store.listItems()).filter((i) => isoDatePart(i.slot_at) === date);
  const html = renderDigestHtml(date, items);

  if (dryRun) {
    await log({ event: 'digest.dry_run', date, items: items.length });
    return { produced: 0, items: items.length };
  }

  await fsp.mkdir(config.resolved.digest, { recursive: true });
  const out = join(config.resolved.digest, `${date}.html`);
  await fsp.writeFile(out, html, 'utf8');
  await log({ event: 'digest.written', path: out, items: items.length });
  return { produced: items.length, path: out };
}
