/**
 * @file CLI command implementations. Each returns a process exit code.
 * Output is plain text (developer escape hatch, PRD §10.3); `--json` dumps
 * machine-readable results where useful.
 */

import { promises as fsp, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.mjs';
import { createStore } from '../store/index.mjs';
import { runStage, STAGE_NAMES, isPaused } from '../stages/registry.mjs';
import { transitionItem, regenNext } from '../state/machine.mjs';
import { loadIdeas } from '../plan/ideas.mjs';
import { remotionBin } from '../adapters/proc.mjs';
import { localToday } from '../util/time.mjs';

/** Stores opened this process — closed together by the CLI entrypoint so a
 *  postgres pool doesn't keep the process alive after a command finishes. */
const OPEN_STORES = [];

/** Load config + store once per command. */
function boot(flags) {
  const config = loadConfig({ configPath: flags.config });
  const store = createStore(config);
  OPEN_STORES.push(store);
  return { config, store };
}

/** Close every store opened during this CLI invocation (called from bin). */
export async function closeStores() {
  for (const store of OPEN_STORES.splice(0)) {
    try {
      await store.close?.();
    } catch {
      /* best-effort shutdown */
    }
  }
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  return 1;
}

/* --------------------------------- run --------------------------------- */
export async function cmdRun(argv, flags) {
  const stage = argv[0];
  if (!stage) return fail(`run: which stage? (${STAGE_NAMES.join('|')})`);
  if (!STAGE_NAMES.includes(stage)) return fail(`run: unknown stage "${stage}" (${STAGE_NAMES.join('|')})`);
  const { config, store } = boot(flags);
  const date = flags.date || localToday();
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);

  const res = await runStage(stage, { config, store, date, dryRun, force, driver: flags.driver });

  if (res.status === 'paused') {
    console.log(`⏸  paused (kill switch engaged) — ${stage} did nothing for ${date}`);
    return 0;
  }
  if (res.status === 'skipped') {
    console.log(`↷ ${stage} already completed for ${date} (run ${res.completed?.run}); use --force to re-run`);
    return 0;
  }

  if (stage === 'plan' && dryRun) {
    printPlan(res.planned);
    console.log(`\n(dry run) ${res.planned.length} planned shell(s) for the week after ${date} — nothing written`);
    return 0;
  }

  if (flags.json) console.log(JSON.stringify(res, null, 2));
  else console.log(`✓ ${stage} (${date}) — produced ${res.produced}${res.skipped ? `, skipped ${res.skipped}` : ''}`);
  return 0;
}

function printPlan(shells) {
  const byDay = new Map();
  for (const s of shells) {
    const d = s.slot_at.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  for (const [day, list] of [...byDay.entries()].sort()) {
    console.log(`\n${day}`);
    for (const s of list.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(
        `  ${s.platform.padEnd(9)} ${String(s.format).padEnd(12)} ${String(s.idea_id).padEnd(5)} ` +
          `${s.candidate_group}  ${s.id}`,
      );
    }
  }
}

/* --------------------------------- tick --------------------------------- */

/** A tick lock older than this is considered abandoned and broken. */
const TICK_LOCK_STALE_MS = 45 * 60 * 1000;

/**
 * The employee's heartbeat (AP-836) — see src/stages/tick.mjs for the sweep
 * itself. This wrapper adds the process concerns: a pid lockfile under state/
 * so overlapping ticks (launchd + a manual run) never double-spawn the brain
 * (locks older than 45 minutes are treated as crashed and broken).
 */
export async function cmdTick(argv, flags) {
  const { runTickSweep } = await import('../stages/tick.mjs');
  const { config, store } = boot(flags);
  const today = flags.date || localToday();

  const lockPath = join(config.resolved.state, 'tick.lock');
  if (!(await acquireTickLock(lockPath))) {
    console.log('↷ another tick is already running — nothing to do');
    return 0;
  }

  let result;
  try {
    result = await runTickSweep({
      config,
      store,
      today,
      dryRun: Boolean(flags['dry-run']),
      driver: flags.driver,
      print: (line) => console.log(line),
    });
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }

  const { passes, failures, paused } = result;
  if (paused) console.log('⏸  tick — kill switch engaged');
  else if (!passes.length && !failures.length) console.log('✓ tick — queue empty, nothing owed');
  else console.log(`✓ tick — ${passes.length} stage pass(es)${failures.length ? `, ${failures.length} FAILED` : ''}`);
  return failures.length ? 1 : 0;
}

/** O_EXCL pid lock with stale-break. True when acquired. */
async function acquireTickLock(lockPath) {
  await fsp.mkdir(join(lockPath, '..'), { recursive: true }).catch(() => {});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const rec = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
        stale = !rec.at || Date.now() - new Date(rec.at).getTime() > TICK_LOCK_STALE_MS;
      } catch {
        stale = true; // unreadable lock → treat as crashed
      }
      if (!stale) return false;
      await fsp.rm(lockPath, { force: true }).catch(() => {});
    }
  }
  return false;
}

