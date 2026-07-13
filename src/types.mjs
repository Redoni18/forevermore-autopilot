/**
 * @file Shared enums + JSDoc type contracts for the Autopilot pipeline core.
 *
 * These mirror PRD §5 (ContentItem file-mode JSON) and §6.1 (state machine).
 * There is no TypeScript build step — types are expressed as JSDoc `@typedef`
 * so editors and `tsc --checkJs` (if ever run) can validate, while the runtime
 * stays plain ESM with zero dependencies.
 *
 * The Supabase DDL (ticket AP-102) is the eventual source of truth for column
 * names; the file-mode shapes here are kept field-for-field compatible so the
 * `FileStore → SupabaseStore` swap is a config flip, not a rewrite.
 */

/** Ordered list of pipeline stages (PRD §6.2 timetable). @type {readonly string[]} */
export const STAGES = ['plan', 'generate', 'render', 'qa', 'digest'];

/** ap_platform (PRD §5). @type {readonly string[]} */
export const PLATFORMS = ['instagram', 'tiktok'];

/** ap_format (PRD §5). @type {readonly string[]} */
export const FORMATS = ['reel', 'carousel', 'image', 'story', 'tiktok_video'];

/** ap_risk (PRD §5). `sensitive` items never auto-post and need atlas approval. */
export const RISKS = ['evergreen', 'standard', 'sensitive'];

/** ap_status — the full lifecycle (PRD §5 enum + §6.1 diagram). @type {readonly string[]} */
export const STATUSES = [
  'planned',
  'drafting',
  'drafted',
  'rendering',
  'rendered',
  'qa_failed',
  'pending_review',
  'changes_requested',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'publish_failed',
  'skipped',
  'measured',
  'archived',
];

/**
 * Approval decisions (PRD §5 approvals table). Reconciled at AP-801:
 * 'changes_requested' is a first-class human decision (consequence: regen),
 * distinct from 'rejected' (consequence: skip). Matches the DB CHECK in
 * 20260713090000_autopilot_schema.sql and the review station.
 */
export const DECISIONS = ['approved', 'rejected', 'edited', 'changes_requested'];

/**
 * Canonical rejection / change-request reason tags (PRD §5 approvals.reason_tags).
 * Used by `reject`/`regen` CLI verbs and, later, the reflection loop.
 * 'other' requires a free-text note (enforced by the review surfaces).
 */
export const REASON_TAGS = [
  'hook-weak',
  'off-voice',
  'wrong-world',
  'too-salesy',
  'timing',
  'duplicate',
  'other',
];

/**
 * @typedef {Object} AssetRef
 * @property {'poster'|'video'|'capture'} kind
 * @property {string} path            Path relative to the item dir, e.g. "assets/final.mp4".
 * @property {string} [storage_url]   Public URL once uploaded (M1).
 * @property {number} [w]
 * @property {number} [h]
 * @property {number} [dur_s]
 * @property {string} [sha256]
 */

/**
 * @typedef {Object} LintResult
 * @property {boolean} passed
 * @property {Array<{rule:string, severity:'block'|'warn', excerpt?:string}>} violations
 * @property {Object} [visual]        Reserved for AP-402 visual-QA verdicts.
 */

/**
 * ContentItem v1 — the normative file-mode record (PRD §5).
 * Persisted at `outbox/<id>/item.json`.
 *
 * @typedef {Object} ContentItem
 * @property {string} id                       e.g. "ci_20260714_ig_1".
 * @property {string} slot_at                  ISO-8601 w/ owner-local offset, e.g. "2026-07-14T17:30:00+02:00".
 * @property {'instagram'|'tiktok'} platform
 * @property {'reel'|'carousel'|'image'|'story'|'tiktok_video'} format
 * @property {string|null} idea_id             References ideas.json id (null = off-list brain proposal).
 * @property {string|null} series_key
 * @property {string|null} pillar
 * @property {'evergreen'|'standard'|'sensitive'} risk
 * @property {string} status                   One of STATUSES.
 * @property {string} candidate_group          Shared by the N candidates for one slot.
 * @property {boolean} chosen                  True once approved as the slot's post.
 * @property {string|null} caption
 * @property {string[]} hashtags
 * @property {Object} overlays                 { hook?, beats?[], cta? } — kinetic/poster text.
 * @property {string|null} link_utm
 * @property {AssetRef[]} assets
 * @property {LintResult|null} lint
 * @property {Object|null} dedupe              { hook_sim, nearest_item, method }.
 * @property {Object|null} [rationale]         Thinking log (AP-831): { summary, hook_reasoning,
 *   strategy:{idea_id, idea_title, pillar, playbook_rules:[{id,rule}]}, craft[], limits[], audience }.
 * @property {Object|null} [sources]           Source log (AP-833): { plan:{picked_because, score, runners_up…},
 *   generation:{brand_guide, skill, playbook_rules, idea, format_spec, recent_posts, feedback, variant, prompt_sha} }.
 * @property {string|null} produced_by         Run id of the stage that last produced this item.
 * @property {number} attempt                  Draft/QA attempt counter (1-based).
 * @property {string|null} regen_of            Item id this is a regeneration of.
 * @property {number} [regen_count]            changes_requested → drafting bounces used.
 * @property {number} [publish_attempts]       publish_failed → publishing retries used.
 * @property {string|null} [next_attempt_at]   ISO time the next publish retry is allowed.
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Run record (PRD §5 runs table). Every stage execution writes one; every
 * state transition writes a compact child run (`stage:"transition"`, `parent_run`).
 *
 * @typedef {Object} Run
 * @property {string} id
 * @property {string} stage
 * @property {'running'|'ok'|'failed'} status
 * @property {string} [driver]                 claude-cli | agent-sdk | fixture | deterministic
 * @property {string} [model]
 * @property {string} [prompt_sha]
 * @property {number} [tokens_in]
 * @property {number} [tokens_out]
 * @property {number} [cost_usd]
 * @property {string} started_at
 * @property {string} [finished_at]
 * @property {string} [error]
 * @property {string} [log_path]
 * @property {string} [item_id]                Set for transition runs.
 * @property {string} [from]                   Set for transition runs.
 * @property {string} [to]                     Set for transition runs.
 * @property {string} [note]
 * @property {string} [parent_run]             Set for transition runs.
 * @property {string} [date]                   Operating date the run targeted.
 */

