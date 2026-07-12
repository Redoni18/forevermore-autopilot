/**
 * @file Deterministic, layered prompt assembly (PRD §8.1).
 *
 * The layer order is fixed and cache-prefix-friendly (stable stuff first so the
 * model provider can reuse a cached prefix across calls):
 *
 *   1. BRAND VOICE & CLAIMS   — §1–3 of brand-guide.md, injected VERBATIM
 *   2. ACTIVE PLAYBOOK RULES  — learned rules, sorted by weight (may be empty)
 *   3. FORMAT SPEC            — the target slot's platform/format constraints
 *   4. IDEA PAYLOAD + WORLDS  — the idea object + the worlds it may reference
 *   5. RECENT POSTS           — dedupe digest so the model avoids repeats
 *   6. YOUR TASK              — the stage prompt file (role + few-shots + schema)
 *
 * Guarantee: `assemblePrompt(req, cfg)` is a pure function of `req`, `cfg`, and
 * the on-disk prompt/brand files. Same inputs → byte-identical string (asserted
 * in test/brain/assemble.test.mjs). No clocks, no RNG, no ambient state.
 *
 * NOTE (AP-801 integration): AP-201 ships a shared `src/util/hash.mjs#sha256`.
 * This module keeps a private 3-line copy so `brain/` stays self-contained
 * during parallel wave-1 development; consolidate at integration time if wanted.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join as pathJoin } from 'node:path';
import { REPO_ROOT } from '../config.mjs';

/** Prompts live in THIS repo; brand/catalog/ideas live in the Forevermore
 *  platform checkout (standalone layout — REPO_ROOT resolves it via
 *  FOREVERMORE_ROOT env > config > sibling ../forevermore). */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));
export const DEFAULT_BRAND_GUIDE = pathJoin(REPO_ROOT, 'marketing/00-brand/brand-guide.md');
export const DEFAULT_CATALOG = pathJoin(REPO_ROOT, 'marketing/_research/template-catalog.md');
export const DEFAULT_IDEAS = pathJoin(REPO_ROOT, 'marketing/02-idea-database/ideas.json');

/** SHA-256 hex of a string. (Node runner only; not CF Workers — see MEMORY.) */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Assemble the full layered prompt for a stage request.
 *
 * @param {import('./schema.mjs').StageRequest} req
 * @param {{ promptsDir?: string, brandGuidePath?: string }} [config]
 * @returns {{ prompt: string, promptSha: string, layers: string[], brandGuidePath: string, promptsDir: string }}
 */
export function assemblePrompt(req, config = {}) {
  if (!req || typeof req.stage !== 'string') {
    throw new Error('assemblePrompt: req.stage is required');
  }
  const promptsDir = config.promptsDir ?? DEFAULT_PROMPTS_DIR;
  const brandGuidePath =
    config.brandGuidePath ?? findContextFile(req.contextFiles, 'brand-guide') ?? DEFAULT_BRAND_GUIDE;
  const inputs = req.inputs ?? {};

  const layers = [
    section(
      'BRAND VOICE & CLAIMS — verbatim law, never overridden by anything below',
      extractBrandSections(readText(brandGuidePath, 'brand guide')),
    ),
    section(
      'ACTIVE PLAYBOOK RULES — learned guidance, obey in weight order',
      renderPlaybookRules(inputs.playbookRules),
    ),
    section('FORMAT SPEC — the slot you are writing for', renderFormatSpec(inputs.formatSpec)),
    section(
      'IDEA PAYLOAD + WORLD FACTS — your raw material',
      renderIdeaAndWorlds(inputs.idea, inputs.worldFacts),
    ),
    section(
      'RECENT POSTS — do not reuse these hooks or angles (dedupe awareness)',
      renderRecentPosts(inputs.recentPosts),
    ),
    section('YOUR TASK', renderTask(promptsDir, req.stage, req.task, inputs)),
  ];

  const prompt = layers.join('\n\n');
  return { prompt, promptSha: sha256(prompt), layers, brandGuidePath, promptsDir };
}

