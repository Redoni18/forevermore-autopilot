# PRD — Forevermore Autopilot
### The autonomous marketing employee

Version 1.0 · 2026-07-12 · Author: Fable (orchestrator) · Status: DRAFT for owner review
Companions: `TICKETS.md` (execution breakdown), `../README.md` (the marketing kit this system operates).

---

## 0. Executive summary

Autopilot is an AI employee that runs Forevermore's TikTok + Instagram presence
end-to-end: it plans a content calendar, generates finished posts (copy +
rendered images/video) in the brand's locked design system, queues them for a
60-second human review, publishes the approved ones to the channels on
schedule, ingests performance data, and rewrites its own playbook from what it
learns — owner feedback weighing heaviest.

The human role shrinks to: **review, react, redirect.** Everything else —
ideation, production, QA, scheduling, publishing, measurement, reflection — is
the system's job.

We are not starting from zero. This session already produced Autopilot's
entire "content brain" as static artifacts: a machine-checkable brand law
(`marketing/00-brand/brand-guide.md`), a scored 137-idea database with a stable
JSON schema, 10 parameterized poster templates + a headless render pipeline,
a Remotion video studio, a world-capture recorder, and platform playbooks.
Autopilot v1 is chiefly **plumbing + a loop** around assets that already exist
and work.

### Autonomy ladder (the product's core dial)

| Level | Name | Behavior | Default |
|---|---|---|---|
| L0 | Dry run | Generates candidates; never publishes; owner exports manually | M0 |
| L1 | Copilot | Publishes **only** explicitly-approved items; TikTok goes to in-app inbox (owner taps post) | **v1 default** |
| L2 | Trusted lanes | Auto-publishes whitelisted low-risk format classes (cap 1/day) when lint + anomaly checks pass; everything else L1 | M3 opt-in |
| L3 | Full auto | Publishes everything passing gates; owner reviews weekly | future, explicit opt-in only |

A global **kill switch** (`settings.kill_switch`) halts every stage within one
scheduler tick at any level.

---

## 1. Goals / non-goals

### Goals (v1, ≈ M0–M2)
1. **Daily freshness:** ≥1 finished, on-brand post candidate per channel per day, ready before 08:00 local, with 3 candidates per slot to pick from.
2. **≤10 min/day of human time:** approve/reject/edit from a queue (web) or the morning email digest; suggestions typed in free text become structured feedback.
3. **Native publishing:** Instagram feed/carousel/Reels published via Graph API on approval; TikTok delivered to the account's in-app inbox (draft) — the owner's "post" tap doubles as final approval.
4. **Closed learning loop:** every approval, rejection reason, caption edit, and metric snapshot lands in a store; a nightly reflection turns them into proposed playbook rules; approved rules change future generation; a weekly bandit re-weights the content mix.
5. **Total auditability:** every artifact traces to a run (model, prompt hash, tokens, cost), every publish to an approval, every playbook rule to evidence.

### Non-goals (v1)
- Comment/DM replies (M3: draft-only triage).
- Paid-ads management (Spark boosting stays manual; system *recommends* boost candidates).
- New channels (YouTube Shorts/Pinterest are format-compatible later).
- Filming humans; UGC ingestion beyond a manual "drop folder".
- Fine-tuning models. Learning = context/rules/weights, not weights-of-model.

---

## 2. What exists today (build on, don't rebuild)

