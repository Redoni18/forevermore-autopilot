/**
 * @file Pure TypeScript mirror of the `autopilot` Postgres schema.
 *
 * Source of truth: supabase/migrations/20260713090000_autopilot_schema.sql
 * (ticket AP-102). That migration is WRITTEN BUT NOT PUSHED — owner review
 * required (PRD decision D-4) — so nothing here has run against a live
 * database yet; it's a hand-authored mirror, not a generated one.
 *
 * No imports. This file is pure types (interfaces + type aliases only, zero
 * runtime code), so it has no module-resolution or bundler requirements and
 * either store implementation (FileStore or SupabaseStore, ticket AP-103)
 * can reference it without pulling in the other's dependencies.
 *
 * Relationship to autopilot/src/types.mjs: that file (already landed by the
 * parallel AP-201/AP-103 session) carries the SAME contract as JSDoc
 * `@typedef`s for the plain-ESM runtime (no build step, `tsc --checkJs` /
 * editors validate it). This file is the DB-schema-derived counterpart:
 * Row/Insert shapes for every table, plus the same file-mode ContentItem
 * shape (`ContentItemFileV1` below) for cross-checking. The two are
 * deliberately NOT wired together (this file imports nothing, per spec) —
 * they were cross-checked by hand for field parity while this migration was
 * written (see the migration's header comment), but nothing enforces that
 * parity mechanically today. Worth an explicit decision at the AP-801
 * integration pass: either keep them hand-synced, or generate one from the
 * other once the dust settles.
 *
 * Naming convention: `<Table>Row` = shape as read back from Postgres.
 * `<Table>Insert` = shape accepted on insert (columns with a DB DEFAULT, or
 * that are nullable, are optional; `generated always as identity` columns
 * are omitted entirely, since Postgres rejects an explicit value for them
 * unless the insert uses OVERRIDING SYSTEM VALUE).
 *
 * Timestamps (`timestamp with time zone`) are typed `string` (ISO 8601, as
 * returned by supabase-js/PostgREST) — never `Date`. `date` columns are
 * typed `string` too (`YYYY-MM-DD`). `uuid` columns are `string`. Postgres
 * `numeric` columns are typed `number`; supabase-js returns them as JS
 * numbers for values in this schema's realistic ranges (cost_usd, rates),
 * but be aware `numeric` has no hard precision ceiling in Postgres the way
 * `number` does in JS. `bigint` (metrics_snapshots.id) is typed `number` for
 * the same practical reason — Postgres identity sequences here won't
 * realistically exceed Number.MAX_SAFE_INTEGER.
 */

// ============================================================================
// Generic JSON value (Supabase-generated-types convention — self-contained,
// no import needed).
// ============================================================================

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ============================================================================
// True Postgres enums (autopilot.ap_platform / ap_format / ap_status /
// ap_risk) — labels and order match the migration exactly.
// ============================================================================

export type ApPlatform = 'instagram' | 'tiktok';

export type ApFormat = 'reel' | 'carousel' | 'image' | 'story' | 'tiktok_video';

export type ApStatus =
  | 'planned'
  | 'drafting'
  | 'drafted'
  | 'rendering'
  | 'rendered'
  | 'qa_failed'
  | 'pending_review'
  | 'changes_requested'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'publish_failed'
  | 'skipped'
  | 'measured'
  | 'archived';

/** sensitive = memorial/kids/UGC → never auto-published, atlas-only approval. */
export type ApRisk = 'evergreen' | 'standard' | 'sensitive';

// ============================================================================
// `text` columns with a CHECK constraint in the migration — not real
// Postgres enums, but just as closed a vocabulary, so they get the same
// string-literal-union treatment here.
// ============================================================================

/**
 * approvals.decision. Reconciled at wave-1 integration (AP-801):
 * 'changes_requested' is a first-class human decision (consequence: regen),
 * distinct from 'rejected' (consequence: skip). Matches the migration CHECK
 * and the review station's decision set; types.mjs DECISIONS aligned there.
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'edited' | 'changes_requested';

export type ApprovalVia = 'atlas' | 'email-link' | 'cli' | 'local-station';

/**
 * approvals.reason_tags element type. NOT DB-enforced (see the migration's
 * comment on approvals.reason_tags) — this union is the canonical set
 * mirrored from autopilot/src/types.mjs's REASON_TAGS, widened with
 * `(string & {})` so new tags reflection proposes don't require a type
 * change here, while editors still suggest the known set.
 */
export type ApprovalReasonTag =
  | 'hook-weak'
  | 'off-voice'
  | 'wrong-world'
  | 'too-salesy'
  | 'timing'
  | 'duplicate'
  | (string & {});

export type RunStage = 'plan' | 'generate' | 'render' | 'qa' | 'digest' | 'publish' | 'metrics' | 'reflect';

