/**
 * @file Brain contracts + a hand-rolled JSON validator for stage outputs.
 *
 * This file is intentionally DEPENDENCY-FREE (no `node:*` imports, no npm deps)
 * so the pipeline core (ticket AP-201) can import the `StageRequest` /
 * `StageResult` typedefs and the `SCHEMAS` / `validate` helpers without dragging
 * in `child_process`, `crypto`, or the driver machinery. Keep it that way.
 *
 * The output schemas below are the machine gate. Each prompt file in
 * `autopilot/prompts/*.md` embeds a human-readable copy of the same shape as
 * fenced JSON so the model sees exactly what it must emit — those two must stay
 * in sync. Field lists are normative per PRD §5 (ContentItem copy fields) and
 * ticket AP-301 (per-stage schemas).
 *
 * Validator scope, deliberately small: required keys, types, enums, array
 * item shapes, and array length bounds. It does NOT forbid extra keys by
 * default (models sprinkle stray fields; the pipeline reads only what it needs)
 * — pass `additionalProperties: false` on a schema node if you want that node
 * locked down.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Type contracts (imported by AP-201's pipeline core)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A single stage invocation, driver-agnostic. The driver assembles the layered
 * prompt from this (see `assemble.mjs`), calls the model, and validates the
 * output against `SCHEMAS[schema]`.
 *
 * @typedef {Object} StageRequest
 * @property {StageId} stage        Which stage agent (selects the prompt file).
 * @property {string[]} [contextFiles]  Absolute paths inlined into the prompt
 *   (e.g. the brand guide). With `--allowedTools ""` the model cannot read
 *   files itself, so context is injected by the harness, not fetched.
 * @property {string} [task]        Extra task text appended to the stage prompt.
 * @property {StageInputs} [inputs] Structured context (playbook rules, format
 *   spec, idea payload, world facts, recent-post digest, variant, feedback…).
 * @property {SchemaKey} schema     Which schema to validate the output against
 *   (usually equals `stage`; artdirector has two modes — see `SchemaKey`).
 */

/**
 * @typedef {Object} StageInputs
 * @property {PlaybookRule[]} [playbookRules]  Active learned rules (may be []).
 * @property {string|Object} [formatSpec]      Target slot format/platform.
 * @property {Object} [idea]                   Full idea payload (ideas.json shape).
 * @property {WorldFact[]} [worldFacts]        Worlds the copy may reference.
 * @property {RecentPost[]} [recentPosts]      Dedupe digest of recent hooks.
 * @property {number} [variant]                Candidate index (0-based) for the
 *   copywriter's 3-variant fan-out — nudges each candidate to differ.
 * @property {string[]} [feedback]             `changes_requested` notes (regen).
 * @property {Object} [extra]                  Anything else a caller wants to pass.
 */

/**
 * @typedef {Object} StageResult
 * @property {boolean} ok          True iff the model produced schema-valid JSON.
 * @property {any} data            Parsed + validated output (null on failure).
 * @property {string} raw          Raw model text (last attempt).
 * @property {number|null} tokensIn   Input tokens from the driver envelope.
 * @property {number|null} tokensOut  Output tokens from the driver envelope.
 * @property {string|null} model   Model that actually answered (best effort).
 * @property {string} promptSha    sha256 of the assembled (base) prompt.
 * @property {number|null} costUsd  Reported cost, or null (subscription/mock).
 * @property {string|null} error   Human-readable failure reason (null if ok).
 * @property {number} [attempts]   How many model calls were made (1 + retries).
 * @property {string} [driver]     Driver name that produced this result.
 */

/**
 * @typedef {Object} PlaybookRule
 * @property {string} rule
 * @property {string} [category]
 * @property {number} [weight]   1..10 injection priority (higher = earlier).
 */

/**
 * @typedef {Object} WorldFact
 * @property {string} name
 * @property {string} [slug]
 * @property {string} [tier]        'standard' | 'premium'
 * @property {boolean} [isActive]
 * @property {string} [description]
 */

/**
 * @typedef {Object} RecentPost
 * @property {string} [hook]
 * @property {string} [caption]
 * @property {string} [posted_at]
 */

/** @typedef {'planner'|'copywriter'|'artdirector'|'regen'|'reflect'|'suggestions'} StageId */
/** @typedef {'planner'|'copywriter'|'artdirector'|'artdirector.judge'|'regen'|'reflect'|'suggestions'} SchemaKey */

/* ────────────────────────────────────────────────────────────────────────
 * Shared enum vocabularies (mirror src/types.mjs + brand/strategy docs)
 * ──────────────────────────────────────────────────────────────────────── */

