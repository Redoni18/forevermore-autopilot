#!/usr/bin/env node
/**
 * @file autopilot CLI entry (ticket AP-201). Zero deps; Node 22 ESM.
 *
 *   autopilot run <stage> [--date YYYY-MM-DD] [--dry-run] [--driver fixture] [--force]
 *   autopilot ls [status]
 *   autopilot show <id>
 *   autopilot approve <id> [--note "…"]
 *   autopilot reject <id> --reason <tag> [--note "…"]
 *   autopilot regen <id> [--note "…"]
 *   autopilot pause | resume
 *   autopilot doctor
 *   autopilot review
 *
 * Stages: plan | generate | render | qa | digest.
 */

import { parseArgs } from '../src/cli/args.mjs';
import {
  cmdRun,
  cmdTick,
  cmdLs,
  cmdShow,
  cmdApprove,
  cmdReject,
  cmdRegen,
  cmdPause,
  cmdResume,
  cmdDoctor,
  cmdReview,
  cmdImportOutbox,
  closeStores,
} from '../src/cli/commands.mjs';

const USAGE = `autopilot — Forevermore Autopilot pipeline (M0)

usage:
  autopilot run <stage> [--date YYYY-MM-DD] [--dry-run] [--driver fixture] [--force]
  autopilot tick [--dry-run] [--driver fixture]
  autopilot ls [status]
  autopilot show <id>
  autopilot approve <id> [--note "…"]
  autopilot reject <id> --reason <tag> [--note "…"]
  autopilot regen <id> [--note "…"]
  autopilot pause | resume
  autopilot doctor
  autopilot review
  autopilot import-outbox

stages:   plan | generate | render | qa | digest
notes:    --date defaults to today; generate/render/qa/digest act on that slot
          date, plan plans the 7 days after it. A completed (stage,date) is a
          no-op unless --force. The kill switch (pause) halts every stage.
          tick = the employee's heartbeat: plan today, then sweep EVERY date
          carrying in-flight work (drafting→generate, drafted→render,
          rendered→qa), then digest — so station change requests come back as
          redrafts without running stages by hand (launchd runs it every 30m).
          import-outbox migrates a file-mode outbox into store=postgres.`;

/** @type {Record<string, (argv:string[], flags:Object)=>Promise<number>|number>} */
const COMMANDS = {
  run: cmdRun,
  tick: cmdTick,
  ls: cmdLs,
  show: cmdShow,
  approve: cmdApprove,
  reject: cmdReject,
  regen: cmdRegen,
  pause: cmdPause,
  resume: cmdResume,
  doctor: cmdDoctor,
  review: cmdReview,
  'import-outbox': cmdImportOutbox,
};

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const command = _[0];
  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`unknown command "${command}"\n`);
    console.log(USAGE);
    return 1;
  }
  return handler(_.slice(1), flags);
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((err) => {
    console.error(`✗ ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Release any DB pool so a postgres-backed command exits cleanly.
    await closeStores();
  });
