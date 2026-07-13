# WAVE 2 BRIEF — from local pipeline to the employee I can talk to

**Audience:** Claude (Fable 5, maximum reasoning) running in Claude Code inside this repo.
**Author:** Redoni (owner). Feasibility facts below were verified against live sources on 2026-07-13.
**How to use this file:** read it end to end before planning anything. Then execute §9 "Start here". Plan before code — I approve each phase plan before you build it. One phase per session is fine; this file is the contract that survives across sessions. Wear two hats at all times: product owner (is this the thinnest path to daily value for a solo founder?) and software architect (will this survive running unattended for months?).

---

## 1. What this system is, and what's true today

Forevermore Autopilot is the autonomous marketing employee for Forevermore (getforevermore.com — personalized digital gift experiences). It is a standalone, zero-dependency Node ≥22 ESM project with its own Postgres (Docker, port 5433) that connects to the platform checkout read-only via `FOREVERMORE_ROOT` (see `docs/ADR-001-standalone.md` — that boundary is inviolable).

Verified current state (2026-07-13, HEAD `a7ffbf4`, 308 tests green, working tree clean):

- **Built and running live:** `plan → generate → render → qa → digest`. A 30-minute launchd tick (`co.getforevermore.autopilot.tick`, `make install-tick`) sweeps all slot dates and closes the owner-feedback loop unattended: my "Request changes" note in the Station → `changes_requested` → `drafting` (attempt+1) → redraft with my note injected as `inputs.feedback` → render → qa → back in my review queue, all within one tick.
- **The brain:** `src/brain/drivers/claude-cli.mjs` spawns `claude -p <prompt> --output-format json --allowedTools ""` on my Claude subscription (no API key). No model is pinned; cost is measured per run into `autopilot.runs.cost_usd`. The agent-sdk driver is an unimplemented stub — leave it that way (see §3.3).
- **The Station:** `review/server.mjs`, localhost:4600 only, no auth (network boundary is the gate), vanilla-JS SPA. Views: split-pane Review (pending + In-rework), Planned, History, Playbook (rules + suggestion box → `owner_notes`), Activity (worklog from `runs`).
- **State machine:** 16 statuses in `src/state/machine.mjs` (mirrored as the `ap_status` enum). Everything downstream of `approved` — `scheduled / publishing / published / measured / archived` — exists in the enum with retry/backoff policies already defined (`publishFailNext`: ×3, 2ⁿ·5min) but **has no implemented stage**. `make publish` currently errors by design.
- **Scaffolding already in place for wave 2:** `post_results`, `metrics_snapshots`, `link_nonces` tables; `META_IG_TOKEN` / `TIKTOK_*` / `RESEND_*` / `CLAUDE_CODE_OAUTH_TOKEN` slots in `.env.example`; RUNBOOK token-refresh sections; `docs/TICKETS.md` epics for publish/metrics/reflect.
- **Notifications: none.** Zero code, zero stubs. This is the biggest gap (§2.1).
- **No git remote.** The only copy of this repo is this laptop. Fix early (§4, Phase 1 quick win).
- **Normative docs:** `docs/PRD.md` (ContentItem contract §5, state machine §6, autonomy ladder L0–L3, brain/reflection §8), `docs/TICKETS.md` (34 tickets, 9 epics), `RUNBOOK.md`. Reconcile everything you do with these; extend them, don't fork them.

## 2. The problem I'm hiring you to solve

Three gaps, in priority order:

1. **I can't see it working.** The tick runs silently every 30 minutes. When I request changes, work happens invisibly — I don't know that redrafts are flowing, and I have no idea when something breaks. I find out by opening the Station at my desk, or never.
2. **It's chained to my Mac.** If the laptop sleeps, travels, or reboots, my employee stops existing. I want it hosted, reachable from my phone, running 24/7 without me.
3. **It doesn't ship.** The pipeline ends at "approved". Nothing reaches Instagram or TikTok. The point of the whole system is published content.