/**
 * Approval record (PRD §5 approvals table).
 *
 * @typedef {Object} Approval
 * @property {string} id
 * @property {string} content_item_id
 * @property {'approved'|'rejected'|'edited'} decision
 * @property {string[]} [reason_tags]
 * @property {string} [note]
 * @property {{before:string, after:string}} [caption_diff]
 * @property {'atlas'|'email-link'|'cli'} via
 * @property {string} decided_at
 */

/**
 * The Store contract (ticket AP-103). Both FileStore (M0) and SupabaseStore
 * (M1 stub) implement it identically.
 *
 * @typedef {Object} Store
 * @property {(id:string)=>Promise<ContentItem|null>} getItem
 * @property {(item:ContentItem)=>Promise<ContentItem>} putItem
 * @property {(id:string, from:string, to:string, patch?:Object)=>Promise<ContentItem>} transition
 *   Compare-and-swap: applies `patch` and sets status=`to` only if the current
 *   status equals `from`; throws {@link CasConflictError} otherwise.
 * @property {(status:string|string[])=>Promise<ContentItem[]>} listByStatus
 * @property {(filter?:(i:ContentItem)=>boolean)=>Promise<ContentItem[]>} listItems
 * @property {(run:Partial<Run>)=>Promise<Run>} appendRun
 * @property {(id:string, patch:Partial<Run>)=>Promise<Run>} updateRun
 * @property {(id:string)=>Promise<Run|null>} getRun
 *   Fetch a run by id (the producing-run join behind item.provenance, AP-831).
 * @property {(approval:Partial<Approval>)=>Promise<Approval>} appendApproval
 * @property {(itemId:string)=>Promise<Approval[]>} listApprovals
 * @property {(status?:string)=>Promise<Array<{id:string,rule:string,category?:string,weight?:number}>>} listPlaybookRules
 *   Active learned rules for brain injection (PRD §8.1), weight-desc.
 * @property {()=>Promise<Object>} getSettings
 * @property {(key:string)=>Promise<*>} getSetting
 * @property {(key:string, value:*)=>Promise<void>} setSetting
 * @property {(runId:string, entry:Object)=>Promise<void>} appendLog
 */

/**
 * Brain driver contract (PRD §8.2). The generate stage depends on this;
 * the real drivers (claude-cli / agent-sdk) land in ticket AP-301 under
 * `src/brain/`. A built-in fixture driver satisfies it so the pipeline runs
 * end-to-end today.
 *
 * @typedef {Object} StageRequest
 * @property {string} stage           'copywriter' | 'planner' | 'artdirector' | 'regen' | ...
 * @property {ContentItem} item
 * @property {Object} [idea]          The ideas.json payload for item.idea_id.
 * @property {Object} [context]       Brand law, active rules, recent-post digest, feedback.
 * @property {number} [n]             How many variants to return.
 *
 * @typedef {Object} StageResult
 * @property {string} [caption]
 * @property {string[]} [hashtags]
 * @property {Object} [overlays]      { hook?, beats?[], cta? }
 * @property {Object} [meta]          { driver, model, prompt_sha, tokens_in, tokens_out, cost_usd }
 *
 * @typedef {Object} BrainDriver
 * @property {string} name
 * @property {(req:StageRequest)=>Promise<StageResult>} complete
 */

/**
 * Lint function seam (real engine = ticket AP-401 under `src/lint/`, bridged
 * by `src/drivers/brand-lint.mjs`). ctx (optional) is the stage context
 * ({store, config, …}) — the bridge uses it to build the dedupe corpus.
 * The result may carry an extra `dedupe` field which the qa stage persists
 * onto the item (PRD §5).
 * @typedef {(item:ContentItem, ctx?:Object)=>Promise<LintResult>|LintResult} LintFn
 */

/**
 * Renderer adapter bundle (ticket AP-203). Each returns the asset descriptors
 * it wrote into the item's `assets/` dir.
 * @typedef {Object} RendererAdapters
 * @property {(item:ContentItem, opts:Object)=>Promise<AssetRef[]>} renderPoster
 * @property {(item:ContentItem, opts:Object)=>Promise<AssetRef[]>} renderVideo
 * @property {(item:ContentItem, opts:Object)=>Promise<AssetRef[]>} capture
 */

/** Error thrown when a CAS transition's `from` does not match current status. */
export class CasConflictError extends Error {
  /** @param {string} id @param {string} expected @param {string} actual */
  constructor(id, expected, actual) {
    super(`CAS conflict on ${id}: expected status "${expected}" but found "${actual}"`);
    this.name = 'CasConflictError';
    this.code = 'CAS_CONFLICT';
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Error thrown when a requested state transition is not in the transition table. */
export class IllegalTransitionError extends Error {
  /** @param {string} from @param {string} to */
  constructor(from, to) {
    super(`Illegal transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.code = 'ILLEGAL_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

/** Error thrown when a lockfile could not be acquired within the timeout. */
export class LockTimeoutError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Timed out acquiring lock for ${id}`);
    this.name = 'LockTimeoutError';
    this.code = 'LOCK_TIMEOUT';
    this.id = id;
  }
}
