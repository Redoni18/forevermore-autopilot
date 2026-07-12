#!/usr/bin/env node
// Autopilot local review station (M0, ticket AP-501).
//
// Usage: node autopilot/review/server.mjs [--outbox path] [--port 4600]
//
// Localhost-only static+API server over a file-mode outbox (PRD §5). Default
// outbox/decisions/settings resolve relative to this file's own location, so
// a fresh checkout just works — matching AUTOPILOT_OUTBOX_DIR=outbox in
// autopilot/.env.example. Point --outbox elsewhere (e.g. the committed
// fixture, or a temp dir) to review a different file-mode tree; decisions/
// and settings.json are always resolved as siblings of whichever outbox
// directory is in use, so pointing at a fixture never touches the real tree.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReviewServer } from './lib/app.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DEFAULT_PORT = 4600;

function parseArgs(argv) {
  const args = { outbox: null, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--outbox') args.outbox = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Autopilot local review station (M0)

Usage:
  node autopilot/review/server.mjs [--outbox <path>] [--port <n>]

Options:
  --outbox <path>   Outbox root to review (default: autopilot/outbox next to this file)
  --port <n>        Port to listen on (default: ${DEFAULT_PORT})
  --help, -h        Show this help

Reads <root>/<item-id>/item.json files from the outbox, writes decisions to a
sibling decisions/ directory, and shows a sibling settings.json's kill-switch
state read-only, if present. Try it against the committed fixture:

  node autopilot/review/server.mjs --outbox autopilot/fixtures/outbox-sample`);
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

const outboxDir = resolve(args.outbox ? args.outbox : join(HERE, '..', 'outbox'));
const dataRoot = dirname(outboxDir); // decisions/ + settings.json live next to whichever outbox is in use
const decisionsDir = join(dataRoot, 'decisions');
const settingsPath = join(dataRoot, 'settings.json');

const server = createReviewServer({ outboxDir, decisionsDir, settingsPath, publicDir: PUBLIC_DIR });

server.listen(args.port, '127.0.0.1', () => {
  console.log(`autopilot review station -> http://127.0.0.1:${args.port}`);
  console.log(`  outbox:    ${outboxDir}`);
  console.log(`  decisions: ${decisionsDir}`);
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