| Capability | Asset | Reuse in Autopilot |
|---|---|---|
| Brand law | `00-brand/brand-guide.md` (claims table, banned words, OFF-LIMITS claims, visual tokens) | Compiled into the deterministic lint engine (§8.4) + injected into every generation prompt |
| Idea supply | `02-idea-database/ideas.json` — 137 ideas, schema: id/title/pillar/platform/format/funnel/occasions/worlds/hook/beats/cta/assets/effort/impact/confidence/score | Seeds `ideas` table; bandit arms derive from pillar × format |
| Static assets | `04-assets/posters/*` (10 param templates) + `render.mjs` (headless Brave, HTTP-served, JOBS array) | Renderer adapter calls it with per-item params |
| Video | `05-video-studio` (Remotion 4.0.484, installed node_modules incl. chrome-headless-shell + bundled ffmpeg); comps: LogoSting/HookCard/WorldMontage/HowItWorks/EndCard; HookCard + LogoSting accept props | `remotion render --props` per item; EndCard appended via ffmpeg concat |
| Product footage | `04-assets/capture-world.mjs` (dev-route → 1080×1920 mp4) + `03-content/capture-guide.md` route map | Capture adapter (requires experience dev server; see §7.3 runner reqs) |
| Editorial packs | 20 scripts, IG pack, ads pack | Few-shot exemplars in prompts; series definitions |
| Infra patterns | `infra/emails-sweep-cron` (CF cron worker → bearer-token internal endpoint), Resend, Supabase (prod-direct, migrations `YYYYMMDDHHMMSS_*.sql`), atlas admin gate (`is_admin_self` RPC), CF Pages/Workers | Scheduler trigger, digest email, control-plane DB, review UI host, publisher worker |
| Agent runtime | `@anthropic-ai/claude-agent-sdk@^0.3.203` already in `apps/builder`; `claude` CLI 2.1.205 on the owner's machine (subscription auth; `claude setup-token` yields `CLAUDE_CODE_OAUTH_TOKEN` for CI) | Brain harness (§8.2) supports both drivers |

---

## 3. Personas & core user stories

**Owner-operator (Redoni)** — solo founder, technical, time-poor.
1. *Morning:* opens digest email at 07:30 → sees tomorrow's 3 candidates per slot with previews → taps ✅ on one, ✍️ "make the hook harsher" on another → done by coffee.
2. *Anytime:* types "we're leaning into Father's Day next 2 weeks, more Gone Fishing/Matchday" into the queue's suggestion box → next planning run rebalances and confirms what changed.
3. *Weekly:* reads the Monday report: what ran, what performed, which rules the system wants to adopt ("hooks that name the recipient outperform by 2.1× — adopt?") → approves rules with one click.
4. *Always:* can hit pause; can see why any post exists (idea → run → approval chain).

**The employee (Autopilot)** — plans, produces, asks for sign-off, publishes, measures, learns; never violates brand law even when a "learning" suggests it (law changes require the owner).

---

## 4. System architecture

### 4.1 Component map

```
                        ┌────────────────────────────────────────────────┐
                        │            CONTROL PLANE (Supabase)            │
                        │  schema: autopilot                             │
                        │  content_items · runs · approvals · metrics    │
                        │  playbook_rules · ideas · settings · accounts  │
                        │  + Storage bucket: autopilot-media (public)    │
                        └───────▲──────────────▲──────────────▲──────────┘
                                │              │              │
                 service-role   │              │ signed-link  │ service-role
                                │              │ actions      │
┌─────────────┐  webhook  ┌─────┴──────┐  ┌────┴─────┐  ┌─────┴──────┐
│ CF Worker   │──────────▶│  RUNNER    │  │ REVIEW   │  │ PUBLISHER  │
│ autopilot-  │  (bearer) │  (Node 22, │  │ SURFACES │  │ (CF Worker │
│ cron        │           │  repo ckt, │  │ atlas    │  │  or runner │
│ (schedules) │           │  Chrome,   │  │ Studio + │  │  stage)    │
└─────────────┘           │  Remotion) │  │ Resend   │  └─────┬──────┘
                          │            │  │ digest   │        │
                          │ stages:    │  └──────────┘   IG Graph API
                          │ plan       │                 TikTok Content API
                          │ generate ──┼── BRAIN (claude -p / Agent SDK)
                          │ render  ───┼── marketing/04-assets/render.mjs
                          │ qa      ───┼── lint engine + visual check
                          │ digest     │   marketing/05-video-studio
                          │ publish    │   marketing/04-assets/capture-world.mjs
                          │ metrics    │
                          │ reflect    │
                          └────────────┘
```

### 4.2 Where things run (decision D-1, recommendation inline)

