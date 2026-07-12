/**
 * @file Tiny zero-dependency argv parser for the autopilot CLI.
 * Supports `--flag`, `--key value`, and `--key=value`; everything else is a
 * positional. A small known-boolean set avoids swallowing the next token.
 */

const BOOLEAN_FLAGS = new Set(['dry-run', 'force', 'live', 'json', 'help']);

/**
 * @param {string[]} argv  Args after `node autopilot` (i.e. process.argv.slice(2)).
 * @returns {{_:string[], flags:Object<string,string|boolean>}}
 */
export function parseArgs(argv) {
  const _ = [];
  /** @type {Object<string,string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      _.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

/** camelCase accessor: getFlag(flags,'dry-run') → flags['dry-run']. */
export function getFlag(flags, name, dflt) {
  return name in flags ? flags[name] : dflt;
}