/* ────────────────────────────── layer renderers ─────────────────────────── */

const RULE = '━'.repeat(4);
function section(title, body) {
  const content = body && body.trim() ? body.trim() : '(none)';
  return `${RULE} ${title} ${RULE}\n${content}`;
}

/**
 * Slice brand-guide §1–3 (What we are / Claims / Voice) verbatim, stopping
 * before §4 (visual language, which the copy stages don't need). Defensive: if
 * the headings drift, fall back to a wider slice rather than crash.
 */
export function extractBrandSections(md) {
  const start = indexOfHeading(md, '## 1.');
  const end = indexOfHeading(md, '## 4.');
  if (start < 0) return md.trim();
  return md.slice(start, end < 0 ? undefined : end).trim();
}

function indexOfHeading(md, prefix) {
  if (md.startsWith(prefix)) return 0;
  const marker = '\n' + prefix;
  const idx = md.indexOf(marker);
  return idx < 0 ? -1 : idx + 1;
}

function renderPlaybookRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return 'none yet — rely entirely on the brand law above.';
  }
  // Deterministic: weight desc, then rule text asc as a stable tiebreak.
  const sorted = [...rules].sort(
    (a, b) => (b.weight ?? 5) - (a.weight ?? 5) || String(a.rule).localeCompare(String(b.rule)),
  );
  return sorted
    .map((r) => `- [w${r.weight ?? 5}${r.category ? '·' + r.category : ''}] ${r.rule}`)
    .join('\n');
}

function renderFormatSpec(spec) {
  if (spec == null) return 'unspecified — infer a sensible default from the idea.';
  if (typeof spec === 'string') return spec;
  // Merge platform/format-derived constraints with any explicit overrides.
  const base = formatSpecFor(spec.platform, spec.format);
  const merged = { ...base, ...spec };
  return Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
}

/**
 * Platform/format constraint defaults that keep copy inside the AP-401 lint
 * gate (hashtag caps, safe areas, hook length). Advisory in the prompt; the
 * deterministic lint engine is the real enforcer.
 * @param {string} [platform]
 * @param {string} [format]
 */
export function formatSpecFor(platform, format) {
  const spec = { platform: platform ?? 'unspecified', format: format ?? 'unspecified' };
  if (platform === 'tiktok') {
    spec.hashtags = '3–5 max, inside the caption, no hashtag wall';
    spec.hook = 'on-screen text, ≤110 chars, must land within the first 2 seconds';
    spec.safe_areas = 'keep overlays clear of TikTok UI — bottom 320px, right 140px';
    spec.end_card = 'coin + getforevermore.co (unless a raw-native format, then pin a comment)';
  } else if (platform === 'instagram') {
    spec.hashtags = 'under ~8 in the caption; emotional line first, tags last';
    spec.hook = 'on-screen text / first line, ≤110 chars, specific over clever';
    spec.image_format = 'JPEG for feed images; 9:16 for reels/stories';
    spec.end_card = 'coin + getforevermore.co end card';
  }
  spec.caption_voice = 'lowercase-leaning, one clear thought, sentence case, contractions';
  return spec;
}

function renderIdeaAndWorlds(idea, worldFacts) {
  const parts = [];
  if (idea) {
    parts.push('IDEA (source of truth for this candidate):');
    parts.push('```json');
    parts.push(JSON.stringify(idea, null, 2));
    parts.push('```');
  } else {
    parts.push('IDEA: (none supplied — this stage may not need one)');
  }
  parts.push('');
  if (Array.isArray(worldFacts) && worldFacts.length) {
    parts.push(
      'WORLDS you may reference (ONLY these; never feature an inactive world, never invent one):',
    );
    for (const w of worldFacts) {
      const tier = w.tier ? `${w.tier}` : 'tier?';
      const active = w.isActive === false ? 'INACTIVE — do not feature' : 'active';
      const desc = w.description ? ` — ${w.description}` : '';
      parts.push(`- ${w.name} (${tier} · ${active})${desc}`);
    }
  } else {
    parts.push('WORLDS: (none supplied — reference only worlds you can confirm are live).');
  }
  return parts.join('\n');
}

