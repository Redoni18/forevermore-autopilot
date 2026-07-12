# `autopilot` schema — control plane (AP-102)

**Status: written, NOT pushed. Owner review required (PRD decision D-4).**
The migration lives at
`supabase/migrations/20260713090000_autopilot_schema.sql` and has not run
against any database — this directory documents what it *will* create once
approved. Nobody should run `supabase db push` / `migration up` against it
without an explicit go-ahead; this repo links straight to production.

This is ticket AP-102's contract. It's the DB-schema counterpart to
`autopilot/src/types.mjs` (the file-mode/M0 JSDoc contract from the parallel
AP-201/AP-103 build) — see [Relationship to the file-mode store](#relationship-to-the-file-mode-store)
below.

## What's here

| File | Purpose |
|---|---|
| `types.ts` | Pure TypeScript mirror of every table (`Row`/`Insert` shapes), the four check-constrained text unions, the RPC arg/result contracts, and the file-mode `ContentItemFileV1` type. No imports — safe for either store implementation to reference. |
| `README.md` | This file. |
| `../../../supabase/migrations/20260713090000_autopilot_schema.sql` | The actual DDL. Extensively commented inline — read it for the full reasoning behind every deviation from the PRD §5 sketch; this README summarizes. |

## Trust model (PRD §4.3)

- Schema `autopilot` is revoked from `public`/`anon`/`authenticated` at the
  schema level — a browser client can't even resolve `autopilot.*` by name,
  let alone query it.
- Every table has RLS **enabled** with **zero policies** for `anon`/
  `authenticated` — deny by default. This is defense-in-depth on top of the
  schema-level revoke, not the primary gate.
- `service_role` (held only by the runner + publisher processes — never
  shipped to a browser) reads/writes directly. It bypasses RLS via its
  `BYPASSRLS` Postgres role attribute, and has explicit `SELECT, INSERT,
  UPDATE, DELETE` grants on every table (plus `ALTER DEFAULT PRIVILEGES` so
  future tables in this schema inherit the same grant automatically).
- The **only** owner-facing path is Atlas Studio (a static SPA holding just
  the publishable key), which talks to four `SECURITY DEFINER` RPCs. Those
  RPCs live in **`public`**, not `autopilot` — PostgREST only exposes
  `public` (this schema deliberately isn't on the exposed-schemas list), so
  the RPC façade has to sit there, exactly like `public.is_admin_self()`
  already does. Each RPC calls `public.is_admin_self()` first and raises a
  `42501 not authorized` exception if the caller isn't an admin.

## Tables

| Table | Purpose | Notable |
|---|---|---|
| `ideas` | Runtime copy of `ideas.json` (137 ideas); bandit mutates `attempts/wins/losses/last_used_at`. | `pillar` (P1..P7) is free text — no CHECK, the catalog lives in git and can grow without a migration. |
| `runs` | One row per stage execution. | `stage` CHECK covers all 8 PRD stages (plan/generate/render/qa/digest/publish/metrics/reflect) even though AP-201 only wires 5 today. `driver` is **not** CHECK-constrained (would block AP-301's `mock` driver). |
| `content_items` | The pipeline's core record — one row per candidate post. | Has `regen_count`/`publish_attempts`/`next_attempt_at` beyond the PRD sketch, added for parity with `types.mjs`'s already-landed `ContentItem` typedef (needed to implement §6.1's bounded retries). |
| `approvals` | Append-only decision audit log. | `decision` CHECK is the PRD's literal 3 values (approved/rejected/edited) — see [Open questions](#open-questions). |
| `post_results` | 1:1 finalization row once published. | `publish_mode` CHECK: `ig_api \| tiktok_inbox \| tiktok_direct \| manual`. |
| `metrics_snapshots` | Time-series platform insights. | `content_item_id` nullable on purpose (AP-703 daily follower snapshots aren't tied to one post). |
| `playbook_rules` | The learning loop's memory. | Partial index on `(weight desc) where status='active'` — this is the hottest read path in the whole schema (every brain call injects active rules, PRD §8.1). |
| `owner_notes` | Free-text suggestion inbox. | `processed_at` added for an audit trail beyond the PRD's bare boolean. |
| `settings` | Generic kv store. | Seeded with `kill_switch`, `autonomy_level`, `cadence`, `timezone` (see below). |
| `link_nonces` | One-shot email action-link tokens (48h TTL). | `created_at` added — a TTL is unenforceable without knowing mint time. |

Full column lists, indexes, and FK `ON DELETE` rationale are in the
migration file itself (every table has a comment block explaining what was
kept from the PRD sketch, what was added, and why).

## RPCs

All four: `SECURITY DEFINER`, `set search_path = ''`, `EXECUTE` revoked from
`public`/`anon`, granted to `authenticated` (the real gate is
`is_admin_self()` inside the body). Parameter names are `p_`-prefixed —
matching the only existing precedent in this repo for a client-callable
`SECURITY DEFINER` RPC (`public.claim_gift`) — **not** the bare names in the
PRD/ticket prose. This file and `types.ts` are the source of truth for exact
signatures.

```ts
import type { ApQueueArgs, ApDecideArgs, ApRulesArgs, ApSettingsArgs } from './types.js';
```

### `ap_queue(p_status_filter text default null) → setof autopilot.content_items`
Read the review queue. No filter → items in `pending_review` or
`changes_requested` (what the Atlas Queue tab renders), ordered by
`slot_at`. With a filter → items matching that exact status. Asset URLs are
inside each row's own `assets` jsonb column.

```js
const { data } = await supabase.rpc('ap_queue', {}); // or { p_status_filter: 'approved' }
```

### `ap_decide(p_item_id uuid, p_decision text, p_reason_tags text[] default null, p_note text default null, p_caption_after text default null) → autopilot.content_items`
Writes one `approvals` row and CAS-transitions the item
(`where status = 'pending_review'`) in a single transaction; returns the
item's new row. `p_decision` is `'approved' | 'rejected' | 'edited'`.
`'approved'`/`'edited'` → item status `'approved'` (and `chosen = true`);
`'rejected'` → `'skipped'`. `p_caption_after` only takes effect when
`p_decision = 'edited'` — it's silently ignored otherwise, so a plain
approve/reject can't sneak a caption change through. `via` is hardcoded to
`'atlas'` inside the function (this RPC *is* the Atlas surface; CLI and
email-link approvals write via `service_role` directly, never through here).

```js
const { data } = await supabase.rpc('ap_decide', {
  p_item_id: item.id,
  p_decision: 'edited',
  p_caption_after: 'new caption text',
  p_note: 'sharper hook',
});
```

### `ap_rules(p_action text, p_rule_id uuid) → autopilot.playbook_rules`
`p_action = 'approve'` flips `proposed → active`. `p_action = 'retire'`
flips `proposed|active → retired`. CAS via the `UPDATE ... WHERE status`
guard; raises if the rule isn't in an eligible status (or doesn't exist).

```js
await supabase.rpc('ap_rules', { p_action: 'approve', p_rule_id: rule.id });
```

### `ap_settings(p_key text, p_value jsonb) → autopilot.settings`
Upsert one kv row.

```js
await supabase.rpc('ap_settings', { p_key: 'kill_switch', p_value: true });
```

Note: this ticket's RPC surface is write/decision-focused (queue read +
three mutations). There's no `ap_rules`-listing or `ap_settings`-listing read
RPC — Atlas Studio (AP-502) will need its own way to list `playbook_rules`
and `settings` for display before a human can pick something to act on. Not
built here since it wasn't in this ticket's four named signatures; flagging
so AP-502 doesn't assume it exists.

## Seed data

Four `settings` rows (kv, not a combined blob):

| key | value |
|---|---|
| `kill_switch` | `false` |
| `autonomy_level` | `"L1"` |
| `timezone` | `"Europe/Tirane"` |
| `cadence` | PRD §6.2's full daily timetable (plan/generate/digest/publish/metrics/reflect/report) + D-6's mix defaults (1 TikTok/day, 1 IG/day, quiet days: none) |

`CadenceSettings` / `CadenceScheduleEntry` in `types.ts` document the
`cadence` value's shape.

## Relationship to the file-mode store

`autopilot/src/types.mjs` (already landed by the parallel AP-201/AP-103
session) is the JSDoc equivalent of this contract for the M0 `FileStore`
(plain ESM, no build step). Both were written against PRD §5; `types.ts`
here was additionally cross-checked against the already-landed `types.mjs`
for field parity (that's where `regen_count`/`publish_attempts`/
`next_attempt_at` on `content_items` came from — `types.mjs`'s `ContentItem`
typedef already had them).

The two files are **not** wired together — `types.ts` has zero imports by
design, so it can't import from `types.mjs` (which also isn't pure types; it
exports runtime values like `STAGES`/`DECISIONS` arrays and error classes).
They're hand-synced today. Worth an explicit decision at the AP-801
integration pass on whether to keep hand-syncing or generate one from the
other.

File-mode ids (`ci_20260714_ig_1`, `cg_20260714_ig`,
`run_20260713T053012_generate_a1b2c3`) are deterministic slug strings (see
`autopilot/src/util/ids.mjs`), not uuids — `ContentItemFileV1` in `types.ts`
types these as `string` same as the DB row's `id`, but they are **not**
interchangeable values; a FileStore → SupabaseStore migration needs an
id-remapping step, not just a field copy.

## Open questions

1. **`approvals.decision` doesn't cover "Request changes."** PRD §10.1
   describes four Atlas Queue actions (Approve / Approve-with-edit / Request
   changes / Reject), and `content_items.status` has a real
   `'changes_requested'` value — but the PRD's own DDL comment for
   `approvals.decision` lists only 3 values, and `autopilot/src/types.mjs`'s
   `DECISIONS` constant matches that exactly. `ap_decide` here only ever
   produces `'approved'` or `'skipped'`. Someone needs to decide: extend the
   CHECK + `ap_decide` to a 4th `'changes_requested'` decision value, or
   handle "Request changes" outside this RPC (e.g. the CLI's `regen` verb
   writing directly via `service_role`, as `autopilot/src/types.mjs`'s
   `Store.transition` seam already supports for file mode).
2. **`runs.stage = 'transition'` isn't accommodated.** `types.mjs`'s `Run`
   typedef has optional `item_id`/`from`/`to`/`note`/`parent_run`/`date`
   fields for the FileStore's pattern of logging every CAS transition as its
   own lightweight run row (`stage: "transition"`). This migration's
   `runs.stage` CHECK only allows the 8 canonical pipeline stages, so that
   pattern can't carry over to Postgres as-is. Left alone deliberately
   rather than guessing — whether DB-side transition audit belongs in
   `runs` at all (vs. being derivable from `content_items.updated_at`, or a
   future dedicated table) is a real design decision, not a gap-fill.
3. **No list/read RPC for `playbook_rules` or `settings`.** See the RPCs
   section above.

## Validation performed

- SQL: careful manual line-by-line review (no execution — this repo links
  straight to production, and `supabase db lint` needs either `--linked`
  (touches prod — forbidden for this ticket) or `--local` (needs a running
  local Postgres via `supabase start`, which repo policy avoids). This
  caught one real bug: a plpgsql `CASE` expression in `ap_decide` assigning
  bare text literals to an `autopilot.ap_status`-typed variable, which
  resolves to `text` before assignment and has no implicit enum cast —
  fixed with explicit `::autopilot.ap_status` casts on both branches.
  Structural checks (balanced parens, balanced `$$` function-body
  delimiters, table/RLS-enable set parity, valid JSON in the seed insert)
  were run programmatically as a supplementary sanity pass.
- `types.ts`: no local `typescript` devDependency in this package yet
  (`autopilot/package.json` has none). Type-checked with the `tsc` binary
  hoisted into `apps/atlas/node_modules` (TypeScript 6.0.3) directly against
  the file (no tsconfig needed — the file has zero imports):
  `tsc --noEmit --strict --exactOptionalPropertyTypes
  --noUncheckedIndexedAccess --isolatedModules --target es2022 --module
  esnext --moduleResolution bundler autopilot/src/db/types.ts`. Clean, no
  errors, under that full strict flag set.
