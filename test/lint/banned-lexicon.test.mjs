import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBannedLexicon } from '../../src/lint/rules/banned-lexicon.mjs';

function violationRules(item) {
  return checkBannedLexicon(item, {}).map((v) => v.rule);
}

test('banned-lexicon: every listed banned word blocks, case-insensitively, word-boundary matched', () => {
  const words = [
    'unleash', 'elevate', 'seamless', 'unlock', 'empower', 'journey',
    'solution', 'game-changer', 'revolutionary', 'cutting-edge', 'unforgettable',
  ];
  for (const word of words) {
    const item = { caption: `We ${word.toUpperCase()} everything for you.` };
    const violations = checkBannedLexicon(item, {});
    assert.ok(
      violations.some((v) => v.rule === 'banned-lexicon:term'),
      `expected "${word}" to block`,
    );
    assert.equal(violations[0].severity, 'block');
  }
});

test('banned-lexicon: "unlock" blocks even as a literal in-world mechanic (AC tricky case)', () => {
  // memory-mine's own catalog copy uses this literal construction —
  // the guide's precedent (IG pack reworded literal uses) means no carve-out.
  const item = { caption: 'spend six hard-won gems to unlock the vault holding your message' };
  const violations = checkBannedLexicon(item, {});
  assert.ok(violations.some((v) => v.rule === 'banned-lexicon:term' && v.severity === 'block'));
});

test('banned-lexicon: word-boundary matching does not false-positive on substrings', () => {
  // "unlocked" / "journeyman" etc. share no boundary-isolated "unlock"/"journey" token only if suffixed;
  // but our rule intentionally still fires on prefix matches like "unlocking" is NOT in the list,
  // so a genuinely unrelated word containing the substring should stay clean.
  const item = { caption: 'the solutioneer sells no such thing' }; // not a real word, no boundary match for "solution"
  // "solutioneer" contains "solution" but NOT as a bounded token (bounded on the left, not the right)
  const violations = checkBannedLexicon(item, {});
  assert.equal(violations.filter((v) => v.rule === 'banned-lexicon:term').length, 0);
});

test('banned-lexicon: "take it to the next level" phrase blocks', () => {
  const item = { overlays: { hook: 'this is going to take it to the next level for real', beats: [] } };
  assert.ok(violationRules(item).includes('banned-lexicon:term'));
});

test('banned-lexicon: "Introducing X — the ultimate Y" pattern blocks', () => {
  const item = { caption: 'Introducing our newest release, the ultimate way to say it.' };
  assert.ok(violationRules(item).includes('banned-lexicon:introducing-ultimate'));
});

test('banned-lexicon: "introducing" alone (no "the ultimate" in the same sentence) passes', () => {
  const item = { caption: 'Introducing a new way to say it.' };
  assert.equal(violationRules(item).includes('banned-lexicon:introducing-ultimate'), false);
});

test('banned-lexicon: rocket emoji blocks on a single occurrence', () => {
  const item = { caption: 'check this out \u{1F680}' };
  assert.ok(violationRules(item).includes('banned-lexicon:emoji-rocket'));
});

test('banned-lexicon: a single sparkle emoji is allowed', () => {
  const item = { caption: 'a little sparkle for you ✨' };
  assert.equal(violationRules(item).includes('banned-lexicon:emoji-sparkle-spam'), false);
});

test('banned-lexicon: sparkle-emoji spam (>1) blocks', () => {
  const item = { caption: 'so much sparkle today ✨✨' };
  assert.ok(violationRules(item).includes('banned-lexicon:emoji-sparkle-spam'));
});

test('banned-lexicon: ALL-CAPS run of 4+ words blocks', () => {
  const item = { caption: 'THIS IS SO INCREDIBLY AMAZING today' };
  assert.ok(violationRules(item).includes('banned-lexicon:all-caps-run'));
});

test('banned-lexicon: exactly 3 consecutive ALL-CAPS words is under threshold and passes', () => {
  const item = { caption: 'THIS IS FUN today' };
  assert.equal(violationRules(item).includes('banned-lexicon:all-caps-run'), false);
});

test('banned-lexicon: approved tiny all-caps chip badges are exempt', () => {
  for (const chip of ['MOST LOVED', '1 OF 1', 'WOW', 'THE FOREVERMORE WAY']) {
    const item = { overlays: { hook: chip, beats: [] } };
    assert.equal(
      violationRules(item).includes('banned-lexicon:all-caps-run'),
      false,
      `expected chip "${chip}" to be exempt`,
    );
  }
});

test('banned-lexicon: clean on-brand copy has zero violations', () => {
  const item = {
    caption: 'give them a whole world, built from your photos and your words',
    overlays: { hook: 'your photos, your words, and the song that is already theirs', beats: ['1 tap.'] },
  };
  assert.deepEqual(checkBannedLexicon(item, {}), []);
});