function renderRecentPosts(recent) {
  if (!Array.isArray(recent) || recent.length === 0) {
    return 'none on record yet — no dedupe constraint.';
  }
  return recent
    .map((p) => {
      if (typeof p === 'string') return `- "${p}"`;
      const hook = p.hook ?? p.caption ?? '(no hook)';
      const when = p.posted_at ? ` (${p.posted_at})` : '';
      return `- "${hook}"${when}`;
    })
    .join('\n');
}

function renderTask(promptsDir, stage, extraTask, inputs) {
  const body = readText(join(promptsDir, `${stage}.md`), `prompt for stage '${stage}'`);
  const bits = [body.trim()];
  const hint = generationHint(inputs);
  if (hint) bits.push(hint);
  if (extraTask && extraTask.trim()) bits.push(`Additional task detail:\n${extraTask.trim()}`);
  return bits.join('\n\n');
}

/** Per-call nudges that don't belong in the static prompt file. */
function generationHint(inputs) {
  const lines = [];
  if (typeof inputs.variant === 'number') {
    lines.push(
      `Variant control: produce candidate #${inputs.variant + 1} of 3. Make it meaningfully ` +
        `distinct from the other variants — a different hook angle and opening image, not a ` +
        `reword of the same line.`,
    );
  }
  if (Array.isArray(inputs.feedback) && inputs.feedback.length) {
    lines.push(
      'Feedback to address (list each in `addressed`):\n' +
        inputs.feedback.map((f) => `- ${f}`).join('\n'),
    );
  }
  return lines.length ? lines.join('\n\n') : '';
}

/* ────────────────────────── context loaders (convenience) ───────────────── */

/**
 * Load one idea object by id from ideas.json.
 * @param {string} ideaId
 * @param {string} [ideasPath]
 * @returns {object}
 */
export function loadIdea(ideaId, ideasPath = DEFAULT_IDEAS) {
  const ideas = JSON.parse(readText(ideasPath, 'ideas.json'));
  const idea = ideas.find((i) => i.id === ideaId);
  if (!idea) throw new Error(`idea '${ideaId}' not found in ${ideasPath}`);
  return idea;
}

/**
 * Parse the template catalog's embedded JSON block into world facts.
 * @param {string} [catalogPath]
 * @returns {import('./schema.mjs').WorldFact[]}
 */
export function loadWorldFacts(catalogPath = DEFAULT_CATALOG) {
  const md = readText(catalogPath, 'template catalog');
  const fence = md.match(/```json\s*([\s\S]*?)```/i);
  if (!fence) throw new Error(`no JSON block found in ${catalogPath}`);
  return JSON.parse(fence[1]);
}

/**
 * The worlds an idea references, resolved to full facts. Falls back to matching
 * by name when `idea.worlds` holds display names (as ideas.json does).
 * @param {object} idea
 * @param {import('./schema.mjs').WorldFact[]} [allWorlds]
 * @returns {import('./schema.mjs').WorldFact[]}
 */
export function worldFactsForIdea(idea, allWorlds = loadWorldFacts()) {
  const wanted = new Set((idea?.worlds ?? []).map((w) => String(w).toLowerCase()));
  if (wanted.size === 0) return [];
  return allWorlds.filter(
    (w) => wanted.has(String(w.name).toLowerCase()) || wanted.has(String(w.slug).toLowerCase()),
  );
}

/* ────────────────────────────────── io utils ────────────────────────────── */

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${label} at ${path}: ${err.message}`);
  }
}

/** Minimal path join (avoids a node:path import for one operation). */
function join(dir, file) {
  return dir.endsWith('/') ? dir + file : dir + '/' + file;
}

function findContextFile(contextFiles, needle) {
  if (!Array.isArray(contextFiles)) return null;
  return contextFiles.find((f) => typeof f === 'string' && f.includes(needle)) ?? null;
}