/** ap_platform (PRD §5). Kept local so this file stays dependency-free. */
export const PLATFORMS = ['instagram', 'tiktok'];
/** ap_format (PRD §5). */
export const FORMATS = ['reel', 'carousel', 'image', 'story', 'tiktok_video'];
/** Content pillars P1–P7 (marketing/_research/fable-creative-seeds.md §Pillar architecture). */
export const PILLARS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
/** playbook_rules.category (PRD §5). */
export const RULE_CATEGORIES = ['hook', 'caption', 'format', 'timing', 'world', 'visual'];
/** Structured directive kinds emitted by the suggestion parser (owner_notes → planner). */
export const DIRECTIVE_TYPES = [
  'occasion_focus', // lean into an occasion window
  'world_boost', // feature these worlds more
  'world_mute', // feature these worlds less / not at all
  'pillar_shift', // reweight the content-pillar mix
  'cadence', // change posting frequency / quiet days
  'pause', // hold a lane or the whole account
  'other', // free-form; planner treats as a soft note
];
/** Visual-QA verdict severities (PRD §7.3). */
export const VERDICT_SEVERITIES = ['block', 'warn'];

/* ────────────────────────────────────────────────────────────────────────
 * Output schemas — one per stage (+ artdirector's judge mode)
 * ──────────────────────────────────────────────────────────────────────── */

/** The exact ContentItem copy fields (PRD §5). Reused by copywriter + regen. */
const COPY_FIELDS = {
  caption: { type: 'string' },
  // Count law (TikTok ≤5 / IG ≤10) is enforced by the AP-401 lint gate, not here.
  hashtags: { type: 'array', items: { type: 'string' } },
  overlays: {
    type: 'object',
    required: ['hook', 'beats', 'cta'],
    properties: {
      hook: { type: 'string' },
      beats: { type: 'array', items: { type: 'string' } },
      cta: { type: 'string' },
    },
  },
  link_utm: { type: 'string' },
  // Advisory self-report. The REAL gate is the deterministic AP-401 lint engine;
  // a `true` here never substitutes for it (see copywriter.md).
  selfcheck: {
    type: 'object',
    required: ['claims_ok', 'nouns_ok', 'no_banned_words'],
    properties: {
      claims_ok: { type: 'boolean' },
      nouns_ok: { type: 'boolean' },
      no_banned_words: { type: 'boolean' },
    },
  },
};

const COPYWRITER_SCHEMA = {
  type: 'object',
  required: ['caption', 'hashtags', 'overlays', 'link_utm', 'selfcheck'],
  properties: COPY_FIELDS,
};

const PLANNER_SCHEMA = {
  type: 'object',
  required: ['slots'],
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slot_at', 'platform', 'format', 'pillar', 'idea_ids', 'rationale'],
        properties: {
          slot_at: { type: 'string' },
          platform: { type: 'string', enum: PLATFORMS },
          format: { type: 'string', enum: FORMATS },
          pillar: { type: 'string', enum: PILLARS },
          // Exactly three shortlisted ideas per slot (PRD §6.3).
          idea_ids: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

/** Art director, propose-params mode (PRD §7.1/§7.2). `params` is template-shaped. */
const ARTDIRECTOR_SCHEMA = {
  type: 'object',
  required: ['template', 'params'],
  properties: {
    template: { type: 'string' },
    params: { type: 'object' }, // free-form; keys vary per poster/comp template
    video: {
      type: 'object',
      required: ['comp', 'props'],
      properties: {
        comp: { type: 'string' },
        props: { type: 'object' },
      },
    },
    verdict: { type: 'object' }, // optional; present only if the model also judged
  },
};

/** Art director, judge-frames mode (PRD §7.3 visual QA). Select with schema key 'artdirector.judge'. */
const ARTDIRECTOR_JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: {
      type: 'object',
      required: ['pass', 'issues'],
      properties: {
        pass: { type: 'boolean' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['area', 'severity', 'note'],
            properties: {
              area: { type: 'string' },
              severity: { type: 'string', enum: VERDICT_SEVERITIES },
              note: { type: 'string' },
            },
          },
        },
        notes: { type: 'string' },
      },
    },
  },
};

/** Regenerator = copywriter output + the list of feedback points it addressed. */
const REGEN_SCHEMA = {
  type: 'object',
  required: ['caption', 'hashtags', 'overlays', 'link_utm', 'selfcheck', 'addressed'],
  properties: {
    ...COPY_FIELDS,
    addressed: { type: 'array', items: { type: 'string' } },
  },
};

