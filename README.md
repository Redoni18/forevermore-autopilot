# Autopilot — pipeline core (M0+)

Standalone autonomous marketing system for Forevermore: plans a content calendar,
generates copy, renders finished media, runs QA, and emits a review digest. Own
repository with own Postgres database; connects to the Forevermore platform via
`FOREVERMORE_ROOT` (defaults to `../forevermore`). See `docs/ADR-001-standalone.md`.

This package is tickets **AP-201** (pipeline core + CLI), **AP-103** (store
abstraction), and **AP-203** (renderer adapters). Contracts are normative in
`docs/PRD.md` (§5 ContentItem, §6 state machine, §7 adapters, §8.2 brain driver).

Zero runtime dependencies. Node ≥ 22. ESM. Tests use `node:test`.

## First run

```bash
make db-up                                   # Start Docker Postgres container
make db-apply                                # Apply Autopilot schema migrations
node bin/autopilot.mjs doctor                # Environment check (Brave/Remotion/claude/platform)
make station                                 # Start review web UI at http://127.0.0.1:4600
```

## Quickstart

```bash
# Plan the week after a date (deterministic — no model), preview only:
node bin/autopilot.mjs run plan --dry-run --date 2026-07-13

# The M0 loop for a slot day (fixture brain needs no keys/model):
node bin/autopilot.mjs run plan     --date 2026-07-13
node bin/autopilot.mjs run generate --date 2026-07-14           # fixture copy
node bin/autopilot.mjs run render   --date 2026-07-14           # real Brave + Remotion
node bin/autopilot.mjs run qa       --date 2026-07-14           # no-op lint passes (AP-401 = real)
node bin/autopilot.mjs run digest   --date 2026-07-14           # writes digest/2026-07-14.html

# Review from the CLI (local station is AP-501):
node bin/autopilot.mjs ls pending_review
node bin/autopilot.mjs show <id>
node bin/autopilot.mjs approve <id> --note "love this"
node bin/autopilot.mjs reject  <id> --reason hook-weak
node bin/autopilot.mjs regen   <id> --note "make the hook harsher"

node bin/autopilot.mjs pause     # engage the kill switch (every stage no-ops)
node bin/autopilot.mjs resume
```

Or use make shortcuts:
```bash
make plan                                    # Runs plan stage
make generate                                # Runs generate stage
make station                                 # Starts review web UI
```

`--date` defaults to today. `generate|render|qa|digest` act on that **slot
date**; `plan` plans the 7 days after it. A completed `(stage,date)` is a no-op
with a logged skip unless you pass `--force`. Re-running any stage is idempotent
and resumes cleanly after a crash (status-guarded CAS transitions).

## Stages & flow

```
plan → generate → render → qa → digest
planned → drafting → drafted → rendering → rendered → pending_review
                                                    ↘ qa_failed → drafting (≤3) → skipped
pending_review → approved | changes_requested → drafting (≤2) | skipped(reject)
```

- **plan** — deterministic (PRD §6.3 v0): reads `../marketing/02-idea-database/ideas.json`,
  applies the D-6 cadence (1 IG + 1 TikTok/day, 3 candidates/slot), scores ideas by
  `score × recency` (recency journal in `state/ideas-usage.json`), writes `planned` shells.
- **generate** — fills caption/hashtags/overlays via an injected `BrainDriver`
  (default `fixture`; `--driver mock|claude-cli|agent-sdk` bridge to AP-301's
  `src/brain/`).
- **render** — routes by format to the AP-203 adapters (poster / video / capture).
- **qa** — runs the injected lint fn (default no-op passes; real engine = AP-401
  via `config.lintModule`).
- **digest** — writes a static HTML summary per slot day (no email; that's AP-503).

## Layout (standalone repo)

```
bin/autopilot.mjs              CLI entry
autopilot.config.json          paths, cadence, timezone (Europe/Tirane), retry, brave
src/config.mjs                 config loader (FOREVERMORE_ROOT, AUTOPILOT_DB_URL)
src/types.mjs                  enums + JSDoc contracts (ContentItem, Store, BrainDriver…)
src/store/                     Store abstraction: FileStore + SupabaseStore
src/state/machine.mjs          state machine + guards + retry/backoff
src/plan/                      ideas mapping + deterministic planner + usage journal
src/stages/                    plan · generate · render · qa · digest + registry
src/adapters/                  poster · video · capture (AP-203) + proc helpers
src/drivers/                   fixture brain + brain-driver seam + lint seam
src/cli/                       arg parser + command handlers
src/brain/                     LLM integration (M0: fixture; M1+: claude-cli/agent-sdk)
test/                          node --test suite
review/                        Review web UI (AP-501)
db/                            Schema migrations (Autopilot's own Postgres)
ops/launchd/                   launchd plists (Mac scheduler)
ops/github/                    GitHub Actions workflow
docs/                          PRD + ADR + runbook
```

Runtime output (git-ignored): `outbox/<id>/item.json` + `assets/`, `decisions/`,
`runs/`, `logs/`, `digest/`, `state/`, `settings.json`.

## Config & env

Standalone layout (ADR-001):
- `FOREVERMORE_ROOT` (env > config `forevermoreRoot` > default `../forevermore`) — path to platform checkout
- `AUTOPILOT_DB_URL` — Autopilot's own Postgres connection string

Optional config:
- `autopilot.config.json` (baked-in defaults match it)
- Env overrides: `AUTOPILOT_CONFIG`, `AUTOPILOT_TZ`, `AUTOPILOT_STORE` (`file|postgres`),
  `AUTOPILOT_DRIVER`, `AUTOPILOT_BRAVE`, `AUTOPILOT_LINT_MODULE`, `AUTOPILOT_KILL_SWITCH`

## Seams (injected dependencies)

| Seam | Default (this ticket) | Real impl |
|---|---|---|
| `Store` | `FileStore` | `SupabaseStore` after AP-102 schema push (D-4) |
| `BrainDriver` | `fixture` (zero-dep) | AP-301 `src/brain/` (`--driver mock/claude-cli`) |
| lint fn | no-op (passes) | AP-401 `src/lint/` via `config.lintModule` |
| adapters | Brave/Remotion (AP-203) | — |

## Tests

```bash
node --test        # state machine (incl. illegal), CAS race, plan determinism,
                   # retry/backoff, store, full stubbed pipeline, render.mjs export
```
