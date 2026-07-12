# ADR-001 — Autopilot is a standalone system, not part of the Forevermore monorepo

Date: 2026-07-12 · Status: accepted (owner directive)

## Decision

Autopilot lives in its own repository (`forevermore-autopilot/`) with its own
database. It is an external actor that CONNECTS TO the Forevermore platform;
it shares no directory, no schema, and no database with it.

## The connection surface (all of it)

| Link | Mechanism | Direction |
|---|---|---|
| Render tools + marketing kit + template catalog | `FOREVERMORE_ROOT` (env > config `forevermoreRoot` > sibling `../forevermore`) — read-only filesystem access to the platform checkout | Autopilot → platform (read) |
| Own control-plane DB | `AUTOPILOT_DB_URL` → Autopilot's own Postgres (local Docker now; its own hosted PG/Supabase project later — NEVER the platform's database) | internal |
| Publishing | Meta Graph API / TikTok Content API with Autopilot-held tokens (wave 2) | Autopilot → platforms |
| Future platform reads (world drops, price changes) | the platform's public/authed HTTP APIs — not DB access | Autopilot → platform (read) |

## What changed at extraction (from the embedded wave-1 layout)

- `autopilot/` moved out of the monorepo → this repo (own git history).
- `supabase/migrations/20260713090000_autopilot_schema.sql` REMOVED from the
  platform repo → `db/migrations/0001_autopilot_schema.sql` here, applied to
  Autopilot's own Postgres only. The platform's Supabase project will never
  carry an `autopilot` schema.
- `REPO_ROOT` semantics: was "my parent dir"; now "the platform checkout",
  resolved via FOREVERMORE_ROOT. Single source of truth in `src/config.mjs`,
  reused by the lint CLI and the brain's default source paths.
- PRD/TICKETS moved to `docs/` (canonical here; the platform repo keeps only
  a pointer in `marketing/07-autopilot/README.md`).

## Consequences

- The platform repo's `marketing/` kit remains the content source Autopilot
  operates on (by explicit design — it's the employee's toolbox). If the kit
  ever needs to move too, only FOREVERMORE_ROOT-relative paths change.
- Anything in docs/PRD.md that assumed shared-Supabase (`is_admin_self()`
  gating for Atlas Studio, main-repo migration flow) is superseded by this
  ADR: review UI auth is Autopilot's own concern; the M1 "Studio" ships in
  this repo, not inside apps/atlas.
- `db/migrations/0001` must be fully self-contained (own `private`-schema
  helpers, own roles guard, own admin gate) — no dependency on any migration
  from the platform project.
