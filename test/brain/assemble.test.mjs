import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assemblePrompt,
  sha256,
  extractBrandSections,
  formatSpecFor,
  loadIdea,
  loadWorldFacts,
  worldFactsForIdea,
} from '../../src/brain/assemble.mjs';

/** A representative copywriter request with every input layer populated. */
function baseReq() {
  return {
    stage: 'copywriter',
    schema: 'copywriter',
    inputs: {
      playbookRules: [
        { rule: 'lead with tension in the first three words', category: 'hook', weight: 3 },
        { rule: 'name the recipient or their obsession in the hook', category: 'hook', weight: 8 },
      ],
      formatSpec: { platform: 'tiktok', format: 'tiktok_video' },
      idea: { id: 'F03', title: 'gamer-partner wedge', worlds: ['The Blockheart Mine'] },
      worldFacts: [
        { name: 'The Blockheart Mine', slug: 'blockheart-mine', tier: 'premium', isActive: true, description: 'voxel world' },
        { name: 'Gallery Wall', slug: 'gallery-wall', tier: 'standard', isActive: false, description: 'gallery' },
      ],
      recentPosts: [{ hook: 'old hook one', posted_at: '2026-07-01' }, 'old hook two'],
    },
  };
}

test('assembly is deterministic — same inputs, byte-identical prompt + sha', () => {
  const a = assemblePrompt(baseReq());
  const b = assemblePrompt(baseReq());
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.promptSha, b.promptSha);
  assert.equal(a.promptSha, sha256(a.prompt));
  assert.equal(a.promptSha.length, 64);
});

test('different inputs → different prompt sha', () => {
  const a = assemblePrompt(baseReq());
  const changed = baseReq();
  changed.inputs.idea.title = 'a completely different angle';
  const b = assemblePrompt(changed);
  assert.notEqual(a.promptSha, b.promptSha);
});

test('brand voice + claims are injected verbatim from the guide', () => {
  const { prompt } = assemblePrompt(baseReq());
  // Phrases that live in brand-guide §1–3 (verbatim law).
  assert.ok(prompt.includes('Made, not generated.'), 'expected the AI-noun rule verbatim');
  assert.ok(prompt.includes('$15 per gift'), 'expected the price claim verbatim');
  assert.ok(prompt.includes('Give them a whole world.'), 'expected a calibration line verbatim');
  // §4 (visual language) should NOT be pulled into the copy stages.
  assert.ok(!prompt.includes('## 4. Visual language'), 'brand §4 should be excluded');
});

test('layers appear in the fixed PRD §8.1 order', () => {
  const { prompt } = assemblePrompt(baseReq());
  const order = [
    'BRAND VOICE & CLAIMS',
    'ACTIVE PLAYBOOK RULES',
    'FORMAT SPEC',
    'IDEA PAYLOAD + WORLD FACTS',
    'RECENT POSTS',
    'YOUR TASK',
  ].map((h) => prompt.indexOf(h));
  for (const i of order) assert.ok(i >= 0, 'every layer header present');
  const sorted = [...order].sort((x, y) => x - y);
  assert.deepEqual(order, sorted, 'layers must be in the declared order');
});

test('playbook rules are sorted by weight (desc) and rendered with weight tags', () => {
  const { prompt } = assemblePrompt(baseReq());
  const iHigh = prompt.indexOf('name the recipient or their obsession');
  const iLow = prompt.indexOf('lead with tension in the first three words');
  assert.ok(iHigh > -1 && iLow > -1);
  assert.ok(iHigh < iLow, 'weight-8 rule must precede weight-3 rule');
  assert.ok(prompt.includes('[w8·hook]'));
});

test('empty playbook rules render a "none yet" placeholder', () => {
  const req = baseReq();
  req.inputs.playbookRules = [];
  const { prompt } = assemblePrompt(req);
  assert.ok(prompt.includes('none yet'));
});

test('format spec expands platform constraints; world facts flag inactive worlds', () => {
  const { prompt } = assemblePrompt(baseReq());
  assert.ok(prompt.includes('platform: tiktok'));
  assert.ok(prompt.includes('bottom 320px'), 'TikTok safe-area constraint present');
  assert.ok(prompt.includes('The Blockheart Mine (premium · active)'));
  assert.ok(prompt.includes('Gallery Wall (standard · INACTIVE'), 'inactive worlds are flagged');
});

test('recent-post digest is rendered for dedupe awareness', () => {
  const { prompt } = assemblePrompt(baseReq());
  assert.ok(prompt.includes('old hook one'));
  assert.ok(prompt.includes('old hook two'));
});

test('the task layer is the stage prompt file', () => {
  const { prompt } = assemblePrompt(baseReq());
  assert.ok(prompt.includes("You are Forevermore's social copywriter"));
  // The embedded output schema is present so the model sees the exact shape.
  assert.ok(prompt.includes('"no_banned_words"'));
});

test('variant + feedback generation hints are injected when present', () => {
  const req = baseReq();
  req.inputs.variant = 1;
  assert.ok(assemblePrompt(req).prompt.includes('candidate #2 of 3'));

  const regenReq = { stage: 'regen', schema: 'regen', inputs: { feedback: ['make the hook harsher'] } };
  const { prompt } = assemblePrompt(regenReq);
  assert.ok(prompt.includes('make the hook harsher'));
});

test('unknown stage / missing files fail loudly', () => {
  assert.throws(() => assemblePrompt({ stage: 'does-not-exist', schema: 'copywriter' }), /could not read/);
  assert.throws(() => assemblePrompt({}), /req.stage is required/);
});

/* ── helpers ────────────────────────────────────────────────────────────── */

test('extractBrandSections slices §1–3 and stops before §4', () => {
  const md = '# top\n\n## 1. one\naaa\n\n## 2. two\nbbb\n\n## 3. three\nccc\n\n## 4. four\nddd';
  const out = extractBrandSections(md);
  assert.ok(out.startsWith('## 1. one'));
  assert.ok(out.includes('## 3. three'));
  assert.ok(!out.includes('## 4. four'));
});

test('formatSpecFor encodes platform-specific hashtag + safe-area rules', () => {
  const tt = formatSpecFor('tiktok', 'tiktok_video');
  assert.match(tt.hashtags, /3.5/);
  assert.match(tt.safe_areas, /320px/);
  const ig = formatSpecFor('instagram', 'reel');
  assert.match(ig.hashtags, /~8/);
});

/* ── context loaders (used by the live smoke path) ──────────────────────── */

test('loaders read the real marketing sources', () => {
  const idea = loadIdea('F03');
  assert.equal(idea.id, 'F03');
  assert.ok(Array.isArray(idea.worlds) && idea.worlds.length > 0);

  const worlds = loadWorldFacts();
  assert.ok(worlds.length > 30);
  assert.ok(worlds.some((w) => w.slug === 'blockheart-mine'));

  const forF03 = worldFactsForIdea(idea, worlds);
  assert.ok(forF03.some((w) => w.name === 'The Blockheart Mine'));
});