/* --------------------------------- ls ---------------------------------- */
export async function cmdLs(argv, flags) {
  const { store } = boot(flags);
  const status = argv[0];
  const items = status ? await store.listByStatus(status) : await store.listItems();
  if (!items.length) {
    console.log(status ? `no items with status "${status}"` : 'no items');
    return 0;
  }
  if (flags.json) {
    console.log(JSON.stringify(items, null, 2));
    return 0;
  }
  console.log(`${'ID'.padEnd(22)} ${'STATUS'.padEnd(16)} ${'PLAT'.padEnd(9)} ${'FORMAT'.padEnd(12)} ${'IDEA'.padEnd(5)} SLOT_AT`);
  for (const i of items) {
    console.log(
      `${i.id.padEnd(22)} ${String(i.status).padEnd(16)} ${String(i.platform).padEnd(9)} ` +
        `${String(i.format).padEnd(12)} ${String(i.idea_id).padEnd(5)} ${i.slot_at}`,
    );
  }
  console.log(`\n${items.length} item(s)`);
  return 0;
}

/* -------------------------------- show --------------------------------- */
export async function cmdShow(argv, flags) {
  const { store } = boot(flags);
  const id = argv[0];
  if (!id) return fail('show: need an item id');
  const item = await store.getItem(id);
  if (!item) return fail(`no such item ${id}`);
  console.log(JSON.stringify(item, null, 2));
  const approvals = await store.listApprovals(id);
  if (approvals.length) {
    console.log('\n— decisions —');
    for (const a of approvals) {
      console.log(`  ${a.decided_at}  ${a.decision}  ${(a.reason_tags || []).join(',')}  ${a.note || ''}`);
    }
  }
  return 0;
}

/* ------------------------- approve / reject / regen -------------------- */
export async function cmdApprove(argv, flags) {
  const { store } = boot(flags);
  const id = argv[0];
  if (!id) return fail('approve: need an item id');
  const item = await store.getItem(id);
  if (!item) return fail(`no such item ${id}`);
  if (item.status !== 'pending_review') return fail(`item ${id} is "${item.status}", expected pending_review`);
  await store.appendApproval({ content_item_id: id, decision: 'approved', via: 'cli', note: flags.note });
  await transitionItem(store, { item, to: 'approved', stage: 'approve', patch: { chosen: true } });
  console.log(`✓ approved ${id}`);
  return 0;
}

export async function cmdReject(argv, flags) {
  const { store } = boot(flags);
  const id = argv[0];
  if (!id) return fail('reject: need an item id');
  if (!flags.reason) return fail('reject: --reason <tag> is required (e.g. hook-weak|off-voice|duplicate)');
  const item = await store.getItem(id);
  if (!item) return fail(`no such item ${id}`);
  if (item.status !== 'pending_review') return fail(`item ${id} is "${item.status}", expected pending_review`);
  await store.appendApproval({
    content_item_id: id,
    decision: 'rejected',
    reason_tags: [flags.reason],
    via: 'cli',
    note: flags.note,
  });
  await transitionItem(store, { item, to: 'skipped', stage: 'reject', patch: { skip_reason: `rejected:${flags.reason}` } });
  console.log(`✓ rejected ${id} (${flags.reason})`);
  return 0;
}