export type RunStatus = 'running' | 'ok' | 'failed';

/**
 * runs.driver. NOT DB-enforced (see the migration's comment on runs.driver —
 * a CHECK would block AP-301's `mock` driver). Widened the same way as
 * ApprovalReasonTag: known values suggested, anything accepted.
 */
export type RunDriver = 'claude-cli' | 'agent-sdk' | 'deterministic' | 'mock' | (string & {});

export type PlaybookRuleStatus = 'proposed' | 'active' | 'retired';

export type PlaybookRuleSource = 'owner' | 'reflection';

export type PlaybookRuleCategory = 'hook' | 'caption' | 'format' | 'timing' | 'world' | 'visual';

export type PostResultPublishMode = 'ig_api' | 'tiktok_inbox' | 'tiktok_direct' | 'manual';

export type MetricsSource = 'ig_api' | 'tiktok_csv' | 'manual';

// ============================================================================
// Structured JSONB shapes (documented in PRD §5's inline comments).
// ============================================================================

export interface ContentAsset {
  kind: 'poster' | 'video' | 'capture';
  /** Path relative to the item dir, e.g. "assets/final.mp4" (file mode) or a storage object key (DB mode). */
  path: string;
  /** Public URL once uploaded — the "asset URLs" ap_queue()'s doc comment refers to. */
  storage_url?: string;
  w?: number;
  h?: number;
  dur_s?: number;
  sha256?: string;
}

export interface LintViolation {
  rule: string;
  severity: 'block' | 'warn';
  excerpt?: string;
}

export interface LintReport {
  passed: boolean;
  violations: LintViolation[];
  /** Reserved for AP-402 visual-QA verdicts. */
  visual?: Json;
}

export interface DedupeInfo {
  hook_sim: number;
  nearest_item?: string | null;
  method?: string;
}

/**
 * content_items.overlays / ContentItemFileV1.overlays. PRD §5's own example
 * only shows `{ hook, beats }`; `cta` is inferred from §8.1's copywriter
 * duty ("caption + hook + overlays + hashtags" — CTA has to live somewhere,
 * and there's no dedicated column for it). Left open with an index
 * signature since the copywriter agent's actual output shape may grow
 * beyond what's confirmed today.
 */
export interface ContentOverlays {
  hook?: string;
  beats?: string[];
  cta?: string;
  [key: string]: Json | string[] | undefined;
}

export interface CaptionDiff {
  before: string | null;
  after: string | null;
}

// ============================================================================
// Table mirrors — Row (as read) / Insert (as written).
// ============================================================================

// ---- autopilot.ideas --------------------------------------------------