Rendering (headless Chrome, Remotion, optional Nuxt dev server for captures)
cannot run on CF Workers. The **runner** is a plain Node process executing
`autopilot run <stage>` with a repo checkout:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Owner's Mac (launchd)** | Everything already works (Brave, repo, `claude` subscription auth, zero new secrets); $0 | Mac must be awake at run times; single point of failure | **M0–M1 default** |
| **B. GitHub Actions (cron)** | Free tier ample (~30 min/day); secrets store; survives laptop-closed | Needs `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) or `ANTHROPIC_API_KEY`; Remotion-on-Ubuntu needs `npx remotion browser ensure`; capture stage must boot experience app (~60s) | **M1+ recommended** |
| C. VPS/Docker | Always-on | $6–12/mo + ops | only if B chafes |

The CF cron worker (`infra/autopilot-cron`, mirroring `emails-sweep-cron`)
fires stage webhooks on schedule; the runner also self-schedules via launchd/
GHA cron so the worker is a redundancy trigger, not a hard dependency.
Publishing (pure HTTPS) can run either in the runner or as a CF Worker stage —
v1 keeps it in the runner for a single code path.

### 4.3 Trust boundaries & secrets

| Secret | Holder | Notes |
|---|---|---|
| Supabase service-role key | runner + publisher only | never in atlas client; RLS: `autopilot` schema denies `anon`/`authenticated` except owner-gated RPCs |
| Meta long-lived token / system-user token | runner env (`META_IG_TOKEN`) | dev-mode app, owner-role account only (§9.1) |
| TikTok client key/secret + refresh token | runner env | inbox scope only until audited |
| Resend key | already provisioned | digest + alerts |
| HMAC secret for approval links | CF review endpoint + digest generator | links: `itemId.decision.exp.sig`, 48h TTL, one-shot (nonce table) |
| Claude auth | Mac: subscription session; CI: `CLAUDE_CODE_OAUTH_TOKEN` | per-run token/cost logged to `runs` |

---

## 5. Control-plane data model (Supabase, schema `autopilot`)

Full DDL is ticket AP-102; the contract:

```sql
create type ap_platform as enum ('instagram','tiktok');
create type ap_format as enum ('reel','carousel','image','story','tiktok_video');
create type ap_status as enum (
  'planned','drafting','drafted','rendering','rendered','qa_failed',
  'pending_review','changes_requested','approved','scheduled',
  'publishing','published','publish_failed','skipped','measured','archived');
create type ap_risk as enum ('evergreen','standard','sensitive');  -- sensitive = memorial/kids/UGC → never auto

create table autopilot.ideas (
  id text primary key,                 -- F01/A17/B23… (mirrors ideas.json)
  payload jsonb not null,              -- full idea object, source of truth stays git; this is the runtime copy
  pillar text not null, format_family text not null,
  active boolean default true,
  attempts int default 0, wins int default 0, losses int default 0,
  last_used_at timestamptz);

create table autopilot.content_items (
  id uuid primary key default gen_random_uuid(),
  slot_at timestamptz not null,        -- intended publish moment
  platform ap_platform not null,
  format ap_format not null,
  idea_id text references autopilot.ideas(id),
  series_key text,                     -- 'world-tours', 'ranked-by-tears' … episode continuity
  pillar text, risk ap_risk not null default 'standard',
  status ap_status not null default 'planned',
  candidate_group uuid,                -- N candidates for one slot share this
  chosen boolean default false,
  caption text, hashtags text[], overlays jsonb, link_utm text,
  assets jsonb,                        -- [{kind:poster|video|capture, path, storage_url, w, h, dur_s, sha256}]
  lint jsonb,                          -- {passed, violations:[{rule,severity,excerpt}]}
  dedupe jsonb,                        -- {hook_sim: 0.31, nearest_item, method}
  produced_by uuid references autopilot.runs(id),
  attempt int default 1, regen_of uuid references autopilot.content_items(id),
  created_at timestamptz default now(), updated_at timestamptz default now());
create index on autopilot.content_items (status, slot_at);
create index on autopilot.content_items (candidate_group);

create table autopilot.runs (
  id uuid primary key default gen_random_uuid(),
  stage text not null,                 -- plan|generate|render|qa|digest|publish|metrics|reflect
  status text not null default 'running',  -- running|ok|failed
  driver text,                         -- claude-cli|agent-sdk|deterministic
  model text, prompt_sha text,
  tokens_in int, tokens_out int, cost_usd numeric(8,4),
  started_at timestamptz default now(), finished_at timestamptz,
  error text, log_path text);

create table autopilot.approvals (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references autopilot.content_items(id),
  decision text not null check (decision in ('approved','rejected','edited')),
  reason_tags text[],                  -- ['hook-weak','off-voice','wrong-world','too-salesy','timing','duplicate']
  note text,                           -- free text — reflection input
  caption_diff jsonb,                  -- {before, after} when edited
  via text not null,                   -- 'atlas'|'email-link'|'cli'
  decided_at timestamptz default now());