export async function cmdRegen(argv, flags) {
  const { config, store } = boot(flags);
  const id = argv[0];
  if (!id) return fail('regen: need an item id');
  const item = await store.getItem(id);
  if (!item) return fail(`no such item ${id}`);
  if (item.status !== 'pending_review') return fail(`item ${id} is "${item.status}", expected pending_review`);
  await store.appendApproval({
    content_item_id: id,
    decision: 'edited',
    reason_tags: ['regen'],
    via: 'cli',
    note: flags.note,
  });
  let cur = await transitionItem(store, {
    item,
    to: 'changes_requested',
    stage: 'regen',
    patch: { regen_note: flags.note || null },
  });
  const next = regenNext(cur, config.retry.regen_max);
  cur = await transitionItem(store, { item: cur, to: next.to, stage: 'regen', patch: next.patch });
  if (next.to === 'drafting') {
    const slot = cur.slot_at.slice(0, 10);
    console.log(`↺ ${id} sent back for regeneration (attempt ${cur.attempt}). Run: autopilot run generate --date ${slot} --force`);
  } else {
    console.log(`✗ ${id} hit the regen limit (${config.retry.regen_max}) — skipped`);
  }
  return 0;
}

/* ----------------------------- pause / resume -------------------------- */
export async function cmdPause(argv, flags) {
  const { store } = boot(flags);
  await store.setSetting('kill_switch', true);
  console.log('⏸  kill switch ENGAGED — all stages will no-op until `autopilot resume`');
  return 0;
}

export async function cmdResume(argv, flags) {
  const { store } = boot(flags);
  await store.setSetting('kill_switch', false);
  console.log('▶  kill switch released — stages will run again');
  return 0;
}

/* --------------------------------- bot ---------------------------------- */
/**
 * Run the Discord control-channel daemon (WAVE2 Phase 1; pivoted from
 * Telegram). Gateway + scan loop, own lockfile. Gated on
 * config.discord.enabled (DISCORD_ENABLED) so a misconfigured env refuses
 * politely instead of hammering the API.
 */
export async function cmdBot(argv, flags) {
  const { config, store } = boot(flags);
  const dc = config.discord || {};
  if (!dc.enabled) return fail('discord is disabled — set DISCORD_ENABLED=true (and DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID / DISCORD_OWNER_ID)');
  if (!dc.botToken) return fail('DISCORD_BOT_TOKEN is required');
  if (!dc.channelId) return fail('DISCORD_CHANNEL_ID is required');
  if (!dc.ownerId) return fail('DISCORD_OWNER_ID is required');

  const { runBot } = await import('../discord/bot.mjs');
  const stationUrl = flags['station-url'] || process.env.AUTOPILOT_STATION_URL || null;
  console.log(`📡 discord daemon starting (channel ${dc.channelId}) — scan every ${dc.scanIntervalSec}s`);
  await runBot({ config, store, stationUrl, closeStore: false, onError: (e) => console.error(`discord: ${e.message}`) });
  return 0;
}

/* ----------------------------- import-outbox --------------------------- */
/**
 * One-time migration of a file-mode outbox into the DB-backed store: upsert
 * every outbox/<id>/item.json (ensuring its idea_id FK target exists first),
 * then replay decisions/*.json as approvals rows. Idempotent across re-runs —
 * items upsert on their (derived) key and an approval is skipped when one with
 * the same content_item + decided_at already exists.
 */
/**
 * Importer core — reusable + testable, decoupled from the CLI/console. Upserts
 * items (ensuring idea FKs first) and replays decision files idempotently.
 * @param {import('../store/index.mjs').PostgresStore} store DB-backed store (needs ensureIdea)
 * @param {{outboxDir:string, decisionsDir:string, ideasPath?:string, onError?:(msg:string)=>void}} opts
 * @returns {Promise<{ideas:number, items:number, itemErrors:number, decisionFiles:number, approvals:number, approvalsSkipped:number}>}
 */
