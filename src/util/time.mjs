/**
 * @file Deterministic date + timezone helpers (zero deps).
 *
 * Calendar math is done on `YYYY-MM-DD` strings via UTC arithmetic so it is
 * DST-safe and free of local-clock surprises. Wall-clock → ISO conversion uses
 * `Intl.DateTimeFormat` (built in) to resolve the correct owner-local offset,
 * so `slot_at` strings are stable and correct without a tz library.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {string} dateStr `YYYY-MM-DD` — throws if malformed. */
function assertDate(dateStr) {
  if (!DATE_RE.test(dateStr)) throw new Error(`bad date "${dateStr}" (want YYYY-MM-DD)`);
  return dateStr;
}

/**
 * Add `n` whole days to a `YYYY-MM-DD` string (n may be negative).
 * @param {string} dateStr @param {number} n @returns {string}
 */
export function addDays(dateStr, n) {
  assertDate(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + n * 86400000;
  return toDateStr(new Date(ms));
}

/** Format a Date (interpreted in UTC) as `YYYY-MM-DD`. @param {Date} date */
export function toDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today's local calendar date as `YYYY-MM-DD` (uses the process clock). */
export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` → `YYYYMMDD` (used in deterministic item ids). */
export function compact(dateStr) {
  return assertDate(dateStr).replace(/-/g, '');
}

/**
 * Offset (minutes) of `tz` at a given instant. Positive = east of UTC.
 * Standard Intl "format-and-compare" technique.
 * @param {Date} instant @param {string} tz IANA zone, e.g. "Europe/Tirane".
 */
export function tzOffsetMinutes(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  // Intl renders 24:00 as "24" at midnight on some engines; normalise to 0.
  const hour = Number(parts.hour) % 24;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/** Minutes offset → `+HH:MM` / `-HH:MM`. @param {number} min */
export function offsetString(min) {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Build an ISO-8601 timestamp for a wall-clock time on `dateStr` in `tz`,
 * carrying the correct local offset — e.g. ("2026-07-14","17:30","Europe/Tirane")
 * → "2026-07-14T17:30:00+02:00".
 *
 * The two-step offset resolution handles the fact that the offset itself
 * depends on the instant: we guess by treating the wall time as UTC, correct
 * to the true instant, then re-read the offset there (stable away from the
 * ~1h/year DST fold).
 *
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {string} hhmm    `HH:MM`
 * @param {string} tz
 * @returns {string} ISO-8601 with offset.
 */
export function zonedISO(dateStr, hhmm, tz) {
  assertDate(dateStr);
  const [hh, mm] = hhmm.split(':').map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) throw new Error(`bad time "${hhmm}"`);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const wallAsUTC = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const guess = tzOffsetMinutes(new Date(wallAsUTC), tz);
  const trueInstant = new Date(wallAsUTC - guess * 60000);
  const off = tzOffsetMinutes(trueInstant, tz);
  const hhS = String(hh).padStart(2, '0');
  const mmS = String(mm).padStart(2, '0');
  return `${dateStr}T${hhS}:${mmS}:00${offsetString(off)}`;
}

/** The date part (`YYYY-MM-DD`) of an ISO timestamp. @param {string} iso */
export function isoDatePart(iso) {
  return String(iso).slice(0, 10);
}

/**
 * The [start, end) instants (as UTC-ISO strings) that bound a local calendar
 * date `YYYY-MM-DD` in the PROCESS-LOCAL timezone — the same zone {@link localToday}
 * reads. `new Date(y, m-1, d)` constructs local-midnight of that date; the next
 * day's local-midnight is the exclusive upper bound. Used by the spend-ledger's
 * `dailySpend(dateIso)` so a run "belongs to" a date iff its `started_at` (stored
 * UTC) falls inside that local day — identical semantics in file and postgres
 * mode, since both compare the same absolute instants.
 * @param {string} dateStr `YYYY-MM-DD` — throws if malformed.
 * @returns {{start:string, end:string}}
 */
export function localDayRange(dateStr) {
  assertDate(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    end: new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString(),
  };
}

/** Current time as ISO-8601 in UTC (`...Z`). */
export function nowISO(now = new Date()) {
  return now.toISOString();
}
