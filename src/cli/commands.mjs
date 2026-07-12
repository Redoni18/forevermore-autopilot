/**
 * @file CLI command implementations. Each returns a process exit code.
 * Output is plain text (developer escape hatch, PRD §10.3); `--json` dumps
 * machine-readable results where useful.
 */

import { promises as fsp, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { loadConfig } from '../config.mjs';
import { createStore } from '../store/index.mjs';
import { runStage, STAGE_NAMES, isPaused } from '../stages/registry.mjs';
import { transitionItem, regenNext } from '../state/machine.mjs';
import { loadIdeas } from '../plan/ideas.mjs';
import { remotionBin } from '../adapters/proc.mjs';
import { localToday } from '../util/time.mjs';

/** Load config + store once per command. */
function boot(flags) {
  const config = loadConfig({ configPath: flags.config });
  const store = createStore(config);
  return { config, store };
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

  // kill switch state (info)
  let paused = false;
  try {
    paused = await isPaused(store, config);
  } catch { /* settings unreadable → treated below */ }
  add('kill switch', !paused, 'info', paused ? 'ENGAGED (paused)' : 'released');

  // config summary (info)
  add('store', config.store === 'file', 'info', config.store);
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