Target operating model: **I spend ≤1–2 hours/day directing — mostly from my phone. Everything else is autonomous.** I review drafts, give freeform feedback, request changes, commission new content, and approve. The system plans, writes, renders, QAs, redrafts, schedules, publishes, measures, and reports — and tells me immediately when it's blocked or broken.

## 3. Decisions already made — build on these, don't relitigate

If you find a genuine blocker, present evidence and a recommendation. Otherwise these are settled.

1. **Extend this repo, this pipeline, this state machine.** No rewrite, no new framework, no parallel system. New capabilities are new stages, stores, and daemons in the existing shape (file-per-stage, registry, Store contract, CAS transitions).
2. **Zero-dependency discipline stands.** Runtime deps today: `postgres`, nothing else. Telegram is raw HTTPS long-polling via Node's global fetch — no grammY/telegraf. Any new runtime dependency needs a one-line justification in the phase plan and my explicit OK.
3. **Brain auth = Claude subscription via the `claude` CLI.** On the VPS: `claude setup-token` (run once, interactively, by me) → `CLAUDE_CODE_OAUTH_TOKEN` env var → the existing claude-cli driver's `claude -p` calls pick it up. Verified: this is Anthropic's documented, sanctioned path for headless subscription use; the token lasts ~1 year. Two hard rules: **never `--bare` mode** (it skips OAuth tokens and demands an API key), and **never wire the Agent SDK driver to subscription auth** (SDK is documented API-key-only). The automation runs on my *second* Claude subscription so its rate-limit pool is fully separate from my daily coding one. If weekly caps ever bite, alert me and propose options — do not silently switch anything to API billing.
4. **Model policy is config, not code.** Add `stageModels` + `fallbackModel` to `autopilot.config.json` (the claude-cli driver already passes `--model` when set). Initial policy: `generate` = `claude-fable-5`, everything else unpinned (CLI default). Context you must design around: as of 2026-07-13, Fable 5 is included in subscription limits only through ~July 19 (deadline already extended three times — check current status at build time), is capped at ~50% of weekly plan usage, and burns roughly 2× Opus per token against plan limits. Required behavior: if a `--model` call fails as unavailable/not-entitled, retry once on `fallbackModel` (`claude-opus-4-8`), complete the run, and send me a Telegram alert saying what happened and how to respond. Never let model politics stall the pipeline.
5. **Publishing is first-party official APIs only.** No browser automation, no unofficial libraries — account bans kill the whole business channel. The PRD's rejection of aggregators (Postiz/Ayrshare/etc.) stands, with one pre-approved exception: if the TikTok audit (§4 Phase 3) is still unresolved 6+ weeks after submission, bring me a concrete aggregator fallback proposal for TikTok only (Zernio/Late ≈ free for 2 accounts, or Ayrshare ~$149/mo) with its trade-offs.
6. **Platform routes, verified 2026-07-13 — design to these:**
   - **Instagram:** Instagram API with Instagram Login, app kept permanently in Development Mode, my own professional account added with the Instagram Tester role → `instagram_business_content_publish` works for self-use with **no App Review**. Media must sit at a publicly reachable URL (that's what R2 is for). Limit: 50 published posts per rolling 24h. Reels, carousels (≤10), single images, Stories all supported via the container → poll → publish flow. Sanity-check this dev-mode path against Meta's actual dashboard during setup before writing the adapter.
   - **TikTok:** unaudited API clients can only create `SELF_ONLY` (private) posts, regardless of account. So v1 = **inbox upload mode with `FILE_UPLOAD`** (no domain verification needed): the draft lands in my TikTok inbox, Telegram nudges me, I tap publish in the app. That fits the approval flow anyway. In parallel, prepare and submit the **Content Posting API audit** (needs: demo video of the OAuth+post flow, privacy policy + ToS URLs — the platform's live legal pages qualify, unchecked privacy-level defaults; typical turnaround 2–4 weeks) so direct public posting unlocks later. Verify current unaudited semantics at build time.
   - **X/Twitter:** later (Phase 4+). Free tier is dead (Feb 2026); pay-per-use ≈ $0.015/post ($0.20 with a link) — trivially cheap at our volume. Design the publisher as adapters so X is just a third implementation.
7. **The approval gate is absolute.** Only items whose status is `approved` — an explicit decision recorded in `approvals` — may ever reach a publisher. Publishing is idempotent: check `post_results` before creating, single-flight per item (CAS `approved→scheduled→publishing`), and the machine's existing backoff on `publish_failed`. A double-post or an unapproved post is the worst bug this system can have; test both paths explicitly.
8. **Hosting = one Linux VPS** (Hetzner CPX31-class: 4 vCPU / 8 GB / ~€16.5/mo, Ubuntu LTS, TZ Europe/Tirane): Postgres (same schema, same :5433 parity), tick + Telegram poller + Station as systemd units, a read-only clone of the platform repo as `FOREVERMORE_ROOT` for render assets, Cloudflare Tunnel + Cloudflare Access (my email only) in front of the Station (which keeps its 127.0.0.1 bind and no-auth design), R2 for publish media + nightly `pg_dump` backups. The Mac becomes a dev machine only; its launchd tick gets unloaded at cutover — never two tickers against one DB. The staged GitHub-Actions scheduler (`ops/github/autopilot.yml`) and RUNBOOK's Mac→GHA section are superseded by this decision; leave them but don't wire them.
9. **Renderer portability is a first-class task, not a footnote.** Poster rendering shells out to headless Brave on macOS and video runs through the platform's Remotion studio (`marketing/04-assets/render.mjs`, `marketing/05-video-studio`). On Linux: browser path must be configurable (chrome-headless-shell / chromium), Remotion needs `--gl=swangle` on CPU-only boxes, and renders will be slower — that's fine at our volume. Prove render parity on the VPS (same item renders, plausible bytes, lint passes) before cutover.
10. **Safety rails everywhere:** the existing `kill_switch` setting halts everything including publishers; add a daily brain-spend cap (settings, summed from `runs.cost_usd`) that pauses generation and alerts me when hit; per-platform daily publish caps; every failure path emits a Telegram alert; a liveness alert fires if no successful tick completes for >90 minutes while unpaused (this also covers silent OAuth-token death, which has been reported in the wild).
11. **This system never touches the platform repo or its Supabase.** Read-only consumption via `FOREVERMORE_ROOT` only (ADR-001).

## 4. Phases

Each phase: plan → my approval → build → verify end-to-end → demo I can check from my phone in under 5 minutes → commit. Do not start the next phase without my go.

### Phase 1 — See it and steer it (Telegram). No VPS prerequisite; runs on the Mac today.

A long-polling Telegram bot daemon (own launchd/systemd unit, own lockfile), restricted to my chat id (ignore and log everything else). It is a *projection of the DB* — decisions flow through the same store paths the Station uses (extract the `decide()` logic from `review/lib/` into a shared `src/` module rather than duplicating it).

**Inbound → me:**
- Per-tick summary, only when something happened ("3 rendered, 2 awaiting review, 1 QA-bounced (attempt 2/3)"). Silence when idle except one daily heartbeat + the daily digest summary.
- Each item reaching `pending_review` → one card: caption, platform/format/slot, the actual media (final.mp4s are ~2–4 MB — well under the 50 MB bot limit), and buttons: ✅ Approve · ✏️ Request changes (bot prompts for the note → existing regen loop) · ⏭ Skip · 🔍 Station deep-link.
- Alerts: stage failures (item, one-line cause, attempt count), third consecutive failure escalation, spend-cap hit, liveness lapse, publish results later.
- Anti-spam requirements: events keyed on (item, status) and deduped; batched per tick; quiet hours (default 23:00–08:00, configurable) hold non-critical messages.
- Callback-data is ≤64 bytes — use short ids/nonces (the `link_nonces` pattern exists for exactly this), not raw payloads.

**Outbound ← me:**
- Freeform reply to a card = a change-request note on that item.
- Freeform message = `owner_notes` (suggestion box). `/rule <text>` = live playbook rule.
- `/new <brief>` = commission content: create an off-list item (the planner's `OFFLIST` sentinel exists) that the next tick drafts. This is how I say "make me a video about X" from anywhere.
- Commands: `/status` (queue by status, last tick, today's spend), `/queue`, `/pause` + `/resume` (maps to `kill_switch`), `/tick` (force one now), `/digest`, `/doctor`, `/help`.

**Also in Phase 1 (quick wins):** create a private GitHub remote and push (ask me before first push — external service); emit the **owner-task checklist** so long human fuses start burning now: claim @getforevermore handles (still unclaimed!), convert/confirm IG professional account, create the Meta app (dev mode + tester role), create the TikTok developer app + sandbox, R2 bucket + token, and — when we get there — the TikTok audit submission. Exact clicks for each, delivered as a checklist I can do in one sitting.

**DoD:** from my phone: I see a tick summary, receive a new item as a card with playable media, approve one item, request changes on another with a note and later receive its attempt-2 card, commission one item via `/new` and see it arrive, `/pause` halts the next tick and `/resume` restores it, and I received at least one real error alert (force one in a test). Bot survives a Mac reboot (launchd). Zero Telegram messages during a quiet-hours tick except a forced critical alert.

### Phase 2 — Move it (VPS)

Provision (I'll create the Hetzner account/server with your runbook — you give me the exact steps and a hardening checklist: non-root user, SSH keys only, ufw, unattended-upgrades). Then: Postgres up (Docker or native — your call, justify), `pg_dump`/restore + rsync `outbox/` + `library/`, platform repo clone as `FOREVERMORE_ROOT`, `claude setup-token` (I run it, you tell me exactly how/where the token lands), systemd units + timers for tick/poller/Station with `EnvironmentFile`, TZ pinned, cloudflared tunnel + Access policy (my email), render-parity proof (§3.9), nightly `pg_dump` → R2 with a tested restore, `make doctor` green on the box, then unload the Mac launchd agent.

**DoD:** Mac shut for 24+ hours → ticks keep running, Telegram keeps talking, Station reachable at its Access-gated URL from my phone, one backup restored successfully as a fire drill, liveness alert proven by stopping the timer once.

### Phase 3 — Ship it (publishing)

The missing stages: `scheduled` (approved items claim their `slot_at`), `publishing` (due items, single-flight), adapters `src/publish/adapters/{instagram,tiktok}.mjs` behind one interface (`publish(item) → {postId, permalink, mode}`), a media-host seam (upload to R2, return public URL, lifecycle-expire after confirm), `post_results` writes, and Telegram reporting ("Published to IG: <permalink>"). Instagram = dev-mode direct publish (container flow, poll ≤5 min, then publish). TikTok = inbox mode + Telegram nudge to tap publish; audit submission goes out this phase. Metrics stage v1: pull basic IG insights into `metrics_snapshots` on a daily timer. Respect the state machine's existing publish retry/backoff; add idempotency tests (double-tick, crash-mid-publish, re-approve after publish must be impossible).

**DoD:** one real approved item published to Instagram exactly once with the permalink reported in Telegram; one TikTok draft delivered to my inbox and nudged; a deliberately duplicated publish attempt provably no-ops; TikTok audit submitted; publish caps + kill switch verified to gate the publisher.

### Phase 4 — Tighten the loop (learning + autonomy)

The PRD's reflect stage (§8): weekly, read `metrics_snapshots` + decision history → propose (never silently apply) playbook rule changes and next week's plan emphasis, delivered as a Telegram digest I can approve rule-by-rule. Autonomy ladder movement per PRD L0→L3: L2 first (auto-approve narrow, owner-defined classes via playbook rules — e.g. caption typo fixes), L3 (auto-publish specific formats) only by my explicit per-format opt-in, and always still gated by `approved` status semantics. X adapter if I say go. Fable-5 usage review: once a solid content base exists, propose the cheapest model mix that holds quality (A/B via the existing lint + my decisions as ground truth).

## 5. Engineering ground rules

- Tests green before and after every phase (`npm test` — note: bare `node --test test/` fails). New stages, transitions, adapters, and the Telegram command surface all get tests; publisher idempotency gets adversarial ones.
- Feature-flag every new subsystem (`TELEGRAM_ENABLED`, `PUBLISH_ENABLED`, …) defaulting off until its DoD demo passes.
- Migrations only (`db/migrations/0004+.sql` via `db/apply.mjs`); never hand-edit live tables. Both stores (Postgres + FileStore) keep contract parity.
- Every new env var lands in `.env.example` + RUNBOOK. Every new op lands in the Makefile. TICKETS.md gets the new work minted into its existing epic/numbering scheme; PRD gets amended (not contradicted) where reality diverged.
- Telegram/publisher daemons: structured logs to `logs/`, and every meaningful action also lands in the existing `runs`/Activity worklog — the Station and Telegram must never disagree about what happened.
- Conventional commits, one concern per commit. Ask before the first push to any remote.

## 6. Known gotchas — do not relearn these the hard way

- `normalizeStage`: compound labels (e.g. `qa:transition`) must land in the `transition` runs bucket, or Activity floods (fixed once already).
- `runStage` must not write run rows for `already_completed` skips — a 30-min tick otherwise mints ~100 junk rows/day (fixed once already).
- Overlay-replacing transitions must preserve the `overlays.__fileids` and `__feedback` envelopes (file↔pg identity + feedback history live there).
- PG integration tests must tag runs `driver: test-<tag>` and sweep them, or they leak into the live Activity feed.
- Inside `SECURITY DEFINER` functions use `session_user`, not `current_user` (owner-context makes role checks dead code).
- Port 4600 often holds an orphaned old-code Station — kill it before verifying Station changes. The SPA's hash nav does not refetch (stale panels until Refresh).
- PNG-listed assets fail the jpeg-required lint — JPEG twins only in `assets[]`.
- The tick's pid lock (`state/tick.lock`) has a 45-min stale-break; per-date failure isolation is deliberate — keep both properties in anything you add.
- Render depends on the *platform* repo's `render.mjs` exports (`renderOne`/`renderJobs`) — coordinate, never fork.
- `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN`: never `--bare`.
- Only 6 worlds have library capture masters, so showcase reels fire rarely — surfacing "capture more masters" in my owner checklist is fair game.

## 7. Money (pre-approved vs ask-first)

Pre-approved: VPS ≤ €20/mo; R2 at free-tier-ish usage; X pay-per-use at our volume (Phase 4); domain/subdomain + Cloudflare free-tier features; $0 Meta/TikTok developer apps.
Ask first: any new recurring cost > €25/mo (including the TikTok aggregator fallback); switching any brain traffic to API billing; anything irreversible or public-facing beyond the approved publishing flow.
The brain runs on my second Claude subscription — treat its weekly cap as a real budget, report spend in `/status`, and alert me at the daily cap instead of degrading silently.

## 8. Working with me

- Batch questions into the phase plan; don't trickle them. When truly blocked on something only I can do, emit an OWNER TASK (Telegram once it exists, chat before that) with exact instructions, and keep working on what isn't blocked.
- Report honestly. Failed means failed, with the output. Skipped means skipped. "Done" requires the DoD demo, verifiable from my phone.
- I review deeply in the Station and quickly in Telegram. Optimize both paths; never make Telegram a second source of truth.

## 9. Start here

1. **Audit.** Read the docs in §1 and the code they point to. Verify every factual claim in this brief against the repo; where the brief is wrong, say so. Reconcile with PRD/TICKETS and report drift (including where this brief supersedes RUNBOOK's GHA plan and confirms PRD's aggregator rejection).
2. **Re-verify the two volatile externals** (web search): Fable 5's current subscription status (§3.4) and TikTok's current unaudited-client semantics (§3.6). Adjust the plan if they moved.
3. **Present the Phase 1 plan:** schema deltas, new files, the shared-decide extraction, the full Telegram message/command taxonomy, anti-spam design, test plan, and your PO/architect pushback on anything in this brief you'd change. Include the owner-task checklist draft.
4. **On my go: build Phase 1.**
