#!/usr/bin/env node
// Autopilot local review station (M0/M1, tickets AP-501 + AP-812).
//
// Usage:
//   node review/server.mjs [--outbox <path>] [--store file|postgres]
//                          [--db-url <dsn>] [--config <file>] [--port <n>]
//
// Localhost-only static+API server. It reads config via loadConfig() (so it
// honours store=postgres + dbUrl + FOREVERMORE_ROOT), and CLI flags override
// config. In postgres mode the items/decisions live in Autopilot's control-
// plane DB while assets are still streamed from the on-disk outbox.
//
// `--outbox <path>` forces PURE FILE MODE rooted at that outbox (its sibling
// decisions/ + settings.json), for reviewing a fixture or a temp tree without
// touching the real data root — matching the original AP-501 behaviour.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { createStore } from '../src/store/index.mjs';
import { createReviewServer } from './lib/app.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DEFAULT_PORT = 4600;

function parseArgs(argv) {
  const args = { outbox: null, store: null, dbUrl: null, config: null, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--outbox') args.outbox = argv[++i];
    else if (argv[i] === '--store') args.store = argv[++i];
    else if (argv[i] === '--db-url') args.dbUrl = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Autopilot local review station

Usage:
  node review/server.mjs [--outbox <path>] [--store file|postgres] [--db-url <dsn>] [--config <file>] [--port <n>]

Options:
  --outbox <path>   Force pure file mode rooted at this outbox (default: config data root)
  --store <mode>    Override config store: file | postgres
  --db-url <dsn>    Override the postgres DSN (store=postgres)
  --config <file>   autopilot.config.json to load
  --port <n>        Port to listen on (default: ${DEFAULT_PORT})
  --help, -h        Show this help

Try it against the committed fixture (pure file mode):

  node review/server.mjs --outbox fixtures/outbox-sample`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!Number.isInteger(args.port) || args.port <= 0) {
  console.error(`invalid --port: ${args.port}`);
  process.exit(1);
}

// Base config, then apply CLI overrides (flags win).
const config = loadConfig({ configPath: args.config || undefined });
if (args.store) config.store = args.store;
if (args.dbUrl) {
  config.dbUrl = args.dbUrl;
  config.resolved.dbUrl = args.dbUrl;
}

// `--outbox` forces file mode rooted at the given outbox (its sibling
// decisions/ + settings.json), overriding whatever the config said.
if (args.outbox) {
  const outboxDir = resolve(args.outbox);
  const dataRoot = dirname(outboxDir);
  config.store = 'file';
  config.resolved.outbox = outboxDir;
  config.resolved.decisions = join(dataRoot, 'decisions');
  config.resolved.runs = join(dataRoot, 'runs');
  config.resolved.logs = join(dataRoot, 'logs');
  config.resolved.state = join(dataRoot, 'state');
  config.resolved.settings = join(dataRoot, 'settings.json');
}

const store = createStore(config);
const outboxDir = config.resolved.outbox;
const settingsPath = config.resolved.settings;

const server = createReviewServer({ store, outboxDir, settingsPath, publicDir: PUBLIC_DIR });

server.listen(args.port, '127.0.0.1', () => {
  console.log(`autopilot review station -> http://127.0.0.1:${args.port}`);
  console.log(`  store:     ${config.store}`);
  console.log(`  outbox:    ${outboxDir}`);
  console.log(`  settings:  ${settingsPath}`);
  console.log('  (localhost only -- Ctrl+C to stop)');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${args.port} is already in use -- try --port <n>`);
  } else {
    console.error('server error:', err);
  }
  process.exit(1);
});

async function shutdown() {
  server.close();
  await store.close?.();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
