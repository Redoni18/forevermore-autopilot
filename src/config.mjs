/**
 * @file Config loader. Merges: baked-in defaults ← autopilot.config.json ← env.
 * Resolves every path to an absolute path so stages/adapters never depend on
 * the process CWD. Safe to call repeatedly (cheap; re-reads the file).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMAT_MIX } from './plan/ideas.mjs';

const SELF = fileURLToPath(import.meta.url);
/** Autopilot package root (this file lives at <root>/src/config.mjs). */
export const PKG_ROOT = dirname(dirname(SELF));
/**
 * The Forevermore platform checkout Autopilot CONNECTS TO (render tools,
 * marketing kit, template catalog). Autopilot is a standalone system — this
 * is its one explicit, configurable link to the platform:
 *   env FOREVERMORE_ROOT > config "forevermoreRoot" > sibling ../forevermore
 * (Name kept as REPO_ROOT for existing consumers; it now means "the
 * PLATFORM repo", never Autopilot's own root.)
 */
export const REPO_ROOT =
  process.env.FOREVERMORE_ROOT || join(dirname(PKG_ROOT), 'forevermore');

/** Baked-in defaults — a fully working config even with no file present. */
const DEFAULTS = {
  timezone: 'Europe/Tirane',
  store: 'file',
  /** Postgres connection string for store: 'postgres' (control-plane DB — never
   *  the platform's database, per ADR-001). null → PostgresStore refuses to
   *  boot with a clear error. Overridable via env AUTOPILOT_DB_URL. */
  dbUrl: null,
  brainDriver: 'fixture',
  /** Per-stage model pins (WAVE2 §3.4 — model policy is config, not code).
   *  `stageModels[stage]` is passed as `--model` for that stage's brain calls;
   *  unlisted stages run the CLI default. On a model-unavailable failure the
   *  claude-cli driver retries ONCE on `fallbackModel` and completes the run —
   *  the Telegram scanner alerts on the runs.model mismatch. Never let model
   *  politics stall the pipeline. */
  stageModels: {},
  fallbackModel: null,
  /** Daily brain-spend cap in USD (WAVE2 §3.10), summed from runs.cost_usd for
   *  the local day. Reaching it pauses GENERATION only (render/qa/digest cost
   *  nothing and keep draining) until midnight. Settings key
   *  `daily_spend_cap_usd` overrides at runtime; <=0 disables. */
  daily_spend_cap_usd: 5,
  /** Path (relative to PKG_ROOT or absolute) to the lint engine module (AP-401).
   *  null → built-in no-op lint that passes everything. Real engine exports a
   *  default `(item) => LintResult`. */
  lintModule: null,
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  cadence: {
    instagram_per_day: 1,
    tiktok_per_day: 1,
    candidates_per_slot: 3,
    quiet_days: [], // ISO weekday numbers 1..7 (Mon..Sun) to skip
  },
  planning_horizon_days: 7,
  slot_times: { instagram: '17:30', tiktok: '19:00' },
  /** Per-platform, per-ISO-weekday format pattern (AP-820). The planner reads a
   *  slot's format from here (keyed by platform + weekday 1=Mon..7=Sun) instead
   *  of from the idea, so a week gets planned variety (reels + images +
   *  carousels). Config-file overridable (a platform's whole map is replaced).
   *  'story' is a legal value but NOT a default — stories need manual sticker/
   *  link placement; see DEFAULT_FORMAT_MIX in src/plan/ideas.mjs. */
  format_mix: DEFAULT_FORMAT_MIX,
  retry: {
    qa_max_attempts: 3, // qa_failed → drafting bounces before skip
    regen_max: 2, // changes_requested → drafting bounces before skip
    publish_retries: 3, // publish_failed → publishing retries before alert
    publish_backoff_base_min: 5, // delay = 2^n * base minutes
  },
  paths: {
    root: '.', // data root, relative to PKG_ROOT
    outbox: 'outbox',
    decisions: 'decisions',
    runs: 'runs',
    logs: 'logs',
    digest: 'digest',
    state: 'state',
    library: 'library',
    settings: 'settings.json',
    // Marketing-kit asset locations. Since the §3.12 kit move (2026-07-13,
    // after the marketing/ kit was lost from the platform repo) these live
    // IN THIS repo under kit/ and resolve relative to PKG_ROOT, not the
    // platform checkout. FOREVERMORE_ROOT now only backs the two remaining
    // seams (template thumbnails' upstream + dev-server world captures).
    // (relative to PKG_ROOT unless absolute)
    ideas: 'kit/02-idea-database/ideas.json',
    render: 'kit/04-assets/render.mjs',
    videoStudio: 'kit/05-video-studio',
    posters: 'kit/04-assets/posters',
    catalog: 'kit/_research/template-catalog.md',
    brandGuide: 'kit/00-brand/brand-guide.md',
  },
};

