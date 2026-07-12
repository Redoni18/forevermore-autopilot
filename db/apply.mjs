#!/usr/bin/env node
// db/apply.mjs — applies db/migrations/*.sql to Autopilot's own Postgres.
//
// Zero-dependency (Node 22 built-ins only). Runs every migration through
// `psql` INSIDE the running Docker container via `docker exec -i` — no local
// psql install required. See docs/ADR-001-standalone.md: this must never be
// pointed at the Forevermore platform's database.
//
// Usage:
//   node db/apply.mjs                     apply pending migrations
//   node db/apply.mjs --fresh             drop schemas + re-apply everything (prompts unless --yes)
//   node db/apply.mjs --fresh --yes       same, no prompt
//   node db/apply.mjs --container=NAME    target a specific container (default: autopilot-local-db)
//   node db/apply.mjs --url=postgres://…  informational only — printed, doesn't change how we connect
//                                          (we always go through `docker exec` into the container; the
//                                          store layer is what actually reads AUTOPILOT_DB_URL)
//
// Migration tracking: autopilot_private.schema_migrations(filename, applied_at),
// bootstrapped by this script before the first migration runs (chicken-and-egg:
// migration 0001 is what creates autopilot_private in the first place).

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline/promises';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const DEFAULT_CONTAINER = 'autopilot-local-db';
const PG_USER = 'postgres';
const PG_DB = 'autopilot';

function parseArgs(argv) {
  const args = { fresh: false, yes: false, container: null, url: null, help: false };
  for (const raw of argv) {
    if (raw === '--fresh') args.fresh = true;
    else if (raw === '--yes' || raw === '-y') args.yes = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--container=')) args.container = raw.slice('--container='.length);
    else if (raw.startsWith('--url=')) args.url = raw.slice('--url='.length);
    else {
      console.error(`✗ unrecognized argument: ${raw}`);
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`db/apply.mjs — apply Autopilot's Postgres migrations

  node db/apply.mjs                     apply pending migrations
  node db/apply.mjs --fresh             drop schemas + re-apply everything (prompts unless --yes)
  node db/apply.mjs --fresh --yes       same, no confirmation prompt
  node db/apply.mjs --container=NAME    target a specific container (default: ${DEFAULT_CONTAINER})
  node db/apply.mjs --url=...           informational only, printed for reference

Never point this at the Forevermore platform's database — see docs/ADR-001-standalone.md.
`);
}

// Resolve which container to exec into. Default name first (fast path for
// the common case); if that's not running, fall back to asking `docker
// compose ps -q db` for whatever compose actually named/started it.
function resolveContainer(explicit) {
  if (explicit) {
    if (!isContainerRunning(explicit)) {
      fail(`container "${explicit}" is not running (docker exec would fail). Run \`docker compose up -d\` first.`);
    }
    return explicit;
  }

  if (isContainerRunning(DEFAULT_CONTAINER)) return DEFAULT_CONTAINER;

  const composeId = tryComposeContainerId();
  if (composeId) return composeId;

  fail(
    `no running Postgres container found (checked "${DEFAULT_CONTAINER}" and \`docker compose ps -q db\`).\n` +
      '  Run `docker compose up -d` first, or pass --container=NAME.'
  );
  return undefined; // unreachable, keeps TypeScript-in-JSDoc-style tooling happy
}

function isContainerRunning(name) {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function tryComposeContainerId() {
  const result = spawnSync('docker', ['compose', 'ps', '-q', 'db'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const id = result.stdout.trim();
  if (result.status === 0 && id) return id;
  return null;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// Runs a SQL string through `docker exec -i <container> psql ...`, piped via
// stdin — no -f flag, no file needs to exist inside the container.
// -1/--single-transaction + ON_ERROR_STOP=1 makes each call atomic: any
// error rolls the whole script back, nothing half-applies.
function runSql(container, sql, { label } = {}) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1', '-1', '-q'],
    { input: sql, encoding: 'utf8' }
  );

  if (result.status !== 0) {
    console.error(`✗ ${label ?? 'sql'} failed`);
    if (result.stdout?.trim()) console.error(result.stdout.trim());
    if (result.stderr?.trim()) console.error(result.stderr.trim());
    process.exit(1);
  }

  return result.stdout;
}

// Read-only query (no -1/single-transaction needed) used for the applied-
// migrations check.
function queryColumn(container, sql) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
    { input: sql, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.error('✗ tracking-table query failed');
    if (result.stderr?.trim()) console.error(result.stderr.trim());
    process.exit(1);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function confirmFresh(yes) {
  if (yes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      '⚠ --fresh will DROP SCHEMA autopilot, autopilot_private CASCADE (all data lost). Continue? [y/N] '
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.url) {
    console.log(`ℹ --url is informational only (always applying via docker exec): ${args.url}`);
  }

  const container = resolveContainer(args.container);
  console.log(`ℹ target container: ${container} (db: ${PG_DB})`);

  if (args.fresh) {
    const confirmed = await confirmFresh(args.yes);
    if (!confirmed) {
      console.log('Aborted — no changes made.');
      return;
    }
    console.log('→ dropping schema autopilot, autopilot_private (cascade)...');
    runSql(
      container,
      'drop schema if exists autopilot cascade;\ndrop schema if exists autopilot_private cascade;\n',
      { label: 'fresh drop' }
    );
    console.log('✓ dropped');
  }

  // Bootstrap the tracking table. Safe to run every time (IF NOT EXISTS),
  // and safe before migration 0001 has ever run — that's exactly why it
  // creates autopilot_private itself rather than assuming 0001 already did.
  runSql(
    container,
    [
      "create schema if not exists autopilot_private;",
      "revoke all on schema autopilot_private from public;",
      "create table if not exists autopilot_private.schema_migrations (",
      "  filename text primary key,",
      "  applied_at timestamp with time zone not null default now()",
      ");",
    ].join('\n'),
    { label: 'bootstrap tracking table' }
  );

  const alreadyApplied = new Set(
    queryColumn(container, 'select filename from autopilot_private.schema_migrations order by filename;')
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filename order (0001_, 0002_, …)

  if (files.length === 0) {
    fail(`no .sql files found in ${MIGRATIONS_DIR}`);
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (const filename of files) {
    if (alreadyApplied.has(filename)) {
      console.log(`· ${filename} — already applied, skipping`);
      skippedCount += 1;
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, filename);
    const migrationSql = readFileSync(filePath, 'utf8');
    const trackingInsert = `\ninsert into autopilot_private.schema_migrations (filename) values ('${filename}') on conflict (filename) do nothing;\n`;

    runSql(container, migrationSql + trackingInsert, { label: filename });
    console.log(`✓ ${filename} — applied`);
    appliedCount += 1;
  }

  console.log(`\n${appliedCount} applied, ${skippedCount} already up to date, ${files.length} total.`);
}

main().catch((err) => {
  console.error(`✗ ${err?.stack ?? err}`);
  process.exit(1);
});
