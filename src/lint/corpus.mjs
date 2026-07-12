// autopilot/src/lint/corpus.mjs
//
// Loads the trailing-90-day dedupe corpus: a JSON array of
// [{ id, hook }, ...] that the pipeline passes in. No corpus file is
// normative yet (the store doesn't exist until AP-103/AP-201 land), so a
// missing/unset path resolves to an empty array rather than throwing —
// dedupe then degrades gracefully to hook_sim: 0.

import fs from 'node:fs';

export function loadCorpus(filePath) {
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`loadCorpus: ${filePath} does not contain a JSON array`);
  }
  return data;
}