export interface IdeaRow {
  id: string;
  payload: Json;
  pillar: string;
  format_family: string;
  active: boolean;
  attempts: number;
  wins: number;
  losses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaInsert {
  id: string;
  payload: Json;
  pillar: string;
  format_family: string;
  active?: boolean;
  attempts?: number;
  wins?: number;
  losses?: number;
  last_used_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ---- autopilot.runs -----------------------------------------------------

export interface RunRow {
  id: string;
  stage: RunStage;
  status: RunStatus;
  driver: RunDriver | null;
  model: string | null;
  prompt_sha: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  log_path: string | null;
}

export interface RunInsert {
  id?: string;
  stage: RunStage;
  status?: RunStatus;
  driver?: RunDriver | null;
  model?: string | null;
  prompt_sha?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  started_at?: string;
  finished_at?: string | null;
  error?: string | null;
  log_path?: string | null;
}

// ---- autopilot.content_items ---------------------------------------------

export interface ContentItemRow {
  id: string;
  slot_at: string;
  platform: ApPlatform;
  format: ApFormat;
  idea_id: string | null;
  series_key: string | null;
  pillar: string | null;
  risk: ApRisk;
  status: ApStatus;
  candidate_group: string | null;
  chosen: boolean;
  caption: string | null;
  hashtags: string[] | null;
  overlays: ContentOverlays | null;
  link_utm: string | null;
  assets: ContentAsset[] | null;
  lint: LintReport | null;
  dedupe: DedupeInfo | null;
  produced_by: string | null;
  attempt: number;
  regen_of: string | null;
  /** Not in the PRD §5 sketch — added for parity with autopilot/src/types.mjs's ContentItem typedef; see migration comment. */
  regen_count: number;
  publish_attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentItemInsert {
  id?: string;
  slot_at: string;
  platform: ApPlatform;
  format: ApFormat;
  idea_id?: string | null;
  series_key?: string | null;
  pillar?: string | null;
  risk?: ApRisk;
  status?: ApStatus;
  candidate_group?: string | null;
  chosen?: boolean;
  caption?: string | null;
  hashtags?: string[] | null;
  overlays?: ContentOverlays | null;
  link_utm?: string | null;
  assets?: ContentAsset[] | null;
  lint?: LintReport | null;
  dedupe?: DedupeInfo | null;
  produced_by?: string | null;
  attempt?: number;
  regen_of?: string | null;
  regen_count?: number;
  publish_attempts?: number;
  next_attempt_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ---- autopilot.approvals --------------------------------------------------

export interface ApprovalRow {
  id: string;
  content_item_id: string;
  decision: ApprovalDecision;
  reason_tags: ApprovalReasonTag[] | null;
  note: string | null;
  caption_diff: CaptionDiff | null;
  via: ApprovalVia;
  decided_at: string;
}

export interface ApprovalInsert {
  id?: string;
  content_item_id: string;
  decision: ApprovalDecision;
  reason_tags?: ApprovalReasonTag[] | null;
  note?: string | null;
  caption_diff?: CaptionDiff | null;
  via: ApprovalVia;
  decided_at?: string;
}

// ---- autopilot.post_results ------------------------------------------------

export interface PostResultRow {
  content_item_id: string;
  platform_post_id: string | null;
  permalink: string | null;
  publish_mode: PostResultPublishMode;
  posted_at: string | null;
  raw: Json | null;
  created_at: string;
  updated_at: string;
}

export interface PostResultInsert {
  content_item_id: string;
  platform_post_id?: string | null;
  permalink?: string | null;
  publish_mode: PostResultPublishMode;
  posted_at?: string | null;
  raw?: Json | null;
  created_at?: string;
  updated_at?: string;
}

// ---- autopilot.metrics_snapshots -------------------------------------------

export interface MetricsSnapshotRow {
  id: number;
  content_item_id: string | null;
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  avg_watch_ms: number | null;
  completion_rate: number | null;
  reach: number | null;
  follows: number | null;
  source: MetricsSource;
  raw: Json | null;
}

/** `id` is deliberately absent: `generated always as identity` rejects an explicit value by default. */
export interface MetricsSnapshotInsert {
  content_item_id?: string | null;
  captured_at?: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  avg_watch_ms?: number | null;
  completion_rate?: number | null;
  reach?: number | null;
  follows?: number | null;
  source: MetricsSource;
  raw?: Json | null;
}

// ---- autopilot.playbook_rules ----------------------------------------------

export interface PlaybookRuleRow {
  id: string;
  rule: string;
  category: PlaybookRuleCategory;
  status: PlaybookRuleStatus;
  source: PlaybookRuleSource;
  evidence: Json | null;
  weight: number;
  created_at: string;
  decided_at: string | null;
}

export interface PlaybookRuleInsert {
  id?: string;
  rule: string;
  category: PlaybookRuleCategory;
  status?: PlaybookRuleStatus;
  source: PlaybookRuleSource;
  evidence?: Json | null;
  weight?: number;
  created_at?: string;
  decided_at?: string | null;
}

// ---- autopilot.owner_notes -------------------------------------------------

export interface OwnerNoteRow {
  id: string;
  text: string;
  applies_from: string | null;
  processed: boolean;
  processed_at: string | null;
  created_at: string;
}

export interface OwnerNoteInsert {
  id?: string;
  text: string;
  applies_from?: string | null;
  processed?: boolean;
  processed_at?: string | null;
  created_at?: string;
}

// ---- autopilot.settings -----------------------------------------------------

export interface SettingRow {
  key: string;
  value: Json;
  updated_at: string;
}

export interface SettingInsert {
  key: string;
  value: Json;
  updated_at?: string;
}

// ---- autopilot.link_nonces ---------------------------------------------------

export interface LinkNonceRow {
  sig: string;
  used_at: string | null;
  created_at: string;
}

export interface LinkNonceInsert {
  sig: string;
  used_at?: string | null;
  created_at?: string;
}

// ============================================================================
// Aggregate map (Supabase-generated-`Database`-type convention). Purely a
// convenience for generic helpers like `Row<'content_items'>`; not required
// reading.
// ============================================================================

export interface AutopilotDatabase {
  ideas: { Row: IdeaRow; Insert: IdeaInsert };
  content_items: { Row: ContentItemRow; Insert: ContentItemInsert };
  runs: { Row: RunRow; Insert: RunInsert };
  approvals: { Row: ApprovalRow; Insert: ApprovalInsert };
  post_results: { Row: PostResultRow; Insert: PostResultInsert };
  metrics_snapshots: { Row: MetricsSnapshotRow; Insert: MetricsSnapshotInsert };
  playbook_rules: { Row: PlaybookRuleRow; Insert: PlaybookRuleInsert };
  owner_notes: { Row: OwnerNoteRow; Insert: OwnerNoteInsert };
  settings: { Row: SettingRow; Insert: SettingInsert };
  link_nonces: { Row: LinkNonceRow; Insert: LinkNonceInsert };
}

export type AutopilotTableName = keyof AutopilotDatabase;

// ============================================================================
// RPC contracts — the four SECURITY DEFINER functions in `public` (not
// `autopilot`) that the migration defines. Parameter names match the SQL
// exactly (`p_`-prefixed — see the migration's §6 header comment for why).
// This is the source of truth for callers (Atlas Studio / AP-502, the
// digest's action links / AP-503): use these shapes for
// `supabase.rpc('ap_decide', args satisfies ApDecideArgs)`-style calls.
// ============================================================================

export interface ApQueueArgs {
  p_status_filter?: ApStatus | null;
}
/** `setof autopilot.content_items` → an array over PostgREST. */
export type ApQueueResult = ContentItemRow[];

export interface ApDecideArgs {
  p_item_id: string;
  p_decision: ApprovalDecision;
  p_reason_tags?: ApprovalReasonTag[] | null;
  p_note?: string | null;
  /** Only applied when p_decision === 'edited'; ignored otherwise (see migration comment). */
  p_caption_after?: string | null;
}
export type ApDecideResult = ContentItemRow;

export interface ApRulesArgs {
  p_action: 'approve' | 'retire';
  p_rule_id: string;
}
export type ApRulesResult = PlaybookRuleRow;

export interface ApSettingsArgs {
  p_key: string;
  p_value: Json;
}
export type ApSettingsResult = SettingRow;

// ============================================================================
// Settings value shapes — supplementary, NOT part of the core table mirror
// (autopilot.settings.value is genuinely `jsonb` with no fixed shape at the
// column level; these document the four seeded rows for convenience).
// ============================================================================

export type AutopilotSettingsKey = 'kill_switch' | 'autonomy_level' | 'cadence' | 'timezone' | (string & {});

export interface CadenceScheduleEntry {
  stage: RunStage | 'report';
  day: 'daily' | 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
  time?: string;
  time_start?: string;
  time_end?: string;
  jitter_minutes?: number;
  note?: string;
}

/** Shape of the seeded `cadence` settings row (PRD §6.2 timetable + D-6 mix defaults). */
export interface CadenceSettings {
  schedule: CadenceScheduleEntry[];
  mix: { tiktok_per_day: number; instagram_per_day: number };
  platform_mix_floors: { instagram_carousels_per_week_min: number; tiktoks_per_week_min: number };
  max_per_day_per_channel: number;
  quiet_days: string[];
}

// ============================================================================
// File-mode (M0) cross-store contract — PRD §5 "File-mode mirror". This is
// the SAME logical shape as ContentItemRow, but for the pre-Supabase
// FileStore: `id`/`candidate_group`/`produced_by`/`regen_of` are
// deterministic slug strings (see autopilot/src/util/ids.mjs — e.g.
// "ci_20260714_ig_1", "cg_20260714_ig", "run_20260713T053012_generate_a1b2c3")
// rather than uuids, `hashtags`/`assets` default to `[]` rather than null,
// and `overlays` is a plain object rather than nullable. Field-for-field
// compatible with autopilot/src/types.mjs's ContentItem JSDoc typedef,
// including its regen_count/publish_attempts/next_attempt_at additions.
// ============================================================================

export interface ContentItemFileV1 {
  /** e.g. "ci_20260714_ig_1" — NOT a uuid in file mode. */
  id: string;
  /** ISO-8601 with the owner-local offset, e.g. "2026-07-14T17:30:00+02:00". */
  slot_at: string;
  platform: ApPlatform;
  format: ApFormat;
  idea_id: string | null;
  series_key: string | null;
  pillar: string | null;
  risk: ApRisk;
  status: ApStatus;
  /** e.g. "cg_20260714_ig" — shared by the N candidates for one slot. */
  candidate_group: string;
  chosen: boolean;
  caption: string | null;
  hashtags: string[];
  overlays: ContentOverlays;
  link_utm: string | null;
  assets: ContentAsset[];
  lint: LintReport | null;
  dedupe: DedupeInfo | null;
  /** Run id of the stage that last produced this item, e.g. "run_20260713T053012_generate_a1b2c3". */
  produced_by: string | null;
  attempt: number;
  regen_of: string | null;
  /** changes_requested → drafting bounces used (PRD §6.1: max 2). */
  regen_count?: number;
  /** publish_failed → publishing retries used (PRD §6.1: max 3, backoff 2^n·5m). */
  publish_attempts?: number;
  /** ISO time the next publish retry is allowed. */
  next_attempt_at?: string | null;
  created_at: string;
  updated_at: string;
}