create table autopilot.post_results (
  content_item_id uuid primary key references autopilot.content_items(id),
  platform_post_id text, permalink text,
  publish_mode text not null,          -- 'ig_api'|'tiktok_inbox'|'tiktok_direct'|'manual'
  posted_at timestamptz, raw jsonb);

create table autopilot.metrics_snapshots (
  id bigint generated always as identity primary key,
  content_item_id uuid references autopilot.content_items(id),
  captured_at timestamptz default now(),
  views int, likes int, comments int, shares int, saves int,
  avg_watch_ms int, completion_rate numeric(5,4), reach int, follows int,
  source text not null,                -- 'ig_api'|'tiktok_csv'|'manual'
  raw jsonb);

create table autopilot.playbook_rules (
  id uuid primary key default gen_random_uuid(),
  rule text not null,                  -- imperative, prompt-injectable
  category text not null,              -- hook|caption|format|timing|world|visual
  status text not null default 'proposed',  -- proposed|active|retired
  source text not null,                -- 'owner'|'reflection'
  evidence jsonb,                      -- [{content_item_id, metric, value}] or approval ids
  weight int default 5,                -- 1..10 injection priority
  created_at timestamptz default now(), decided_at timestamptz);

create table autopilot.owner_notes (   -- free-form "suggestions" inbox
  id uuid primary key default gen_random_uuid(),
  text text not null, applies_from date, processed boolean default false,
  created_at timestamptz default now());

create table autopilot.settings (      -- kv: kill_switch, autonomy_level, cadence,
  key text primary key, value jsonb, updated_at timestamptz default now());

create table autopilot.link_nonces (   -- one-shot email action links
  sig text primary key, used_at timestamptz);
```

**File-mode mirror (M0):** before the schema ships, the identical shapes live
as JSON files under `autopilot/outbox/{item-id}/item.json` + `decisions/` —
the store is an interface (`FileStore | SupabaseStore`) so M0→M1 is a config
flip, not a rewrite. This contract is normative for all wave-1 tickets:

```jsonc
// autopilot/outbox/<id>/item.json  — ContentItem v1 (M0 file mode)
{
  "id": "ci_20260713_ig_1",
  "slot_at": "2026-07-14T17:30:00+02:00",
  "platform": "instagram",            // instagram | tiktok
  "format": "reel",                   // reel | carousel | image | story | tiktok_video
  "idea_id": "F03",
  "series_key": null,
  "pillar": "P4",
  "risk": "standard",
  "status": "pending_review",
  "candidate_group": "cg_20260713_ig",
  "caption": "he ignores me for minecraft, so i said it in his language…",
  "hashtags": ["giftideas","gamercouple","anniversarygift"],
  "overlays": { "hook": "he'd rather mine blocks than answer my texts", "beats": ["so i met him there."], "cta": "the blockheart mine · getforevermore.co" },
  "assets": [{ "kind": "video", "path": "assets/final.mp4", "w": 1080, "h": 1920, "dur_s": 22, "sha256": "…" }],
  "lint": { "passed": true, "violations": [] },
  "dedupe": { "hook_sim": 0.18, "nearest_item": "ci_20260701_tt_2" },
  "produced_by": "run_…", "attempt": 1
}
```

---

## 6. The content pipeline (state machine)

### 6.1 Stages & transitions

```
planned → drafting → drafted → rendering → rendered → (qa) ─┬→ pending_review
                                                            └→ qa_failed → drafting (attempt+1, max 3) → skipped
pending_review ─┬→ approved → scheduled → publishing ─┬→ published → measured → archived
                ├→ changes_requested → drafting (regen with feedback, max 2)
                └→ rejected(skipped)                   └→ publish_failed → publishing (retry ×3, backoff 2^n·5m) → alert