/** @param {string} p @param {string} base */
function abs(p, base) {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Shallow-merge one level deep (objects merged, scalars/arrays replaced). */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Load and resolve config.
 * @param {Object} [opts]
 * @param {string} [opts.configPath] Override config file location.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Object} Resolved config with an absolute `paths` map + `_meta`.
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const configPath = opts.configPath || env.AUTOPILOT_CONFIG || join(PKG_ROOT, 'autopilot.config.json');

  let fileCfg = {};
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`autopilot: failed to parse config ${configPath}: ${e.message}`);
    }
  }

  let cfg = merge(DEFAULTS, fileCfg);
  cfg.paths = merge(DEFAULTS.paths, fileCfg.paths || {});

  // ---- env overrides (highest priority) ----
  if (env.AUTOPILOT_TZ) cfg.timezone = env.AUTOPILOT_TZ;
  if (env.AUTOPILOT_STORE) cfg.store = env.AUTOPILOT_STORE;
  if (env.AUTOPILOT_DB_URL) cfg.dbUrl = env.AUTOPILOT_DB_URL;
  if (env.AUTOPILOT_DRIVER) cfg.brainDriver = env.AUTOPILOT_DRIVER;
  if (env.AUTOPILOT_BRAVE) cfg.brave = env.AUTOPILOT_BRAVE;
  if (env.AUTOPILOT_LINT_MODULE) cfg.lintModule = env.AUTOPILOT_LINT_MODULE;
  if (env.AUTOPILOT_ROOT) cfg.paths.root = env.AUTOPILOT_ROOT;

  // env-forced kill switch (belt-and-braces on top of settings.json)
  const kv = (env.AUTOPILOT_KILL_SWITCH || '').toLowerCase();
  cfg.envKillSwitch = kv === '1' || kv === 'true' || kv === 'yes';

  // Telegram control channel (WAVE2 Phase 1). Secrets/flags live in the
  // process env (launchd/systemd), NOT the committed config file. TELEGRAM_API_BASE
  // is the test/dev seam (point the bot at a fake Bot API on localhost).
  const tgOn = (env.TELEGRAM_ENABLED || '').toLowerCase();
  cfg.telegram = {
    enabled: tgOn === '1' || tgOn === 'true' || tgOn === 'yes',
    botToken: env.TELEGRAM_BOT_TOKEN || null,
    chatId: env.TELEGRAM_CHAT_ID || null,
    apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    pollTimeoutSec: 50,
    scanIntervalSec: 60,
    // Defaults; the settings KV `quiet_hours` overrides at runtime.
    quietHours: { start: '23:00', end: '08:00' },
    heartbeatHour: 9,
    ...(cfg.telegram || {}),
  };

  // ---- resolve absolute paths ----
  // The platform link: env wins, then config file, then sibling default.
  const fmRoot = env.FOREVERMORE_ROOT
    ? resolve(env.FOREVERMORE_ROOT)
    : cfg.forevermoreRoot
      ? abs(cfg.forevermoreRoot, PKG_ROOT)
      : REPO_ROOT;
  const dataRoot = abs(cfg.paths.root, PKG_ROOT);
  const P = cfg.paths;
  cfg.resolved = {
    pkgRoot: PKG_ROOT,
    repoRoot: fmRoot, // = the Forevermore platform checkout (see REPO_ROOT doc)
    configPath,
    dbUrl: cfg.dbUrl || null, // control-plane Postgres DSN (store: 'postgres')
    dataRoot,
    outbox: abs(P.outbox, dataRoot),
    decisions: abs(P.decisions, dataRoot),
    runs: abs(P.runs, dataRoot),
    logs: abs(P.logs, dataRoot),
    digest: abs(P.digest, dataRoot),
    state: abs(P.state, dataRoot),
    library: abs(P.library, dataRoot),
    settings: abs(P.settings, dataRoot),
    // Kit assets now live in THIS repo (§3.12 kit move) — resolve under
    // PKG_ROOT, not the platform checkout. An absolute path in config still
    // wins (abs()), and an explicit override in autopilot.config.json still
    // layers on top, so env/config override precedence is unchanged.
    ideas: abs(P.ideas, PKG_ROOT),
    render: abs(P.render, PKG_ROOT),
    videoStudio: abs(P.videoStudio, PKG_ROOT),
    posters: abs(P.posters, PKG_ROOT),
    catalog: abs(P.catalog, PKG_ROOT),
    brandGuide: abs(P.brandGuide, PKG_ROOT),
    lintModule: cfg.lintModule ? abs(cfg.lintModule, PKG_ROOT) : null,
  };

  return cfg;
}
