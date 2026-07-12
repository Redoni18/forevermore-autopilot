// Read-only view of autopilot/settings.json for the review station header
// (kill-switch state, autonomy level). This file is produced by the pipeline
// core (AP-201/AP-102 territory) — it may not exist yet, and its exact M0
// shape isn't nailed down by PRD §5 (only the Supabase `settings` KV table is
// specced: `key text primary key, value jsonb`). We tolerate two shapes so
// we degrade gracefully either way:
//
//   1) flat object   — { "kill_switch": false, "autonomy_level": "L1" }
//   2) KV row array   — [{ "key": "kill_switch", "value": false }, ...]
//
// Missing/unparseable file -> null (the UI hides the kill-switch pill).
import { readFile } from 'node:fs/promises';

export async function readSettings(settingsPath) {
  let raw;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const flat = {};
    for (const row of parsed) {
      if (row && typeof row === 'object' && typeof row.key === 'string') {
        flat[row.key] = row.value;
      }
    }
    return flat;
  }

  if (parsed && typeof parsed === 'object') return parsed;
  return null;
}