/** Reflection (PRD §8.4). `proposals` may be [] when nothing clears the evidence bar. */
const REFLECT_SCHEMA = {
  type: 'object',
  required: ['proposals', 'report_md'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'category', 'evidence', 'confidence'],
        properties: {
          rule: { type: 'string' },
          category: { type: 'string', enum: RULE_CATEGORIES },
          // Items are strings (content_item_id / approval id) OR
          // {content_item_id, metric, value} objects — left unconstrained.
          evidence: { type: 'array' },
          confidence: { type: 'number' }, // 0..1
        },
      },
    },
    report_md: { type: 'string' },
  },
};

/** Suggestion parser (owner_notes → planner-consumable directives). */
const SUGGESTIONS_SCHEMA = {
  type: 'object',
  required: ['directives'],
  properties: {
    directives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'value', 'applies_from'],
        properties: {
          type: { type: 'string', enum: DIRECTIVE_TYPES },
          value: {}, // string | string[] | object — shape depends on `type`
          applies_from: { type: ['string', 'null'] }, // ISO date or null
        },
      },
    },
  },
};

/** @type {Record<SchemaKey, object>} */
export const SCHEMAS = {
  planner: PLANNER_SCHEMA,
  copywriter: COPYWRITER_SCHEMA,
  artdirector: ARTDIRECTOR_SCHEMA,
  'artdirector.judge': ARTDIRECTOR_JUDGE_SCHEMA,
  regen: REGEN_SCHEMA,
  reflect: REFLECT_SCHEMA,
  suggestions: SUGGESTIONS_SCHEMA,
};

/**
 * Look up a schema by key. Throws on unknown keys so a typo in a StageRequest
 * fails loudly instead of silently skipping validation.
 * @param {SchemaKey} key
 * @returns {object}
 */
export function getSchema(key) {
  const schema = SCHEMAS[key];
  if (!schema) {
    throw new Error(`unknown schema '${key}' (known: ${Object.keys(SCHEMAS).join(', ')})`);
  }
  return schema;
}

/* ────────────────────────────────────────────────────────────────────────
 * The validator
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Validate a value against a mini-schema.
 * @param {object} schema
 * @param {any} value
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(schema, value) {
  const errors = [];
  checkNode(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

function checkNode(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  // An empty schema node ({}) means "any defined value" — presence is enforced
  // by the parent's `required` list, so nothing to check here.
  if (Object.keys(schema).length === 0) return;

  if (schema.type !== undefined) {
    if (!matchesType(schema.type, value)) {
      const want = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
      errors.push(`${path}: expected ${want}, got ${typeNameOf(value)}`);
      return; // deeper checks are meaningless once the type is wrong
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of [${schema.enum.join(', ')}]`);
  }

  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) {
        errors.push(`${path}.${key}: missing required key`);
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value && value[key] !== undefined) {
          checkNode(sub, value[key], `${path}.${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }

  if (schema.type === 'array') {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: expected >= ${schema.minItems} items, got ${value.length}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: expected <= ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((el, i) => checkNode(schema.items, el, `${path}[${i}]`, errors));
    }
  }
}

/** @param {string|string[]} expected */
function matchesType(expected, value) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => matchesOne(t, value));
}

function matchesOne(t, v) {
  switch (t) {
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'any':
      return v !== undefined;
    default:
      return false;
  }
}

function typeNameOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v === undefined) return 'undefined';
  return typeof v;
}

/* ────────────────────────────────────────────────────────────────────────
 * JSON extraction — pull the model's object out of noisy completion text
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Best-effort extraction of a JSON value from raw model output. Tolerates:
 *   1. a clean JSON document,
 *   2. a ```json … ``` (or bare ```) fenced block,
 *   3. leading/trailing prose around a single top-level object/array.
 *
 * @param {string} text
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function extractJson(text) {
  if (typeof text !== 'string') return { ok: false, error: 'output is not a string' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'output is empty' };

  // 1) The whole thing is JSON.
  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  // 2) A fenced code block (```json … ``` or ``` … ```).
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed.ok) return parsed;
  }

  // 3) First balanced-looking object or array in the noise.
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const slice = outermostSlice(trimmed, open, close);
    if (slice) {
      const parsed = tryParse(slice);
      if (parsed.ok) return parsed;
    }
  }

  return { ok: false, error: 'no parseable JSON found in output' };
}

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function outermostSlice(s, open, close) {
  const start = s.indexOf(open);
  if (start < 0) return null;
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  return s.slice(start, end + 1);
}