export async function importOutbox(store, { outboxDir, decisionsDir, ideasPath, onError } = {}) {
  if (typeof store.ensureIdea !== 'function') {
    throw new Error('importOutbox needs a DB-backed store (ensureIdea) — use store=postgres');
  }
  const warn = onError || (() => {});

  // Platform ideas.json supplies the FK payloads; minimal {} fallback if absent.
  const ideaById = new Map();
  if (ideasPath) {
    try {
      for (const idea of loadIdeas(ideasPath)) {
        if (idea && idea.id) ideaById.set(idea.id, idea);
      }
    } catch (e) {
      warn(`ideas.json not read (${e.message}); importing with minimal {} idea payloads`);
    }
  }

  const s = { ideas: 0, items: 0, itemErrors: 0, decisionFiles: 0, approvals: 0, approvalsSkipped: 0 };

  // 1. items (+ idea FKs)
  let entries;
  try {
    entries = await fsp.readdir(outboxDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') entries = [];
    else throw e;
  }
  const ensuredIdeas = new Set();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    let item;
    try {
      item = JSON.parse(await fsp.readFile(join(outboxDir, ent.name, 'item.json'), 'utf8'));
    } catch {
      continue; // dir without a readable item.json — not an item
    }
    try {
      if (item.idea_id && !ensuredIdeas.has(item.idea_id)) {
        await store.ensureIdea(item.idea_id, ideaById.get(item.idea_id) || {});
        ensuredIdeas.add(item.idea_id);
        s.ideas++;
      }
      await store.putItem(item);
      s.items++;
    } catch (e) {
      s.itemErrors++;
      warn(`${ent.name}: ${e.message}`);
    }
  }

  // 2. decisions replay (idempotent on content_item_id + decided_at)
  let files;
  try {
    files = (await fsp.readdir(decisionsDir)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    if (e.code === 'ENOENT') files = [];
    else throw e;
  }
  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(await fsp.readFile(join(decisionsDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!rec.content_item_id || !rec.decision) continue;
    s.decisionFiles++;
    const target = rec.decided_at ? new Date(rec.decided_at).getTime() : null;
    const existing = await store.listApprovals(rec.content_item_id);
    const dup = existing.some((a) => a.decided_at && new Date(a.decided_at).getTime() === target);
    if (dup) {
      s.approvalsSkipped++;
      continue;
    }
    try {
      await store.appendApproval({
        content_item_id: rec.content_item_id,
        decision: rec.decision,
        reason_tags: rec.reason_tags ?? null,
        note: rec.note ?? null,
        caption_diff: rec.caption_diff ?? null,
        via: rec.via ?? 'cli',
        decided_at: rec.decided_at,
      });
      s.approvals++;
    } catch (e) {
      warn(`approval ${f}: ${e.message}`);
    }
  }
  return s;
}

export async function cmdImportOutbox(argv, flags) {
  const { config, store } = boot(flags);
  if (typeof store.ensureIdea !== 'function') {
    return fail(
      'import-outbox needs a DB-backed store — set "store":"postgres" (or --store postgres / AUTOPILOT_STORE=postgres)',
    );
  }
  const s = await importOutbox(store, {
    outboxDir: config.resolved.outbox,
    decisionsDir: config.resolved.decisions,
    ideasPath: config.resolved.ideas,
    onError: (msg) => console.log(`  ✗ ${msg}`),
  });

  if (flags.json) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log('import-outbox summary');
    console.log(`  ${'ideas ensured'.padEnd(20)} ${s.ideas}`);
    console.log(`  ${'items upserted'.padEnd(20)} ${s.items}`);
    if (s.itemErrors) console.log(`  ${'item errors'.padEnd(20)} ${s.itemErrors}`);
    console.log(`  ${'decision files'.padEnd(20)} ${s.decisionFiles}`);
    console.log(`  ${'approvals inserted'.padEnd(20)} ${s.approvals}`);
    console.log(`  ${'approvals skipped'.padEnd(20)} ${s.approvalsSkipped}`);
  }
  return s.itemErrors ? 1 : 0;
}

/* -------------------------------- doctor ------------------------------- */
function onPath(bin) {
  return (process.env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

export async function cmdDoctor(argv, flags) {
  const { config, store } = boot(flags);
  const checks = [];
  const add = (name, ok, level, detail) => checks.push({ name, ok, level, detail });

  // tools (warn-level — pipeline still plans/generates without them)
  add('Brave binary', existsSync(config.brave), 'warn', config.brave);
  const rbin = remotionBin(config);
  add('Remotion bin', existsSync(rbin), 'warn', rbin);
  add('claude CLI on PATH', onPath('claude'), 'warn', 'needed for --driver claude-cli (AP-301)');

  // ideas.json parses (critical)
  try {
    const ideas = loadIdeas(config.resolved.ideas);
    add('ideas.json parses', true, 'critical', `${ideas.length} ideas @ ${config.resolved.ideas}`);
  } catch (e) {
    add('ideas.json parses', false, 'critical', e.message);
  }

  // outbox writable (critical)
  let writable = false;
  let wdetail = config.resolved.outbox;
  try {
    await fsp.mkdir(config.resolved.outbox, { recursive: true });
    const probe = join(config.resolved.outbox, `.doctor-${process.pid}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    writable = true;
  } catch (e) {
    wdetail = e.message;
  }
  add('outbox writable', writable, 'critical', wdetail);

  // postgres store health (critical when store=postgres/supabase)
  const isPg = config.store === 'postgres' || config.store === 'supabase';
  if (isPg) {
    add('db url configured', Boolean(config.resolved.dbUrl), 'critical', config.resolved.dbUrl ? '(set)' : 'AUTOPILOT_DB_URL unset');
    let connected = false;
    let schemaOk = false;
    let detail = '';
    try {
      await store.getSettings(); // reaches autopilot.settings → proves connect + schema
      connected = true;
      schemaOk = true;
    } catch (e) {
      detail = e.message;
    }
    add('postgres reachable', connected, 'critical', connected ? 'connected' : detail);
    add('autopilot schema present', schemaOk, 'critical', schemaOk ? 'autopilot.settings readable' : detail);
    // migration file hash (info — provenance note, not a live check)
    const migPath = join(config.resolved.pkgRoot, 'db', 'migrations', '0001_autopilot_schema.sql');
    if (existsSync(migPath)) {
      try {
        const h = createHash('sha256').update(await fsp.readFile(migPath)).digest('hex').slice(0, 12);
        add('migration file', true, 'info', `0001 sha256:${h}`);
      } catch { /* unreadable → skip the note */ }
    }
  }

  // kill switch state (info)
  let paused = false;
  try {
    paused = await isPaused(store, config);
  } catch { /* settings unreadable → treated below */ }
  add('kill switch', !paused, 'info', paused ? 'ENGAGED (paused)' : 'released');

  // config summary (info)
  add('store', true, 'info', config.store);
  add('timezone', true, 'info', config.timezone);
  add('brain driver', true, 'info', config.brainDriver);

  // render
  const symbol = (c) => (c.ok ? '✓' : c.level === 'info' ? 'ℹ' : c.level === 'critical' ? '✗' : '⚠');
  console.log('autopilot doctor\n');
  for (const c of checks) {
    console.log(`  ${symbol(c)}  ${c.name.padEnd(22)} ${c.detail || ''}`);
  }
  const criticalFail = checks.some((c) => c.level === 'critical' && !c.ok);
  const warnFail = checks.some((c) => c.level === 'warn' && !c.ok);
  console.log('');
  if (criticalFail) {
    console.log('✗ critical checks failed — fix before running the pipeline');
    return 1;
  }
  console.log(warnFail ? '⚠ ready (some optional tools missing — see warnings)' : '✓ all green');
  return 0;
}

/* -------------------------------- review ------------------------------- */
export async function cmdReview(argv, flags) {
  const { store } = boot(flags);
  const pending = await store.listByStatus('pending_review');
  console.log('The local review station is ticket AP-501 (not part of this build).');
  console.log('For now, review from the CLI:\n');
  console.log('  autopilot ls pending_review');
  console.log('  autopilot show <id>');
  console.log('  autopilot approve <id> [--note "…"]');
  console.log('  autopilot reject  <id> --reason hook-weak [--note "…"]');
  console.log('  autopilot regen   <id> [--note "make the hook harsher"]');
  console.log(`\n${pending.length} item(s) currently pending_review.`);
  return 0;
}
