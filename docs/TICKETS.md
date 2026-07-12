# Autopilot — execution breakdown

Companion to `PRD.md` (normative for all contracts). 34 tickets across 9 epics.
Every ticket names its **assignee lane** per the fleet policy:

- **opus-developer** — correctness-critical builds (Fable reviews before merge)
- **sonnet-worker** — scoped moderate builds
- **haiku-rapid** — mechanical/boilerplate
- **OWNER** — human-only actions (accounts, tokens, approvals)
- **Fable** — orchestrator work (review gates, prompt craft, integration judgment)

Estimates: S (<½ day) · M (½–1 day) · L (1–3 days). "AC" = acceptance criteria.

Status legend: `[W1 🚀]` = dispatched in wave 1 (this session) · `[ ]` = queued.

---

## Epic A — Control plane (Supabase)

**AP-101 · Storage bucket + media conventions — sonnet-worker · S · [ ]**
Create `autopilot-media` public bucket config (SQL + docs): path scheme
`items/{item_id}/{n}.{ext}`, cache headers, 180-day lifecycle note. Depends: AP-102.
AC: SQL in migration; README section; public URL pattern documented.

**AP-102 · Schema migration `autopilot` — sonnet-worker · M · [W1 🚀]**
Write `supabase/migrations/<ts>_autopilot_schema.sql` implementing PRD §5 DDL
(+ RLS: deny anon/authenticated on all tables; owner read via
`is_admin_self()`-gated RPCs `ap_queue()`, `ap_decide()`, `ap_rules()`), plus
`autopilot/src/db/types.ts` mirroring the DDL. **File header: `-- DO NOT PUSH
— owner review required (D-4)`.** No `supabase db push`.
AC: migration lints (`supabase db lint` if available / SQL syntax check via
node-pg-parse or careful review); types compile; seed SQL inserts settings
defaults (kill_switch=false, autonomy=L1, cadence per PRD §6.2).

**AP-103 · Store abstraction — opus-developer · M · [W1 🚀 inside AP-201]**
`Store` interface (`getItem/putItem/transition(cas)/listByStatus/appendRun/
appendApproval/settings`) with `FileStore` (M0: `autopilot/outbox`,
`decisions/`, `runs/`; lockfile CAS) now and `SupabaseStore` stub compiling
against AP-102 types. AC: unit tests for CAS transition races (two writers, one
wins); identical behavior contract documented.

## Epic B — Pipeline runner

