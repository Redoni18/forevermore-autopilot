// AP-845: kit/platform contract checks + the tick's fingerprint-gated drift
// alert. Hermetic: a fixture kit in a temp dir, temp file store, stub deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { contractChecks, contractFingerprint } from '../src/doctor/contract.mjs';
import { runTickSweep } from '../src/stages/tick.mjs';
import { FixtureBrain } from '../src/drivers/fixture-brain.mjs';
import { mkEnv, adapterStub, lintPass } from './helpers.mjs';

const RUN_DATE = '2026-07-14';
const sweepDeps = () => ({ brain: new FixtureBrain(), adapters: adapterStub, lintFn: lintPass });

/** Build a complete, passing kit fixture under tmp and point config at it. */
function buildKit(tmp, config) {
  const kit = join(tmp, 'kit');
  const posters = join(kit, 'posters');
  const studio = join(kit, 'studio');
  mkdirSync(join(posters, 'assets', 'mascot'), { recursive: true });
  for (const t of ['quote-card.html', 'carousel-slide.html', 'world-drop.html']) {
    writeFileSync(join(posters, t), '<html></html>');
  }
  for (const m of ['gift.png', 'album.png', 'book.png']) {
    writeFileSync(join(posters, 'assets', 'mascot', m), '');
  }
  mkdirSync(join(studio, 'src'), { recursive: true });
  writeFileSync(
    join(studio, 'src', 'index.ts'),
    '// comps: HookCard ShowcaseCard WorldShelfCard EndCard',
  );
  mkdirSync(join(studio, 'public', 'template-thumbs'), { recursive: true });
  for (let i = 0; i < 31; i++) writeFileSync(join(studio, 'public', 'template-thumbs', `w${i}.jpg`), '');
  const render = join(kit, 'render.mjs');
  writeFileSync(render, 'export function renderOne() {}\nexport function renderJobs() {}\n');
  const brandGuide = join(kit, 'brand-guide.md');
  writeFileSync(brandGuide, '## 1. What we are\n## 2. Claims & price law\n## 3. Voice\n');
  const catalog = join(kit, 'catalog.json');
  writeFileSync(catalog, JSON.stringify([{ world: 'Gone Fishing' }]));
  const library = join(tmp, 'library');
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'clip.mp4'), 'x');
  writeFileSync(
    join(library, 'manifest.json'),
    JSON.stringify({ 'gone-fishing': { file: 'clip.mp4', dur_s: 45 } }),
  );

  Object.assign(config.resolved, {
    render,
    posters,
    videoStudio: studio,
    brandGuide,
    catalog,
    library,
    repoRoot: tmp, // stands in for the platform checkout
  });
  return { kit, posters, studio, render, brandGuide, catalog, library };
}

test('a complete kit passes every check, deep import included', async () => {
  const { tmp, config } = mkEnv();
  buildKit(tmp, config);

  const checks = await contractChecks(config, { deep: true });
  const failed = checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.equal(contractFingerprint(checks), '');

  const exportCheck = checks.find((c) => c.name === 'kit render.mjs exports');
  assert.ok(exportCheck && exportCheck.ok, 'deep mode verified renderOne/renderJobs');
});

test('drift is caught per family, and the fingerprint tracks the failure set', async () => {
  const { tmp, config } = mkEnv();
  const kit = buildKit(tmp, config);

  rmSync(join(kit.posters, 'carousel-slide.html'));
  let checks = await contractChecks(config);
  let tpl = checks.find((c) => c.name === 'kit poster templates');
  assert.equal(tpl.ok, false);
  assert.match(tpl.detail, /carousel-slide\.html/);
  const fp1 = contractFingerprint(checks);
  assert.notEqual(fp1, '');

  // A second, different failure → a different fingerprint.
  writeFileSync(join(kit.brandGuide), '## 1. What we are\n');
  checks = await contractChecks(config);
  assert.equal(checks.find((c) => c.name === 'kit brand guide').ok, false);
  const fp2 = contractFingerprint(checks);
  assert.notEqual(fp2, fp1);

  // Warn-level failures never enter the fingerprint.
  rmSync(join(kit.library, 'clip.mp4'));
  const withWarn = await contractChecks(config);
  assert.equal(withWarn.find((c) => c.name === 'capture library').ok, false);
  assert.equal(contractFingerprint(withWarn), fp2, 'warn failures do not change the fingerprint');
});

test('render.mjs missing an export fails only the deep check', async () => {
  const { tmp, config } = mkEnv();
  const kit = buildKit(tmp, config);
  writeFileSync(kit.render, 'export function renderOne() {}\n'); // no renderJobs

  const fast = await contractChecks(config);
  assert.equal(fast.find((c) => c.name === 'kit render.mjs').ok, true, 'fast mode only checks existence');

  const deep = await contractChecks(config, { deep: true });
  const exp = deep.find((c) => c.name === 'kit render.mjs exports');
  assert.equal(exp.ok, false);
  assert.match(exp.detail, /renderJobs/);
});

test('tick: one failed doctor:contract run per distinct drift, silent recovery', async () => {
  const { tmp, config, store } = mkEnv();
  const kit = buildKit(tmp, config);

  const contractRuns = async () =>
    (await store.listRuns({ limit: 50 })).filter(
      (r) => r.status === 'failed' && /contract drift/.test(r.error || ''),
    );

  // Healthy kit → no run row, no fingerprint.
  await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.deepEqual(await contractRuns(), []);

  // Break the kit → exactly one failed run, fingerprint stored.
  rmSync(join(kit.posters, 'world-drop.html'));
  await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  let runs = await contractRuns();
  assert.equal(runs.length, 1);
  assert.match(runs[0].error, /world-drop\.html/);
  const fp = await store.getSetting('contract_state');
  assert.ok(fp);

  // Same drift, next tick → deduped, still one run.
  await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.equal((await contractRuns()).length, 1, 'persistent drift alerts once, not per tick');

  // Fix it → fingerprint clears, no new failed run.
  writeFileSync(join(kit.posters, 'world-drop.html'), '<html></html>');
  await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.equal((await contractRuns()).length, 1);
  assert.equal(await store.getSetting('contract_state'), '');
});

test('tick: paused and dry runs skip the contract gate entirely', async () => {
  const { tmp, config, store } = mkEnv();
  const kit = buildKit(tmp, config);
  rmSync(join(kit.posters, 'quote-card.html')); // broken kit throughout

  await store.setSetting('kill_switch', true);
  await runTickSweep({ config, store, today: RUN_DATE, ...sweepDeps() });
  assert.equal(await store.getSetting('contract_state'), undefined, 'paused sweep never ran the gate');

  await store.setSetting('kill_switch', false);
  await runTickSweep({ config, store, today: RUN_DATE, dryRun: true, ...sweepDeps() });
  assert.equal(await store.getSetting('contract_state'), undefined, 'dry run never ran the gate');
});