```

Rules:
- Transitions are **idempotent** and guarded by `status` CAS updates (or file
  locks in M0) — a re-fired cron never double-produces or double-posts.
  Publish additionally guards on `post_results` existence + platform-side
  idempotency (IG creation_id reuse; TikTok publish_id check).
- Every transition writes a `runs` row; failures carry `error` + log path.
- `slot_at - 24h`: candidates must be `pending_review`. `slot_at - 2h`: if
  nothing approved for a slot → digest reminder; slot lapses to `skipped`
  (never auto-posts to fill a hole at L1).
- `sensitive` risk items require `via='atlas'` approval (no one-tap email).

### 6.2 Daily timetable (owner-local TZ, `settings.cadence`)

| Time | Stage | What |
|---|---|---|
| Sun 18:00 | `plan` | Build next week's slot plan: occasion calendar + series continuity + bandit mix → `planned` items (empty shells with pillar/format/platform/slot) |
| Daily 05:30 | `generate`+`render`+`qa` | Fill T+1's slots: 3 candidates each; full assets; lint; dedupe |
| Daily 07:30 | `digest` | Resend email + queue ready; Atlas Studio badge |
| Daily 17:00–21:00 | `publish` | Post approved items at their `slot_at` (±10 min jitter) |
| Daily 22:00 | `metrics` | IG insights pull for items ≥24h/72h/7d old; TikTok CSV import if present |
| Daily 23:00 | `reflect` (lite) | Process new approvals/notes → proposed rules if evidence ≥ threshold |
| Mon 07:00 | `report` | Weekly report email + `reports/2026-Wxx.md`; bandit re-weight; rule proposals digest |

### 6.3 Planning algorithm (deterministic core + model garnish)

1. **Hard constraints:** occasion calendar (from strategy §7 + `owner_notes`),
   series cadence (e.g. world-tours weekly), platform mix floors (≥2 IG
   carousels/wk, ≥4 TikToks/wk), quiet days, max 1/day/channel at L1.
2. **Bandit mix:** Thompson sampling over arms = pillar × format_family.
   Arm posterior Beta(1+wins, 1+losses); *win* = item in top quartile of
   trailing-30d completion (video) or save-rate (carousel), or owner reaction
   "loved"; *loss* = bottom quartile or rejection. Cold-start priors seeded
   from `ideas.json` scores. Constraint solver fills slots maximizing sampled
   values under (1).
3. **Idea selection:** per slot, top-k ideas matching (pillar, format,
   occasion window, world-active check against the template catalog) scored by
   `idea.score × recency_penalty (last_used_at) × novelty (dedupe)`; the brain
   picks 3 and may propose 1 off-list idea/day (sentinel `idea_id:"OFFLIST"`
   in planner output; the pipeline mints a real idea row on first approval —
   this is how the idea DB grows).

   Contract clarifications (reconciled after AP-301): `overlays` carries
   `{hook, beats[], cta}` — cta lives INSIDE overlays; the copywriter's
   `selfcheck` block is telemetry only, never a gate (AP-401 lint is the
   gate); lint additionally cross-checks any stated price against the
   referenced world's catalog tier ($15↔standard, $45↔premium), not just
   membership in the allowed set.

---

## 7. Production subsystem (assets)

### 7.1 Poster path (images/carousels)
Adapter `renderPoster(params) → png` shells the existing server+screenshot
core of `marketing/04-assets/render.mjs` (refactor ticket AP-203 extracts
`renderOne()` so JOBS stays a CLI concern). JPEG conversion for IG (Graph API
requires JPEG) via the studio's bundled ffmpeg. Carousels = N calls to
`carousel-slide.html` variants.

### 7.2 Video path
- **Kinetic/branded:** `remotion render src/index.ts HookCard --props='{"line":…}'`
  (HookCard/LogoSting/EndCard are already prop-driven); concat EndCard via
  ffmpeg concat demuxer (same codec settings, no re-encode).
- **Product footage:** `capture-world.mjs <dev-route> <s>` — requires the
  experience app: runner boots `pnpm dev:experience` on demand (health-check
  3001, 90s timeout) or maintains a **capture library** (`autopilot/library/`)
  of pre-recorded 60–90s master takes per world (M0 approach: batch-record the
  b-roll checklist once; generation composes text overlays over library clips
  via Remotion `<OffthreadVideo>` — cheaper, deterministic, no dev server in
  the daily path). **Recommendation: library-first**, live capture as a weekly
  refresh job.
- Text-overlay composition: new Remotion comp `OverlayReel` (video + timed
  overlay chips + end card) — ticket AP-302.

### 7.3 QA gates (order matters; each writes to `lint`)
1. **Deterministic lint** (AP-401): banned words/regexes; price law
   (`$15|$45|from $250` only); off-limits claims (scheduled delivery, keepsake
   download, replies, "forever" guarantees); noun law (world/gift); sentence-case
   heuristic; hashtag count ≤5 TikTok / ≤10 IG; caption length; UTM present;
   world `isActive` check; asset specs (dims, duration 6–90s, file size, JPEG
   for IG images).
2. **Dedupe:** hook 4-gram Jaccard vs trailing 90 days (block >0.55, warn >0.4);
   M2 upgrade: pgvector cosine on caption embeddings.
3. **Visual QA (model):** screenshot/frames → brain checks: nothing clipped,
   chips uppercase-small only, sentence case, poster not distorted, text
   inside safe areas (TikTok UI gutters: bottom 320px, right 140px). Fails →
   `qa_failed` with reasons fed back to regen.

---

## 8. The brain

### 8.1 Stage-agent design (one narrow agent per stage, not one god-agent)

| Agent | Duty | Model class | Budget/run |
|---|---|---|---|
| Planner | weekly slots + idea shortlists (garnish over deterministic core) | mid (Sonnet-class) | ~20k in / 2k out |
| Copywriter | caption + hook + overlays + hashtags for one candidate; 3 variants | mid | ~25k in / 3k out |
| Art director | poster/video param selection; visual QA verdicts | mid (vision) | ~15k in / 1k out |
| Regenerator | apply `changes_requested` feedback | mid | ~20k in / 2k out |
| Reflector | nightly rules proposals; weekly report narrative | **top (Opus-class)** | ~40k in / 4k out |
| Suggestion parser | `owner_notes` → structured directives | small (Haiku-class) | ~5k |

Prompt = layered context, cached-prefix-friendly, stable order:
`[brand-guide §voice+claims] + [active playbook_rules by weight] + [format spec] + [idea payload + world facts] + [recent-post digest (dedupe)] + [task]`.
Prompt files live in `autopilot/prompts/*.md`, hashed into `runs.prompt_sha`.

### 8.2 Driver abstraction (decision D-2)

```ts
interface BrainDriver { complete(req: StageRequest): Promise<StageResult> }  // JSON-schema-validated output
```
- **`claude-cli` driver (M0 default):** `claude -p --output-format json
  --allowedTools "Read"` with prompt file — runs on the owner's subscription
  auth on the Mac; zero new keys; JSON contract enforced by retry-on-invalid.
- **`agent-sdk` driver (M1):** `@anthropic-ai/claude-agent-sdk` `query()` with
  structured output + tool allowlist — needed for CI (`CLAUDE_CODE_OAUTH_TOKEN`
  from `claude setup-token`, or `ANTHROPIC_API_KEY`) and for per-call model
  routing. Same `StageRequest/StageResult` types; golden tests run against a
  `mock` driver with fixtures.

### 8.3 Cost model (L1 steady state)
Per day: 2 slots × 3 candidates × (copywriter+art-director) + qa + digest ≈
10–14 mid-class calls (~300k in / 30k out) + nightly reflect-lite. On
subscription (Mac driver): $0 marginal. On API keys: ≈ $1.20–2.50/day
mid-class + ~$0.60/day reflection amortized ⇒ **< $90/mo ceiling**; logged
per-run in `runs.cost_usd`, weekly rollup in the report.

### 8.4 Learning loop — signals → memory → behavior

**Signals** (weights): owner rejection/edit with reason (1.0) > owner note
(0.9) > approval-without-edit (0.4) > metric win/loss (0.3, needs n≥3 before
influencing rules).

**Memory tiers:**
1. `playbook_rules` (natural language, prompt-injected; owner approves
   `proposed→active`; reflection may propose retirement with counter-evidence).
2. Bandit posteriors (numeric mix weights; §6.3).
3. Idea stats (attempts/wins/losses → selection score).
4. Immutable tier: brand law + platform compliance — reflection may *propose*
   lint additions, never mutate lint config directly.

**Reflection contract (nightly-lite / weekly-full):** input = new approvals,
notes, metric snapshots; output = JSON `{proposals:[{rule, category, evidence,
confidence}], report_md}`. Proposal admission requires ≥3 supporting events or
1 explicit owner statement; contradictions with active rules must cite which
rule to retire. This keeps "learns on its own" **evidence-gated and reversible**.

---

## 9. Publishing integrations (the honest version)

### 9.1 Instagram (Meta Graph API) — direct publish, v1
- Prereqs (owner, guided ticket AP-701): IG account → Professional; link to a
  Facebook Page; create Meta app (Business type); add Instagram Graph API;
  owner's IG connected as app admin ⇒ **Development Mode suffices for
  own-account posting — no App Review** (review only needed for third-party
  accounts). Token: long-lived user token (60d, auto-refresh job) or
  Business-Manager system-user token (non-expiring; preferred).
- Flow: `POST /{ig-id}/media` (`image_url` JPEG public URL | `video_url` +
  `media_type=REELS` | `media_type=STORIES` | carousel children then parent
  `media_type=CAROUSEL`) → poll `status_code=FINISHED` (video ~30–120s) →
  `POST /{ig-id}/media_publish`. Media served from Supabase Storage public
  bucket `autopilot-media` (upload step in publisher).
- Limits/specs to enforce in lint: ≤100 API-published posts/24h
  (`content_publishing_limit` endpoint checked pre-publish); images JPEG only,
  ≤8MB, AR 0.8–1.91 (feed); Reels MP4 H.264/AAC 9:16 3s–15min ≤1GB (ours:
  6–90s); carousel 2–10 children. Errors: transient (`code 1,2,4,17,32` rate/
  server) → retry w/ backoff; permanent (media spec) → `publish_failed` + alert.

### 9.2 TikTok (Content Posting API) — inbox mode v1, direct v2
- Reality: **Direct Post requires an app audit**; unaudited apps can only
  create private (SELF_ONLY) posts. **Inbox upload needs no audit**: video
  lands in the owner's TikTok app inbox; owner opens TikTok, tweaks
  sounds/cover if desired, taps post — which *is* our L1 approval semantics,
  so v1 ships inbox-mode deliberately, not as a compromise.
- Prereqs (AP-702): TikTok developer app; Login Kit + Content Posting API;
  scopes `video.upload` (+`video.publish` later); OAuth once, store refresh
  token. Flow: `POST /v2/post/publish/inbox/video/init/` (PULL_FROM_URL from
  the public bucket, or chunked FILE_UPLOAD) → poll
  `/v2/post/publish/status/fetch/`. v2 ticket AP-706: pass audit → flip
  `publish_mode='tiktok_direct'` per item class; UX unchanged.
- Caption text goes into the inbox draft; hashtags in caption; sounds are
  chosen in-app by the owner (API can't attach trending commercial sounds —
  honest limitation, noted in digest UI).

### 9.3 Deferred alternative (D-3)
Third-party scheduler APIs (Ayrshare, Postiz self-hosted, Late) could replace
both integrations at $0 build cost but $29–149/mo and a data middleman.
Recommendation: **skip** — native IG is free and review-free for own accounts;
TikTok inbox is free and fits HITL. Revisit only if Meta app setup stalls.

### 9.4 Link & attribution
Caption links: `getforevermore.co?utm_source={platform}&utm_medium=organic&utm_campaign={pillar}&utm_content={item_id}`
(landing already runs cookieless PostHog EU — UTM-based attribution only;
**no pixels** until the privacy-page conflict is resolved — see owner ticket
AP-905, carried over from ads-pack findings).

---

## 10. Review & feedback surfaces (the human's cockpit)

### 10.1 Atlas Studio (new admin section in `apps/atlas`, behind existing `is_admin_self` gate)
- **Queue:** cards per candidate_group — media preview (video inline), caption,
  hook, slot, lint badge, dedupe note. Actions: Approve · Approve-with-edit
  (inline caption editor → `caption_diff`) · Request changes (reason chips +
  note) · Reject (reason chips) · Swap candidate.
- **Calendar:** week grid of slots/status; drag to retime (`slot_at` update).
- **Playbook:** active/proposed rules with evidence popovers; approve/retire.
- **Report:** weekly reports; per-post drill-down (run trace, cost, metrics).
- **Settings:** autonomy level, cadence, quiet days, kill switch, channel
  health (token expiry countdowns).
- **Suggestion box:** free-text → `owner_notes` (parsed nightly; digest
  confirms interpretation next morning — closing the "did it understand me?" loop).

### 10.2 Email digest (Resend, 07:30)
Top pick per slot with inline preview + one-shot HMAC action links
(`/api/ap/act?sig=…`): ✅ approve · ✍️ edit (opens Studio) · ❌ skip. Signed,
48h expiry, nonce-burned; `sensitive` items link to Studio only. Evening
reminder if a slot is unapproved at T-2h. Failures/token-expiry alerts reuse
the same channel.

### 10.3 CLI (developer escape hatch)
`autopilot ls|show|approve|reject|regen <id>`, `autopilot pause|resume`,
`autopilot run <stage> --dry-run` — every surface writes the same `approvals` rows.

---

## 11. Observability, ops, failure policy

- `runs` + per-run JSONL logs (`autopilot/logs/`, mirrored to storage in M1);
  `autopilot doctor` verifies: tokens valid, bucket reachable, Chrome present,
  dev-server bootable, clock sane, pending-migration drift.
- Alerts (Resend): stage failure after final retry; publish_failed; token
  expiring <7d; slot-day with zero candidates (the "employee didn't show up" alarm).
- SLOs: candidates ready by 07:30 (99%); publish within ±10min of slot (95%);
  digest delivery 100%; zero unapproved publishes (hard invariant, audited by
  a nightly reconciliation query: every `post_results` row must join an
  `approvals.decision='approved'` row — L2 lanes join a standing lane-approval record).
- Runbook: `autopilot/RUNBOOK.md` (token refresh, stuck item, kill switch,
  migration rollback, GHA re-run).

---

## 12. Milestones & exit criteria

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 "Hands"** (repo-local; wave 1) | Pipeline core + file store; brain via claude-cli; poster+video generation; lint; local review page; digest = local HTML; manual posting | 7 consecutive days: 3 candidates/slot before 07:30; ≥50% approved without edits; zero lint escapes (spot-audit) |
| **M1 "Spine"** | Supabase schema + storage; Atlas Studio; Resend digest w/ action links; IG native publish; TikTok inbox; autopilot-cron worker; GHA runner option | First end-to-end: approve in email → IG post live with correct UTM; TikTok inbox draft arrives; all publishes traceable |
| **M2 "Memory"** | IG metrics ingestion; TikTok CSV import; reflection + playbook UI; bandit re-weighting; weekly report | ≥5 active rules sourced from real evidence; mix shift justified in report; owner time ≤10min/day over 2 weeks |
| **M3 "Trust"** | L2 auto-publish lane (evergreen world-footage class, cap 1/day); anomaly guard (pause lane on 2σ engagement drop); comment-triage drafts; TikTok direct-post audit | 14 days ≥1 post/day with ≤10min/day owner time and zero invariant violations |

**Risks & mitigations:** Meta/TikTok setup friction → guided owner tickets with
screenshots + inbox-mode fallback; Mac-asleep missed runs → GHA redundancy
(M1); model drift/JSON breakage → schema-validated outputs + golden fixtures in
CI; over-posting/duplication → CAS transitions + dedupe gate + daily caps;
learning corrupting voice → immutable brand-law tier + owner-gated rules;
platform ToS → no engagement-bait patterns in lint, disclosure rules for any
future boosted/UGC content.

---

## 13. Open decisions (owner) — defaults chosen so build isn't blocked

| # | Decision | Default (used by wave 1) |
|---|---|---|
| D-1 | Runner host | Mac launchd now → GHA at M1 |
| D-2 | Brain driver | claude-cli (subscription) now → agent-sdk in CI |
| D-3 | Native APIs vs third-party scheduler | Native (IG dev-mode app + TikTok inbox) |
| D-4 | Schema push timing | SQL written now, **pushed only after your review** (per "ask for big changes" policy) |
| D-5 | Handles | @getforevermore both platforms (claim before M1 publish) |
| D-6 | Cadence default | 1 TikTok/day + 1 IG/day (mix per §6.2), quiet: none |
| D-7 | Autonomy | L1 (everything approved); L2 lane opt-in at M3 |
| D-8 | Metrics for TikTok pre-API | weekly CSV drop into `autopilot/inbox-metrics/` |

---

## 14. Acceptance (v1 = M0+M1 done)
1. Owner opens the 07:30 digest, taps approve on phone → IG Reel publishes at
   17:30 with correct assets/caption/UTM; TikTok draft in inbox same evening.
2. Every published post traces: idea → runs (prompt hash, cost) → approval →
   post_result. `autopilot doctor` green.
3. Rejecting with "hook too soft" + a caption edit yields, within 2 days, a
   proposed playbook rule citing that feedback; approving it visibly changes
   the next generation's hooks.
4. Kill switch stops all future stage work within one tick; nothing publishes
   while paused; resume picks up cleanly.