**AP-201 · Pipeline core + CLI — opus-developer · L · [W1 🚀]**
`autopilot/` package (own package.json, Node 22 ESM, no new heavy deps):
state machine per PRD §6.1 (transition table + guards + retry/backoff),
stage registry, `bin/autopilot.mjs` (`run <stage> [--date] [--dry-run]`,
`ls|show|approve|reject|regen|pause|resume|doctor`), config loader
(`autopilot.config.json` + env), structured JSONL run logs. Includes AP-103
FileStore. Stages `plan/generate/render/qa/digest` wired to adapter interfaces
(brain/renderer may be mocked via fixtures where the parallel tickets aren't
merged yet — integration is Fable's AP-801).
AC: `autopilot run plan --dry-run` produces planned shells for D-6 cadence
from `ideas.json` deterministically (no model needed); `doctor` checks Chrome/
remotion/claude-cli presence; unit tests green (`node --test`); README.

**AP-202 · Scheduler templates — haiku-rapid · S · [W1 🚀]**
`ops/launchd/*.plist` (per timetable PRD §6.2), `ops/github/autopilot.yml`
(GHA cron matrix, secrets doc, `npx remotion browser ensure`, pnpm cache),
`Makefile` (`make plan generate digest publish doctor`), `.env.example`,
`RUNBOOK.md` skeleton. AC: plists pass `plutil -lint`; workflow passes
`actionlint` if present (else YAML-parse check); every env var in README table.

**AP-203 · Renderer adapters — opus-developer · M · [W1 🚀 inside AP-201 scope note]**
Refactor `marketing/04-assets/render.mjs` to export `renderOne(job)` (CLI
behavior unchanged — existing JOBS array still works byte-identical) +
`autopilot/src/adapters/poster.ts`, `video.ts` (remotion render w/ `--props`,
EndCard concat via bundled ffmpeg), `capture.ts` (library-first per PRD §7.2;
live capture behind `--live` flag). JPEG conversion for IG images.
AC: golden test renders one poster + one 6s HookCard video into a temp item
dir with sha256s recorded; `render.mjs` regression: existing 17 jobs still
render (spot-check 3 outputs dimensions).

**AP-204 · Capture library builder — sonnet-worker · M · [ ] (needs dev server)**
`autopilot library build` — walks capture-guide's b-roll checklist, boots
experience app, records master takes to `autopilot/library/{world}.mp4` with a
manifest (duration, beats). Depends: AP-201. AC: manifest schema; resumable;
skips existing; 3 worlds recorded in CI-less local proof run.

## Epic C — Brain

**AP-301 · Brain harness + stage prompts — opus-developer · L · [W1 🚀]**
`BrainDriver` interface per PRD §8.2 with `claude-cli` driver (spawn `claude -p
--output-format json`, JSON-schema validation via ajv-or-hand-rolled, retry ×2
on invalid, temperature via prompt), `mock` driver (fixtures), `agent-sdk`
driver stub. Prompt files `prompts/{planner,copywriter,artdirector,regen,
reflect,suggestions}.md` assembled per PRD §8.1 layering (brand-guide + rules +
task), with prompt-sha logging. Copywriter must emit the ContentItem copy
fields exactly (caption/hashtags/overlays) per PRD §5 contract.
AC: `autopilot run generate --driver mock` yields 3 valid candidates for a
planned slot; `--driver claude-cli` produces schema-valid output in a live
smoke run (1 candidate) using the installed CLI; invalid-JSON path covered by test.

**AP-302 · OverlayReel Remotion comp — sonnet-worker · M · [ ]**
New comp in `marketing/05-video-studio`: `<OffthreadVideo>` library clip +
timed overlay chips (hook 0–3s, beats, CTA) + EndCard tail; props =
`{clip, overlays[], cta}`. Gum-press chip styling from `gum.tsx`. Depends:
AP-204 for clips (test with existing social-video mp4s meanwhile).
AC: renders a 22s 1080×1920 reel from props in one command; stills verified.

**AP-303 · Reflection + suggestion parsing — opus-developer · M · [ ] (M2)**
Nightly-lite/weekly-full reflect stage per PRD §8.4: evidence gathering
queries, proposal JSON contract, report markdown, `owner_notes` parser
(haiku-class call) → structured directives consumed by planner. Depends:
AP-201, AP-301, metrics (AP-703). AC: fixture-driven tests: 3 rejections with
same reason tag ⇒ exactly one proposal citing all three; contradiction case
proposes retirement; no proposal below evidence threshold.

**AP-304 · Bandit mix — sonnet-worker · M · [ ] (M2)**
Thompson sampler over pillar×format arms + constraint filler per PRD §6.3;
win/loss updater from metrics quartiles + approvals. Pure functions + tests
(seeded RNG). AC: cold-start uses ideas.json priors; floors/ceilings honored
across 1000 sampled weeks (property test).

## Epic D — QA

**AP-401 · Lint engine — sonnet-worker · M · [W1 🚀]**
`autopilot/src/lint/` — rules compiled from brand-guide (banned lexicon w/
word-boundary + case rules, price law regex, off-limits claim patterns, noun
law, sentence-case heuristic for overlays, hashtag counts, caption length,
UTM check, world-active check against `packages/templates` manifests via the
catalog JSON, asset spec checks incl. JPEG-for-IG + duration bounds + TikTok
safe-area geometry given overlay coords). Severity: `block|warn`. CLI:
`autopilot lint <item.json>`.
AC: ≥25 unit cases incl. tricky negatives ("unlock the vault" as literal
mechanic → still blocked per guide; "journey" blocked; "$40 credit pack"
allowed in learning docs but **blocked in captions** — captions may only carry
$15/$45/from $250); lint report shape matches PRD §5 `lint` field.

**AP-403 · Price↔tier lint cross-check — sonnet-worker · S · [ ] (wave 2)**
Follow-up from AP-301's live smoke: when a caption/overlay states $15 or $45
AND references exactly one world, warn (not block) if the price doesn't match
that world's catalog tier ($15↔standard, $45↔premium). Must not false-positive
on two-world/two-price comparison content ("$15 vs $45"). Extend
world-checks rule family + tests. AC: 6 cases incl. the comparison negative.

**AP-402 · Visual QA stage — sonnet-worker · M · [ ]**
Frame extraction (bundled ffmpeg) + art-director brain call with a strict
verdict schema; safe-area overlay debug image for failures. Depends: AP-301,
AP-203. AC: seeded broken fixtures (clipped text, stretched poster) fail;
clean fixtures pass; verdicts logged to `lint.visual`.

## Epic E — Review surfaces

**AP-501 · Local review station (M0) — sonnet-worker · M · [W1 🚀]**
`autopilot review` → serves a local page (same pattern as ideas.html: vanilla
JS + Gum-press tokens) listing pending items grouped by candidate_group with
media preview, caption edit-in-place, approve/reject with reason chips + note;
writes `approvals` via FileStore endpoints (tiny node server, localhost only).
AC: full keyboard flow (a/e/r/n); decisions persist and transition items;
works against fixture outbox committed as test data.

**AP-502 · Atlas Studio (M1) — opus-developer · L · [ ]**
New admin section in `apps/atlas` per PRD §10.1 behind existing `is_admin_self`
gate, talking to AP-102 RPCs. Queue/Calendar/Playbook/Settings tabs.
Depends: AP-102 pushed (D-4), AP-101. AC: e2e happy path against staging
schema; no service-role key in client; playbook approve flips rule status.

**AP-503 · Resend digest + signed action links (M1) — sonnet-worker · M · [ ]**
Digest stage: email template (poster thumbs inline via bucket URLs), HMAC
one-shot links per PRD §10.2, CF endpoint `/api/ap/act` (in autopilot-cron
worker or dashboard server route) burning nonces + writing approvals; evening
reminder; failure alerts. Depends: AP-102, AP-101, AP-601. AC: link replay
rejected; expiry honored; `sensitive` items render without action links.

## Epic F — Publishing

**AP-601 · autopilot-cron CF worker — sonnet-worker · S · [ ]**
`infra/autopilot-cron/` cloned from emails-sweep-cron: cron triggers per
timetable → bearer webhook to runner (Mac: tailscale/funnel URL optional; GHA:
`workflow_dispatch` REST call) + hosts `/api/ap/act`. Depends: AP-503 design.
AC: wrangler config validates; dry deploy documented; secrets listed.

**AP-602 · IG publisher — opus-developer · L · [ ] (M1, needs AP-701)**
`adapters/publish/instagram.ts`: bucket upload → container create (image/
carousel/reel/story) → status poll → publish → `post_results`; error taxonomy
per PRD §9.1; `content_publishing_limit` pre-check; token-refresh job + expiry
alert. AC: sandbox run posts to a test IG account end-to-end; idempotent
re-run does not double-post (creation-id persisted before publish call);
unit tests with recorded HTTP fixtures.

**AP-603 · TikTok inbox publisher — opus-developer · M · [ ] (M1, needs AP-702)**
`adapters/publish/tiktok.ts`: OAuth refresh, `inbox/video/init` PULL_FROM_URL
(chunked FILE_UPLOAD fallback), status poll, `post_results(publish_mode=
'tiktok_inbox')`, digest copy explains the in-app finish step. AC: draft
arrives in a test account inbox; status transitions recorded; retry-safe.

**AP-604 · Publish reconciliation invariant — haiku-rapid · S · [ ] (M1)**
Nightly job + `doctor` check: every post_result joins an approval; alert on
violation; L2 lanes validated against standing lane-approvals. AC: seeded
violation fixture alerts.

## Epic G — Metrics & learning data

**AP-701 · Meta app + tokens — OWNER (guided doc by sonnet-worker) · M · [ ]**
Step-by-step with screenshots: professional account, page link, dev-mode app,
system-user token, .env entries, `doctor` verification. AC: `autopilot doctor`
shows IG token valid + ig-user-id resolved.

**AP-702 · TikTok developer app — OWNER (guided doc by sonnet-worker) · M · [ ]**
Login Kit + Content Posting API, scopes, one-time OAuth, refresh storage.
AC: `doctor` shows TikTok token valid; test inbox upload succeeds.

**AP-703 · IG metrics ingestor — sonnet-worker · M · [ ] (M2)**
Media insights pulls at 24h/72h/7d (reach, plays, likes, comments, saves,
shares, avg watch time where available) → `metrics_snapshots`; follower
snapshot daily. AC: fixtures→rows; missing-permission degrades gracefully.

**AP-704 · TikTok CSV import — haiku-rapid · S · [ ] (M2, until API access)**
`autopilot metrics import <csv>` mapping TikTok Studio export columns; drop
folder watch on runner. AC: sample CSV lands as snapshots keyed to items by
posted date+caption fuzzy match with manual override file.

**AP-705 · Weekly report — sonnet-worker · M · [ ] (M2)**
`report` stage: md + email — posts ran, winners/losers vs trailing median,
mix vs plan, rule proposals, next-week plan, cost rollup. Depends: AP-303/304.
AC: renders from fixtures; numbers reconcile with snapshots.

**AP-706 · TikTok direct-post audit — OWNER · M · [ ] (M3)**
Apply for audit; flip publish_mode by risk class post-approval.

## Epic H — Hardening & ops

**AP-801 · Wave-1 integration + review gate — Fable · M · [ ] (after W1 lands)**
Merge W1 branches conceptually (they share only the PRD §5 contract), run the
M0 end-to-end (`plan → generate(mock) → render → qa → review → approve`),
fix seams, write `autopilot/README.md` quickstart, tag v0. AC: M0 demo run
recorded in runs/; contract deviations reconciled back into PRD.

**AP-802 · Golden-path CI — haiku-rapid · S · [ ]**
GH workflow: lint engine tests, pipeline unit tests, mock-driver generate,
one poster render (ubuntu chrome), remotion HookCard 2s render. AC: green on
a clean checkout without secrets.

**AP-803 · Live smoke (M0 exit) — Fable + OWNER · S · [ ]**
7-day M0 trial per PRD §12 exit criteria; findings feed first playbook seeds.

**AP-804 · Security pass — opus-developer · M · [ ] (pre-M1 deploy)**
Review: RLS coverage, HMAC link scheme, token storage, SSRF on PULL_FROM_URL,
bucket exposure scope, admin-gate paths. AC: findings fixed or waived in writing.

## Epic I — Owner setup (non-engineering)

**AP-901 · Claim @getforevermore on TikTok + Instagram — OWNER · S** (blocks all publishing)
**AP-902 · Convert IG to Professional + link FB page — OWNER · S** (blocks AP-701)
**AP-903 · Approve D-4 schema push — OWNER · S** (blocks M1 epics)
**AP-904 · Pick runner host for M1 (D-1) — OWNER · S**
**AP-905 · Resolve privacy-page vs pixels wording — OWNER · S** (blocks any future pixel work; UTM-only until then)
**AP-906 · Record capture-library b-roll afternoon (with AP-204) — OWNER · M**

---

## Waves

**Wave 1 — ✅ LANDED 2026-07-12 (all six tickets, 239/239 package tests):**
AP-201(+103+203) → opus · AP-301 → opus · AP-102 → sonnet · AP-401 → sonnet ·
AP-501 → sonnet · AP-202 → haiku. Shared normative contract: PRD §5 ContentItem
+ §6.1 states. Fable reviewed all six (AP-801).

AP-801 reconciliations applied: approvals.decision + DECISIONS gained
'changes_requested' (4 values); REASON_TAGS gained 'other'; approvals.via
gained 'local-station'; runs.stage CHECK gained 'report' + 'transition';
overlays carry cta inside; planner off-list sentinel id "OFFLIST"; copywriter
selfcheck = telemetry only; plan emits candidate-shells (3/slot, stable ids);
lint wired via src/drivers/brand-lint.mjs bridge (catalog + store-built
corpus, sibling-candidate exclusion, dedupe persisted by qa). Follow-up
tickets minted: AP-403.

**Wave 2 — after W1 review + owner decisions (D-4, AP-901/902):**
AP-101, AP-502, AP-503, AP-601, AP-602, AP-603, AP-604, AP-204, AP-302, AP-402, AP-802.

**Wave 3 — M2 learning:** AP-303, AP-304, AP-703, AP-704, AP-705, AP-804, AP-803.

**Wave 4 — M3 trust:** AP-706, L2 lane config, anomaly guard, comment-triage drafts (ticketed at M2 review).

## Dependency spine

```
AP-201 ──┬─▶ AP-501 ─▶ AP-801 ─▶ M0 exit (AP-803)
AP-301 ──┤
AP-401 ──┤
AP-203 ──┘
AP-102 ─▶ (D-4 push) ─▶ AP-101 ─▶ AP-502/503/601 ─▶ AP-602/603 ─▶ M1 exit
AP-701/702 (owner) ────────────────────┘
metrics (AP-703/704) ─▶ AP-303/304 ─▶ AP-705 ─▶ M2 exit
```
