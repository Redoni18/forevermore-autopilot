-- AUTOPILOT SCHEMA — Autopilot's own database. Apply with db/apply.mjs;
-- never apply this to the Forevermore platform's Supabase project.
--
-- Control-plane schema for Forevermore Autopilot, the TikTok/IG "autonomous
-- marketing employee" (marketing/07-autopilot/PRD.md §5 is the DDL this
-- productionizes; §4.3 is the trust boundary this enforces; TICKETS.md AP-102
-- is this ticket). Ten tables carry the content pipeline end to end — ideas
-- feed content_items, every stage execution writes a runs row, every human
-- decision writes an approvals row, publishing writes post_results, ingestion
-- writes metrics_snapshots, and reflection proposes playbook_rules — plus
-- owner_notes / settings / link_nonces for the human-in-the-loop surfaces.
--
-- Trust model: every table is RLS-enabled with ZERO policies for anon or
-- authenticated (deny by default), and the schema itself is revoked from
-- anon/authenticated/public so a browser client cannot even resolve
-- `autopilot.*` by name. service_role (the runner + publisher — never shipped
-- to a browser) reads/writes directly via the explicit grants below and
-- bypasses RLS entirely through its BYPASSRLS role attribute, not a policy.
-- The one owner-facing path — Atlas Studio, a static SPA holding only the
-- publishable key — goes through four SECURITY DEFINER RPCs (ap_queue,
-- ap_decide, ap_rules, ap_settings). Those RPCs live in `public`, not
-- `autopilot`, so PostgREST can see them (this schema is deliberately not on
-- the exposed-schemas list); each is gated by autopilot_private.is_operator()
-- (see the AP-813 adaptation note below): EXECUTE revoked from public/anon,
-- granted to authenticated, with the real gate enforced inside the function
-- body, not by the grant.
--
-- This file was cross-checked against autopilot/src/types.mjs — the file-mode
-- (M0) JSDoc contract already landed by the parallel AP-201/AP-103 session —
-- for field-for-field compatibility, per PRD §5's own requirement that the
-- FileStore → SupabaseStore swap be a config flip, not a rewrite. Deviations
-- from the literal PRD §5 sketch, and the few points still open, are called
-- out inline as they occur.
--
-- ── AP-813 standalone adaptation (2026-07-12) ──────────────────────────────
-- This file was moved verbatim from the (now-defunct) platform-embedded copy
-- at supabase/migrations/20260713090000_autopilot_schema.sql and made fully
-- self-contained per ADR-001 (docs/ADR-001-standalone.md), which mandates
-- "no dependency on any migration from the platform project." Three
-- dependencies on platform-only state were removed, with all table/enum/
-- constraint/RLS/RPC semantics preserved exactly:
--   1. Roles (anon/authenticated/service_role) — Supabase-managed on a
--      hosted project, absent on bare Postgres. §0 below creates them
--      idempotently (no-ops on a project where they already exist).
--   2. `private` schema + private.set_updated_at() — defined in the
--      platform's 20260615205910 migration, not available here. §1 below
--      defines Autopilot's own `autopilot_private` schema (deliberately NOT
--      named `private`, to avoid colliding if this database is ever hosted
--      on a Supabase project that already has one) with its own
--      set_updated_at(), a verbatim copy of the platform's 3-line body.
--   3. public.is_admin_self() — the platform's Atlas admin gate, backed by
--      public.user_profiles (a table that doesn't exist in this database).
--      §1 below defines `autopilot_private.is_operator()` in its place: for
--      local/single-operator deployments, the gate is the network
--      boundary (only the operator can reach this Postgres instance at
--      all), expressed as a session GUC (`autopilot.operator`) plus a
--      superuser/service_role bypass so `psql` and the runner never need to
--      set it. A hosted multi-operator deployment later replaces this one
--      function with a real JWT/user-table check — every call site already
--      isolates the gate behind this single function, so that's a one-
--      function swap, not a schema change.
-- No other adaptation was made: every table, enum, constraint, index, RLS
-- posture, and RPC business rule below is identical to the platform version.
--
-- Rollback: `drop schema autopilot cascade;` removes the schema, its 4 enums,
-- 10 tables and their triggers/indexes. `drop schema autopilot_private
-- cascade;` removes the two helper functions from adaptation #2/#3 above.
-- Neither drops the RPCs, which live in `public` on purpose (see above), nor
-- the roles created in §0 (those may be relied on outside this schema, e.g.
-- by a hosted project, so rollback never drops roles). Also run:
--   drop function if exists public.ap_queue(text);
--   drop function if exists public.ap_decide(uuid, text, text[], text, text);
--   drop function if exists public.ap_rules(text, uuid);
--   drop function if exists public.ap_settings(text, jsonb);
-- No other migration depends on this one; it introduces no new columns on
-- any existing table.

-- ============================================================================
-- 0. Roles (idempotent — AP-813 adaptation #1)
-- ============================================================================
--
-- On a hosted Supabase project these three roles already exist (Supabase
-- creates and manages them) and every guard below no-ops. On the bare
-- postgres:16 container this repo runs by default (db/apply.mjs against
-- docker-compose.yml), nothing creates them automatically, so this migration
-- creates them itself to stay fully self-contained (ADR-001). Attributes
-- mirror what a hosted Supabase project actually has, confirmed against a
-- live project: anon/authenticated are plain NOLOGIN roles, service_role is
-- NOLOGIN with BYPASSRLS (that attribute, not a policy, is what lets it skip
-- RLS everywhere in §3 below).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- ============================================================================
-- 1. Private helpers (AP-813 adaptation #2 + #3)
-- ============================================================================
--
-- `autopilot_private` stands in for the platform's `private` schema — same
-- lockdown pattern (create + revoke-from-everyone-but-owner), different name
-- so this never collides with a `private` schema if this database is ever
-- hosted on a Supabase project (which conventionally owns that name).

create schema if not exists autopilot_private;

revoke all on schema autopilot_private from public;
revoke all on schema autopilot_private from anon;
revoke all on schema autopilot_private from authenticated;

-- Verbatim copy (3-line body) of the platform's private.set_updated_at()
-- from 20260615205910_create_user_profiles_and_projects.sql. Schema-agnostic
-- generic trigger function; §7 below points every updated_at trigger at
-- this copy instead.
create or replace function autopilot_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Replaces public.is_admin_self() (the platform's Atlas admin gate, backed
-- by public.user_profiles — a table that doesn't exist in this standalone
-- database). Local/single-operator deployments authenticate at the network
-- layer: only the operator can reach this Postgres instance, so the gate is
-- a session GUC the operator (or an already-trusted role) sets explicitly —
-- `select set_config('autopilot.operator', 'true', false);` — plus a bypass
-- for postgres/service_role so the CLI and the runner never need to set it.
-- Hosted multi-operator mode replaces this one function with a real JWT/
-- user-table check; every §6 RPC gate already calls through this single
-- function, so that's a one-function swap, not a call-site change.
--
-- SECURITY NOTE (AP-813 validation finding, fixed at integration): this MUST
-- use session_user, not current_user. Inside a SECURITY DEFINER function
-- current_user is the function OWNER (postgres), so a current_user check is
-- always-true dead code when called through the ap_* RPCs. session_user is
-- the real login identity and survives SET ROLE and definer contexts.
create or replace function autopilot_private.is_operator()
returns boolean
language sql
set search_path = ''
stable
as $$
  select coalesce(current_setting('autopilot.operator', true)::boolean, false)
    or session_user in ('postgres', 'service_role');
$$;

-- ============================================================================
-- 2. Schema + lockdown
-- ============================================================================

create schema autopilot;

-- Explicit revoke, mirroring the `private` schema pattern in
-- 20260615205910_create_user_profiles_and_projects.sql. Postgres doesn't
-- auto-grant PUBLIC anything on a freshly created schema, so this is
-- belt-and-suspenders — but it's the auditable, explicit form the rest of
-- this codebase uses, and it also blocks resolving `autopilot.*` type names
-- (enums included) from anon/authenticated, which a bare RLS policy would not.
revoke all on schema autopilot from public;
revoke all on schema autopilot from anon;
revoke all on schema autopilot from authenticated;

grant usage on schema autopilot to service_role;

-- ============================================================================
-- 3. Enums (PRD §5 — verbatim labels/order, matches
--    autopilot/src/types.mjs PLATFORMS/FORMATS/RISKS/STATUSES exactly)
-- ============================================================================

create type autopilot.ap_platform as enum ('instagram', 'tiktok');

create type autopilot.ap_format as enum ('reel', 'carousel', 'image', 'story', 'tiktok_video');

-- Order matches the pipeline's rough progression (PRD §6.1), which also
-- makes `order by status` roughly meaningful — Postgres enum comparison
-- follows declaration order, not alphabetical.
create type autopilot.ap_status as enum (
  'planned', 'drafting', 'drafted', 'rendering', 'rendered', 'qa_failed',
  'pending_review', 'changes_requested', 'approved', 'scheduled',
  'publishing', 'published', 'publish_failed', 'skipped', 'measured', 'archived'
);

-- sensitive = memorial/kids/UGC → never auto-published, always atlas-only
-- approval (PRD §6.1: "sensitive risk items require via='atlas' approval").
create type autopilot.ap_risk as enum ('evergreen', 'standard', 'sensitive');

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- ideas — runtime copy of marketing/02-idea-database/ideas.json. Source of
-- truth for idea *content* stays git; this table is what the bandit/planner
-- mutate (attempts/wins/losses/last_used_at) at runtime. `pillar` values
-- (P1..P7 today) live in ideas.json, not here — deliberately no CHECK
-- against a pillar catalog, since that list is expected to grow without a
-- migration.
create table autopilot.ideas (
  id text primary key,                         -- F01/A17/B23… mirrors ideas.json
  payload jsonb not null,                       -- full idea object (idea DB schema)
  pillar text not null,
  format_family text not null,
  active boolean not null default true,
  attempts integer not null default 0 check (attempts >= 0),
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  last_used_at timestamp with time zone,
  -- Not in the PRD §5 sketch — added because this row is mutated on every
  -- bandit update (attempts/wins/losses/last_used_at change constantly) and
  -- an audit trail of "when did this idea's stats last move" is genuinely
  -- useful for debugging the planner. Low-risk, standard productionization.
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index ideas_active_idx on autopilot.ideas (active) where active;
create index ideas_pillar_format_family_idx on autopilot.ideas (pillar, format_family);

-- runs — one row per stage execution (PRD §5). `stage` is constrained to the
-- 8 canonical pipeline stages from PRD §6.2/§8.1's own comment, which is
-- intentionally broader than autopilot/src/types.mjs's STAGES constant
-- (currently only 5: plan/generate/render/qa/digest — AP-201's wave-1 scope
-- per TICKETS.md). The DB contract tracks the full documented system, not
-- just what's wired up today, so wave-2/3 (publish/metrics/reflect) don't
-- need a follow-up migration just to record their stage name.
--
-- `driver` is deliberately NOT check-constrained. PRD §8.2 lists three
-- (claude-cli/agent-sdk/deterministic), but AP-301's own acceptance criteria
-- requires a fourth ("--driver mock" for fixture-driven tests) that isn't in
-- that list — a CHECK here would block AP-301's mock driver on day one.
create table autopilot.runs (
  id uuid primary key default gen_random_uuid(),
  stage text not null
    -- 'report' = weekly report stage; 'transition' = state-machine audit rows
    -- written by the store layer (reconciled at AP-801)
    check (stage in ('plan', 'generate', 'render', 'qa', 'digest', 'publish', 'metrics', 'reflect', 'report', 'transition')),
  status text not null default 'running'
    check (status in ('running', 'ok', 'failed')),
  driver text,
  model text,
  prompt_sha text,
  tokens_in integer check (tokens_in >= 0),
  tokens_out integer check (tokens_out >= 0),
  cost_usd numeric(8, 4) check (cost_usd >= 0),
  started_at timestamp with time zone not null default now(),
  finished_at timestamp with time zone,
  error text,
  log_path text
  -- No updated_at: `finished_at` is the meaningful completion timestamp a
  -- runner sets explicitly; a generic trigger-maintained updated_at would be
  -- redundant with it.
);

create index runs_stage_status_idx on autopilot.runs (stage, status);
create index runs_started_at_idx on autopilot.runs (started_at desc);

-- content_items — the core pipeline record (PRD §5 + §6.1 state machine).
--
-- regen_count / publish_attempts / next_attempt_at are NOT in the PRD §5
-- sketch, but are required to implement §6.1's bounded-retry rules
-- ("changes_requested → drafting, max 2"; "publish_failed → publishing,
-- retry ×3, backoff 2^n·5m") as counters *distinct* from the QA `attempt`
-- counter (max 3) — and autopilot/src/types.mjs's ContentItem typedef
-- (already landed by the parallel AP-201/AP-103 session) already carries
-- these exact three fields for that reason. Added here to keep the
-- FileStore/SupabaseStore contract field-for-field compatible, per PRD §5's
-- own stated goal. Retry ceilings are enforced in application code, not by
-- CHECK, matching how `attempt`'s "max 3" isn't CHECK-enforced either — both
-- are pipeline policy, not data-integrity constraints.
create table autopilot.content_items (
  id uuid primary key default gen_random_uuid(),
  slot_at timestamp with time zone not null,                          -- intended publish moment
  platform autopilot.ap_platform not null,
  format autopilot.ap_format not null,
  idea_id text references autopilot.ideas (id) on delete set null,
  series_key text,                                                    -- 'world-tours', 'ranked-by-tears'…
  pillar text,
  risk autopilot.ap_risk not null default 'standard',
  status autopilot.ap_status not null default 'planned',
  candidate_group uuid,                                               -- N candidates for one slot share this
  chosen boolean not null default false,
  caption text,
  hashtags text[],
  overlays jsonb,                                                     -- { hook?, beats?[], cta? }
  link_utm text,
  assets jsonb,                                                       -- [{kind, path, storage_url, w, h, dur_s, sha256}]
  lint jsonb,                                                         -- { passed, violations:[{rule,severity,excerpt}] }
  dedupe jsonb,                                                       -- { hook_sim, nearest_item, method }
  produced_by uuid references autopilot.runs (id) on delete set null,
  attempt integer not null default 1 check (attempt >= 1),
  regen_of uuid references autopilot.content_items (id) on delete set null,
  regen_count integer not null default 0 check (regen_count >= 0),    -- addition — see comment above
  publish_attempts integer not null default 0 check (publish_attempts >= 0), -- addition — see comment above
  next_attempt_at timestamp with time zone,                           -- addition — see comment above
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index content_items_status_slot_at_idx on autopilot.content_items (status, slot_at);
create index content_items_candidate_group_idx on autopilot.content_items (candidate_group);
-- FK-covering indexes (not in the PRD sketch, but ON DELETE SET NULL/CASCADE
-- actions do a full scan of the referencing table without one at any scale).
create index content_items_idea_id_idx on autopilot.content_items (idea_id);
create index content_items_produced_by_idx on autopilot.content_items (produced_by);
create index content_items_regen_of_idx on autopilot.content_items (regen_of);

-- approvals — append-only decision audit log (PRD §5). `decision` is kept to
-- the PRD's literal three values, matching autopilot/src/types.mjs's
-- DECISIONS constant exactly. See the long comment on ap_decide() below for
-- why this is left as-is rather than adding a fourth 'changes_requested'
-- value, and the open question that leaves.
--
-- ON DELETE CASCADE: an approval row's only reason to exist is to document a
-- decision about its content_item: if the item is ever purged, the decision
-- record has no independent meaning.
create table autopilot.approvals (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references autopilot.content_items (id) on delete cascade,
  -- reconciled at wave-1 integration (AP-801): 'changes_requested' is a
  -- first-class human decision (consequence: regen), distinct from
  -- 'rejected' (consequence: skip)
  decision text not null check (decision in ('approved', 'rejected', 'edited', 'changes_requested')),
  reason_tags text[],  -- canonical tag list is autopilot/src/types.mjs REASON_TAGS (app-level, not DB-enforced —
                        -- reflection is expected to surface new tags without a migration)
  note text,
  caption_diff jsonb,  -- { before, after } — set only when decision='edited'
  -- 'local-station' = the M0 file-mode review server (AP-501); its decision
  -- files are ingested verbatim at M1 migration (reconciled at AP-801)
  via text not null check (via in ('atlas', 'email-link', 'cli', 'local-station')),
  decided_at timestamp with time zone not null default now()
);

create index approvals_content_item_id_idx on autopilot.approvals (content_item_id);
create index approvals_decided_at_idx on autopilot.approvals (decided_at desc); -- reflection's evidence-window scans

-- post_results — one finalization row per published item (PRD §5). 1:1 with
-- content_items (PK = FK). ON DELETE CASCADE for the same reason as
-- approvals: meaningless without its parent item.
create table autopilot.post_results (
  content_item_id uuid primary key references autopilot.content_items (id) on delete cascade,
  platform_post_id text,
  permalink text,
  publish_mode text not null
    check (publish_mode in ('ig_api', 'tiktok_inbox', 'tiktok_direct', 'manual')),
  posted_at timestamp with time zone,
  raw jsonb,
  -- Additions beyond the PRD sketch: created_at (when the runner first wrote
  -- this row, which can precede posted_at by the IG async-processing window)
  -- and updated_at (permalink/raw sometimes backfill after the initial write).
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

-- metrics_snapshots — time series of platform insights (PRD §5). Point-in-
-- time by design (new row per pull, never mutated after insert), so no
-- updated_at. content_item_id is deliberately left nullable, matching the
-- PRD sketch exactly (no "not null" given): AP-703's AC calls for daily
-- account-level follower snapshots alongside per-post insights, and a
-- follower snapshot has no single content_item to attach to.
--
-- `source` gets the same treatment as post_results.publish_mode: the PRD's
-- own inline comment lists exactly 3 values and each maps to a distinct
-- ingestion code path (AP-703/AP-704), so it's as fixed as an enum in
-- practice. completion_rate is only floor-checked (>=0), not capped at 1 —
-- some platforms report replay-inclusive ratios that can exceed 100%, and a
-- hard upper bound risks rejecting real data.
create table autopilot.metrics_snapshots (
  id bigint generated always as identity primary key,
  content_item_id uuid references autopilot.content_items (id) on delete cascade,
  captured_at timestamp with time zone not null default now(),
  views integer check (views >= 0),
  likes integer check (likes >= 0),
  comments integer check (comments >= 0),
  shares integer check (shares >= 0),
  saves integer check (saves >= 0),
  avg_watch_ms integer check (avg_watch_ms >= 0),
  completion_rate numeric(5, 4) check (completion_rate >= 0),
  reach integer check (reach >= 0),
  follows integer check (follows >= 0),
  source text not null check (source in ('ig_api', 'tiktok_csv', 'manual')),
  raw jsonb
);

create index metrics_snapshots_content_item_captured_idx
on autopilot.metrics_snapshots (content_item_id, captured_at desc);

-- playbook_rules — the learning loop's memory (PRD §5 + §8.4). `category` is
-- CHECK-constrained beyond the ticket's explicit call-out list: PRD §8.1's
-- Reflector duty table gives an exact 6-value comment for it, it's a fixed
-- taxonomy tied to prompt-injection sections (not free text a human types),
-- and it's low-risk to constrain. `weight` gets PRD's own documented bound
-- (1..10 injection priority). No updated_at: `decided_at` already captures
-- the one meaningful transition (proposed → active/retired); rule text
-- itself isn't expected to be edited in place post-proposal.
create table autopilot.playbook_rules (
  id uuid primary key default gen_random_uuid(),
  rule text not null,                                    -- imperative, prompt-injectable
  category text not null check (category in ('hook', 'caption', 'format', 'timing', 'world', 'visual')),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'retired')),
  source text not null check (source in ('owner', 'reflection')),
  evidence jsonb,                                         -- [{content_item_id, metric, value}] or approval ids
  weight integer not null default 5 check (weight between 1 and 10),
  created_at timestamp with time zone not null default now(),
  decided_at timestamp with time zone
);

-- The hot read path: every single brain call (PRD §8.1) injects active rules
-- ordered by weight. A partial index on exactly that predicate+order is the
-- single highest-value index in this migration.
create index playbook_rules_active_weight_idx
on autopilot.playbook_rules (weight desc) where status = 'active';

-- owner_notes — free-form suggestion inbox (PRD §5). processed_at added
-- alongside the PRD's `processed` boolean for an audit trail of when the
-- nightly parser actually consumed it. Partial index matches the parser's
-- one real query: "give me what's unprocessed."
create table autopilot.owner_notes (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  applies_from date,
  processed boolean not null default false,
  processed_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index owner_notes_unprocessed_idx on autopilot.owner_notes (created_at) where not processed;

-- settings — generic kv store (PRD §5). `value not null`: a settings row
-- with a null value is a bug state, not a valid one (ap_settings below
-- always supplies a value).
create table autopilot.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamp with time zone not null default now()
);

-- link_nonces — one-shot email action links (PRD §5 + §4.3, 48h TTL). Added
-- created_at beyond the PRD sketch: a TTL is meaningless to enforce/prune
-- without knowing when the nonce was minted.
create table autopilot.link_nonces (
  sig text primary key,
  used_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index link_nonces_created_at_idx on autopilot.link_nonces (created_at); -- TTL pruning sweeps

-- ============================================================================
-- 5. Row level security — enable everywhere, ZERO policies (deny by default)
-- ============================================================================
--
-- No browser client ever holds credentials that can even resolve
-- `autopilot.*` (see the schema-level revoke in §2), so RLS here is
-- defense-in-depth rather than the primary gate. service_role bypasses RLS
-- entirely via its BYPASSRLS role attribute — a Postgres role property, not
-- a policy — so enabling RLS does not restrict service_role; the explicit
-- grants in §6 are what let it operate. The only owner-facing surface is the
-- four SECURITY DEFINER RPCs in §8, each gated by autopilot_private.is_operator()
-- internally.

alter table autopilot.ideas enable row level security;
alter table autopilot.content_items enable row level security;
alter table autopilot.runs enable row level security;
alter table autopilot.approvals enable row level security;
alter table autopilot.post_results enable row level security;
alter table autopilot.metrics_snapshots enable row level security;
alter table autopilot.playbook_rules enable row level security;
alter table autopilot.owner_notes enable row level security;
alter table autopilot.settings enable row level security;
alter table autopilot.link_nonces enable row level security;

-- ============================================================================
-- 6. service_role grants
-- ============================================================================
--
-- Explicit CRUD grant across every table in one statement (rather than 10
-- near-identical per-table lines, which is the existing codebase's style for
-- 2-3 table migrations but gets repetitive at this size) — "service_role
-- owns this whole schema" is exactly the intended trust boundary (PRD §4.3:
-- "Supabase service-role key: runner + publisher only"). ALTER DEFAULT
-- PRIVILEGES covers tables/sequences added by *future* migrations in this
-- schema too, so nobody has to remember to re-grant.

grant select, insert, update, delete on all tables in schema autopilot to service_role;
grant usage, select on all sequences in schema autopilot to service_role;

alter default privileges in schema autopilot
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema autopilot
  grant usage, select on sequences to service_role;

-- ============================================================================
-- 7. updated_at maintenance
-- ============================================================================
--
-- Reuses autopilot_private.set_updated_at() (§1 above), Autopilot's own copy
-- of the platform's private.set_updated_at() (same 3-line body, same
-- schema-agnostic "just set new.updated_at = now()" implementation). Trigger
-- *creation* only needs the creating role's own privileges — not EXECUTE on
-- the function itself — so this works even though autopilot_private grants
-- EXECUTE to nobody but its owner.
--
-- Applied only where updated_at means something (see per-table comments in
-- §4 for why runs/approvals/metrics_snapshots/playbook_rules/owner_notes/
-- link_nonces are deliberately excluded).

create trigger set_ideas_updated_at
before update on autopilot.ideas
for each row
execute function autopilot_private.set_updated_at();

create trigger set_content_items_updated_at
before update on autopilot.content_items
for each row
execute function autopilot_private.set_updated_at();

create trigger set_post_results_updated_at
before update on autopilot.post_results
for each row
execute function autopilot_private.set_updated_at();

create trigger set_settings_updated_at
before update on autopilot.settings
for each row
execute function autopilot_private.set_updated_at();

-- ============================================================================
-- 8. Owner-gated RPCs (SECURITY DEFINER, autopilot_private.is_operator()-gated)
-- ============================================================================
--
-- Live in `public`, not `autopilot` — PostgREST/supabase-js can only reach
-- functions in an exposed schema, and `autopilot` deliberately isn't on that
-- list, so the RPC façade has to sit in `public`. Parameters are `p_`-prefixed
-- rather than the bare names used in the ticket's prose signatures — matching
-- the only existing precedent for a client-callable SECURITY DEFINER RPC in
-- the platform codebase (public.claim_gift's p_gift_id/p_device_token/…), and
-- sidestepping a real ambiguous-column problem in ap_settings (its
-- `key`/`value` parameters would otherwise collide with autopilot.settings'
-- own `key`/`value` columns). Exact signatures are documented in
-- autopilot/src/db/types.ts and autopilot/src/db/README.md — that's the
-- source of truth for callers.
--
-- All four raise a `not authorized` (42501) exception when the caller isn't
-- an operator, rather than silently returning nothing — a consistent,
-- debuggable contract across reads and writes alike. See the AP-813
-- adaptation note at the top of this file for what autopilot_private.is_operator()
-- checks (local/network-boundary gate today; swaps for a real JWT check in
-- hosted mode without touching any of these four call sites).

-- ap_queue: the review queue. With no filter, returns exactly what the Atlas
-- Queue tab (PRD §10.1) needs to render — items waiting on a human decision.
-- Asset URLs are inside the returned row's own `assets` column (no separate
-- unpacking needed — "with asset URLs" just means that field isn't omitted).
create or replace function public.ap_queue(p_status_filter text default null)
returns setof autopilot.content_items
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not autopilot_private.is_operator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_status_filter is null then
    return query
      select *
      from autopilot.content_items
      where status in ('pending_review', 'changes_requested')
      order by slot_at asc;
  else
    return query
      select *
      from autopilot.content_items
      where status = p_status_filter::autopilot.ap_status
      order by slot_at asc;
  end if;
end;
$$;

revoke execute on function public.ap_queue(text) from public, anon;
grant execute on function public.ap_queue(text) to authenticated;

-- ap_decide: writes one approvals row and CAS-transitions the content_item
-- (guarded on status='pending_review', per the ticket spec) in one
-- transaction. Returns the item's new row.
--
-- DEVIATION / OPEN QUESTION: `decision` is constrained to the PRD's literal
-- three values (approved/rejected/edited), matching
-- autopilot/src/types.mjs's DECISIONS constant exactly (that file's own
-- STATUSES constant separately confirms 'changes_requested' is a real
-- content_items.status). I did NOT add a fourth 'changes_requested' decision
-- value, even though PRD §10.1 describes a distinct "Request changes" UI
-- action alongside Approve/Approve-with-edit/Reject. Neither the PRD's DDL
-- comment nor the already-landed FileStore contract wires that action to a
-- decision value, so I chose not to invent one unilaterally — this needs an
-- explicit call from Fable/owner: either extend this CHECK to 4 values (and
-- this function's mapping) or handle "request changes" outside ap_decide
-- entirely (e.g. the CLI's `regen` verb writing directly via service_role).
-- Until then, ap_decide only ever lands an item in 'approved' or 'skipped'.
--
-- 'approved' and 'edited' both resolve to content_items.status='approved';
-- 'edited' is the only path allowed to change `caption` (caption_after is
-- silently ignored for the other two decisions, so a plain Approve/Reject
-- call can't sneak a caption change through). `via` is hardcoded to 'atlas'
-- — this RPC is autopilot_private.is_operator()-gated, i.e. exclusively the
-- Atlas Studio surface; CLI and email-link approvals write via service_role
-- directly and never pass through here, per PRD §4.3/§10.3.
create or replace function public.ap_decide(
  p_item_id uuid,
  p_decision text,
  p_reason_tags text[] default null,
  p_note text default null,
  p_caption_after text default null
)
returns autopilot.content_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_caption text;
  v_new_status autopilot.ap_status;
  v_final_caption text;
  v_caption_diff jsonb;
  v_item autopilot.content_items;
begin
  if not autopilot_private.is_operator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected', 'edited') then
    raise exception 'invalid decision: % (expected approved|rejected|edited)', p_decision
      using errcode = '22023';
  end if;

  -- Explicit casts are required here, not decorative: with every CASE branch
  -- an unqualified text literal, Postgres resolves the expression's type as
  -- plain `text` before the assignment happens, and there is no implicit
  -- text→enum cast for a user-defined enum — unlike `WHERE status =
  -- 'literal'` elsewhere in this file, where the column's own enum type
  -- gives the literal its type directly. Omitting these casts would fail at
  -- runtime with "operator does not exist" or a type-mismatch error.
  v_new_status := case p_decision
    when 'rejected' then 'skipped'::autopilot.ap_status
    else 'approved'::autopilot.ap_status  -- 'approved' and 'edited' both land the item in 'approved'
  end;

  -- Row lock doubles as the CAS read: nothing else can flip this item's
  -- status until this transaction commits or rolls back.
  select caption into v_old_caption
  from autopilot.content_items
  where id = p_item_id and status = 'pending_review'
  for update;

  if not found then
    raise exception 'content item % is not pending_review (or does not exist)', p_item_id
      using errcode = 'P0002';
  end if;

  v_final_caption := case
    when p_decision = 'edited' and nullif(btrim(p_caption_after), '') is not null
      then btrim(p_caption_after)
    else v_old_caption
  end;

  if p_decision = 'edited' and v_final_caption is distinct from v_old_caption then
    v_caption_diff := jsonb_build_object('before', v_old_caption, 'after', v_final_caption);
  end if;

  -- CAS on the write too (belt-and-suspenders with the row lock above,
  -- matching the ticket's literal "CAS (where status='pending_review')").
  update autopilot.content_items
  set status = v_new_status,
      caption = v_final_caption,
      chosen = (v_new_status = 'approved'),  -- PRD defines `chosen` but never wires it elsewhere; this is that wiring
      updated_at = now()
  where id = p_item_id and status = 'pending_review'
  returning * into v_item;

  if not found then
    raise exception 'content item % changed status concurrently', p_item_id
      using errcode = 'P0002';
  end if;

  insert into autopilot.approvals (content_item_id, decision, reason_tags, note, caption_diff, via)
  values (p_item_id, p_decision, p_reason_tags, p_note, v_caption_diff, 'atlas');

  return v_item;
end;
$$;

revoke execute on function public.ap_decide(uuid, text, text[], text, text) from public, anon;
grant execute on function public.ap_decide(uuid, text, text[], text, text) to authenticated;

-- ap_rules: approve (proposed→active) or retire (proposed|active→retired) a
-- playbook rule. CAS via the UPDATE...WHERE status guard; `not found` means
-- either a bad id or a status that's not eligible for that action.
create or replace function public.ap_rules(
  p_action text,
  p_rule_id uuid
)
returns autopilot.playbook_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule autopilot.playbook_rules;
begin
  if not autopilot_private.is_operator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_action not in ('approve', 'retire') then
    raise exception 'invalid action: % (expected approve|retire)', p_action
      using errcode = '22023';
  end if;

  if p_action = 'approve' then
    update autopilot.playbook_rules
    set status = 'active', decided_at = now()
    where id = p_rule_id and status = 'proposed'
    returning * into v_rule;
  else
    update autopilot.playbook_rules
    set status = 'retired', decided_at = now()
    where id = p_rule_id and status in ('proposed', 'active')
    returning * into v_rule;
  end if;

  if not found then
    raise exception 'playbook rule % not eligible for action % (wrong status or not found)', p_rule_id, p_action
      using errcode = 'P0002';
  end if;

  return v_rule;
end;
$$;

revoke execute on function public.ap_rules(text, uuid) from public, anon;
grant execute on function public.ap_rules(text, uuid) to authenticated;

-- ap_settings: upsert one kv row. #variable_conflict is set defensively —
-- p_key/p_value don't actually collide with the table's key/value columns
-- anywhere in this body (the VALUES list of an INSERT isn't correlated to
-- the target table's own columns, and ON CONFLICT/SET targets are resolved
-- by grammar position, not name lookup) — but the pragma costs nothing and
-- removes any doubt.
create or replace function public.ap_settings(
  p_key text,
  p_value jsonb
)
returns autopilot.settings
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_variable
declare
  v_setting autopilot.settings;
begin
  if not autopilot_private.is_operator() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if nullif(btrim(p_key), '') is null then
    raise exception 'settings key must not be blank' using errcode = '22023';
  end if;

  insert into autopilot.settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update
  set value = excluded.value,
      updated_at = now()
  returning * into v_setting;

  return v_setting;
end;
$$;

revoke execute on function public.ap_settings(text, jsonb) from public, anon;
grant execute on function public.ap_settings(text, jsonb) to authenticated;

-- ============================================================================
-- 9. Seed data
-- ============================================================================
--
-- Four settings rows, matching the ticket's literal ask exactly (settings is
-- a kv table, so these are four separate rows, not one combined blob).
-- `cadence` encodes PRD §6.2's daily timetable verbatim, plus D-6's cadence
-- default (1 TikTok/day + 1 IG/day, quiet: none) folded in since it's the
-- same "cadence" concept — the planner needs both the schedule and the mix
-- floors from the same settings key.

insert into autopilot.settings (key, value) values
  ('kill_switch', 'false'::jsonb),
  ('autonomy_level', '"L1"'::jsonb),
  ('timezone', '"Europe/Tirane"'::jsonb),
  ('cadence', $cadence$
  {
    "schedule": [
      { "stage": "plan", "day": "sun", "time": "18:00", "note": "build next week's slot plan" },
      { "stage": "generate", "day": "daily", "time": "05:30", "note": "generate+render+qa for T+1 slots, 3 candidates each" },
      { "stage": "digest", "day": "daily", "time": "07:30", "note": "Resend email + queue ready" },
      { "stage": "publish", "day": "daily", "time_start": "17:00", "time_end": "21:00", "jitter_minutes": 10 },
      { "stage": "metrics", "day": "daily", "time": "22:00" },
      { "stage": "reflect", "day": "daily", "time": "23:00", "note": "nightly-lite" },
      { "stage": "report", "day": "mon", "time": "07:00", "note": "weekly report + bandit re-weight" }
    ],
    "mix": { "tiktok_per_day": 1, "instagram_per_day": 1 },
    "platform_mix_floors": { "instagram_carousels_per_week_min": 2, "tiktoks_per_week_min": 4 },
    "max_per_day_per_channel": 1,
    "quiet_days": []
  }
  $cadence$::jsonb);
