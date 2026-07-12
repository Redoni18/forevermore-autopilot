# db/ — Autopilot's own Postgres

Autopilot is a standalone system with its own database (see
[`docs/ADR-001-standalone.md`](../docs/ADR-001-standalone.md)). This is
**never** the Forevermore platform's Supabase project — it's a separate
Postgres instance that only the migrations in `db/migrations/` ever touch.

## Quickstart

```bash
docker compose up -d      # starts postgres:16-alpine, port 5433
node db/apply.mjs         # applies db/migrations/*.sql, in filename order
```

That's it — a fresh checkout needs **zero manual scaffolding**. Roles,
helper schema, and admin gate are all created by the migration itself (see
"Self-contained by design" below).

## Credentials

| | |
|---|---|
| Host | `127.0.0.1` |
| Port | `5433` (mapped from the container's `5432`, chosen to avoid colliding with a platform-repo Postgres on the default `5432`) |
| User | `postgres` |
| Password | `autopilot` |
| Database | `autopilot` |
| Container name | `autopilot-local-db` |

Full connection string (matches `.env.example`'s `AUTOPILOT_DB_URL`):

```
postgres://postgres:autopilot@127.0.0.1:5433/autopilot
```

## `db/apply.mjs`

Zero-dependency Node 22 script. It never needs a local `psql` install —
every migration is piped into `psql` running **inside** the container via
`docker exec -i`.

```bash
node db/apply.mjs                     # apply pending migrations
node db/apply.mjs --fresh             # drop schemas, re-apply everything (prompts y/N)
node db/apply.mjs --fresh --yes       # same, no prompt (CI / scripted use)
node db/apply.mjs --container=NAME    # target a non-default container name
node db/apply.mjs --url=postgres://…  # informational only — printed, doesn't change the connection
node db/apply.mjs --help
```

### How `--fresh` works

Runs `drop schema if exists autopilot cascade; drop schema if exists
autopilot_private cascade;` before re-applying every migration from scratch.
Destroys all data in both schemas. Prompts for confirmation unless `--yes`
is also passed. Never touches anything outside those two schemas (i.e. never
touches `public`, `pg_catalog`, or another database on the same server).

### How migration tracking works

`apply.mjs` bootstraps `autopilot_private.schema_migrations(filename,
applied_at)` before running anything — this has to happen outside the
migration files themselves, since migration `0001` is what creates
`autopilot_private` in the first place (chicken-and-egg). Every subsequent
run of `apply.mjs`:

1. Lists `db/migrations/*.sql`, sorted by filename (the `NNNN_` prefix is
   the ordering — keep it zero-padded and monotonic for new migrations).
2. Skips any filename already recorded in `schema_migrations`.
3. For each pending file, pipes the migration SQL **plus** a tracking
   `insert` into a single `psql -1` (single-transaction) call — so a
   migration and its own tracking row commit or roll back together. A
   failed migration never gets marked applied.

Re-running `node db/apply.mjs` with nothing pending is a no-op: every file
is reported "already applied, skipping."

### Pointing at a different Postgres

The **store layer** (built alongside this migration, in `src/`) reads
`AUTOPILOT_DB_URL` from the environment to know where to connect at
runtime — that's the one contract this README promises callers. `db/
apply.mjs` itself is Docker-exec-based by design (see "How `--fresh` works"
above) and does not read `AUTOPILOT_DB_URL`; if you need to apply these
migrations to a non-Docker or hosted Postgres, run them with your own
`psql "$AUTOPILOT_DB_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_....sql`
(and track applied filenames yourself, or adapt `apply.mjs`'s `--container`
path to `docker exec` into wherever that instance actually runs).

## Self-contained by design (no manual scaffolding)

Earlier in development, the schema in `0001_autopilot_schema.sql` was moved
verbatim from the Forevermore platform repo and depended on things that only
existed there: Supabase-managed roles, the platform's `private` schema +
`private.set_updated_at()` trigger function, and the platform's Atlas admin
gate (`public.is_admin_self()`, backed by a `user_profiles` table that
doesn't exist here). None of that is true anymore — the migration was
adapted (see the "AP-813 standalone adaptation" note at the top of
`0001_autopilot_schema.sql` for the full rationale) to be fully
self-contained per ADR-001:

- **Roles** (`anon`, `authenticated`, `service_role`) are created
  idempotently at the top of `0001` if they don't already exist. On a
  hosted Supabase project these three roles are pre-managed by Supabase and
  every guard no-ops.
- **`autopilot_private`** (deliberately not named `private`, to avoid
  colliding with a Supabase project's own `private` schema) holds
  Autopilot's own copy of the `set_updated_at()` trigger function.
- **`autopilot_private.is_operator()`** replaces `is_admin_self()` as the
  gate inside all four `public.ap_*` RPCs (`ap_queue`, `ap_decide`,
  `ap_rules`, `ap_settings`).

### `is_operator()` and hosted mode

```sql
select coalesce(current_setting('autopilot.operator', true)::boolean, false)
  or current_user in ('postgres', 'service_role');
```

For local/single-operator deployments (this repo's default), the real
access gate is the network boundary: only the operator can reach this
Postgres instance at all (it's bound to `127.0.0.1:5433`, not exposed). The
function is a thin, explicit expression of that — `postgres` and
`service_role` always pass, and any other role can be granted access for a
session with:

```sql
select set_config('autopilot.operator', 'true', false);
```

When Autopilot eventually moves to a hosted, multi-operator deployment
(real login, real revocation), `autopilot_private.is_operator()` is the
**one function** that gets replaced with a real JWT/user-table check — every
RPC gate already calls through it, so that's a one-function swap, not a
schema change or a call-site hunt.

## The rule

**Never** point `AUTOPILOT_DB_URL`, `db/apply.mjs --container`, or any
manual `psql`/`supabase` command at the Forevermore platform's database.
Autopilot connects to the platform only as a read-only filesystem client
(`FOREVERMORE_ROOT`) and, later, its public HTTP APIs — never its database.
See `docs/ADR-001-standalone.md` for the full connection-surface table.
