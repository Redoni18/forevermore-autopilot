# Autopilot — pipeline core (M0)

The repo-local runner for the Forevermore Autopilot: it **plans** a content
calendar, **generates** copy, **renders** finished media, runs **QA**, and emits
a review **digest** — all against a file-mode store, with a one-command CLI.

This package is tickets **AP-201** (pipeline core + CLI), **AP-103** (store
abstraction), and **AP-203** (renderer adapters). Contracts are normative in
`../marketing/07-autopilot/PRD.md` (§5 ContentItem, §6 state machine, §7
adapters, §8.2 brain driver).

Zero runtime dependencies. Node ≥ 22. ESM. Tests use `node:test`.

## Quickstart

```bash
cd autopilot
node bin/autopilot.mjs doctor              # environment check (Brave/Remotion/claude/ideas/outbox)

# plan the week after a date (deterministic — no model), preview only:
node bin/autopilot.mjs run plan --dry-run --date 2026-07-13

# the M0 loop for a slot day (fixture brain needs no keys/model):
node bin/autopilot.mjs run plan     --date 2026-07-13
node bin/autopilot.mjs run generate --date 2026-07-14           # fixture copy
node bin/autopilot.mjs run render   --date 2026-07-14           # real Brave + Remotion
node bin/autopilot.mjs run qa       --date 2026-07-14           # no-op lint passes (AP-401 = real)
node bin/autopilot.mjs run digest   --date 2026-07-14           # writes digest/2026-07-14.html

# review from the CLI (local station is AP-501):
node bin/autopilot.mjs ls pending_review
node bin/autopilot.mjs show <id>
node bin/autopilot.mjs approve <id> --note "love this"
node bin/autopilot.mjs reject  <id> --reason hook-weak
node bin/autopilot.mjs regen   <id> --note "make the hook harsher"

node bin/autopilot.mjs pause     # engage the kill switch (every stage no-ops)
node bin/autopilot.mjs resume
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

## Layout

```
bin/autopilot.mjs        CLI entry
autopilot.config.json    paths, cadence, timezone (Europe/Tirane), retry, brave
src/config.mjs           config loader (defaults ← file ← env)
src/types.mjs            enums + JSDoc contracts (ContentItem, Store, BrainDriver…)
src/store/               Store abstraction: FileStore (O_EXCL lockfile CAS) + SupabaseStore stub
src/state/machine.mjs    transition table + guards + retry/backoff
src/plan/                ideas mapping + deterministic planner + usage journal
src/stages/              plan · generate · render · qa · digest + registry (kill-switch/idempotency)
src/adapters/            poster · video · capture (AP-203) + proc helpers
src/drivers/             fixture brain + brain-driver seam + no-op lint seam
src/cli/                 arg parser + command handlers
test/                    node --test suite
```

Runtime output (git-ignored): `outbox/<id>/item.json` + `assets/`, `decisions/`,
`runs/` + `logs/*.jsonl`, `digest/`, `state/`, `settings.json`.

## Config & env

`autopilot.config.json` is optional (baked-in defaults match it). Env overrides:
`AUTOPILOT_CONFIG`, `AUTOPILOT_ROOT` (data root), `AUTOPILOT_TZ`, `AUTOPILOT_STORE`
(`file|supabase`), `AUTOPILOT_DRIVER`, `AUTOPILOT_BRAVE`, `AUTOPILOT_LINT_MODULE`,
`AUTOPILOT_KILL_SWITCH`.

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
