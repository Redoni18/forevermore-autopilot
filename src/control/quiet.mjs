/**
 * @file Quiet-hours window math (pure, timezone-aware).
 *
 * During quiet hours the scanner still runs but only *critical* events are
 * claimed-and-sent; non-critical events stay un-ledgered and flush naturally on
 * the first scan after the window ends (no queue — the ledger IS the queue).
 * Default 23:00–08:00 in the config timezone; the settings KV `quiet_hours`
 * overrides at runtime. Handles the across-midnight wrap.
 */

/** Minutes-since-midnight for "HH:MM" (local wall clock). */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The wall-clock HH:MM at `instant` in `tz` (Intl, no deps). */
function wallMinutes(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const min = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + min;
}

/**
 * Is `instant` inside the quiet window?
 * @param {Date} instant
 * @param {{start:string, end:string}} window  e.g. {start:'23:00', end:'08:00'}
 * @param {string} tz  IANA timezone (config.timezone)
 * @returns {boolean}
 */
export function inQuietHours(instant, window, tz) {
  if (!window || !window.start || !window.end) return false;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start == null || end == null) return false;
  if (start === end) return false; // zero-width window → never quiet
  const now = wallMinutes(instant, tz);
  // Same-day window (e.g. 01:00–06:00): inside iff start ≤ now < end.
  if (start < end) return now >= start && now < end;
  // Across-midnight window (e.g. 23:00–08:00): inside iff now ≥ start OR now < end.
  return now >= start || now < end;
}

/**
 * Resolve the effective quiet window: settings KV `quiet_hours` overrides the
 * config default. Returns null-safe {start,end}.
 * @param {Object} settingsQuietHours  value of getSetting('quiet_hours')
 * @param {{start:string,end:string}} configDefault
 */
export function resolveQuietWindow(settingsQuietHours, configDefault) {
  const s = settingsQuietHours;
  if (s && typeof s === 'object' && s.start && s.end) return { start: s.start, end: s.end };
  return configDefault;
}
