-- 0004_telegram.sql — the Telegram control channel's persistence (Phase 1).
--
-- Two additive changes, both backward-safe:
--
--   1. approvals.via gains 'telegram'. The bot drives the SAME shared decide()
--      path the local review station uses, so an approve/skip issued from the
--      phone writes an approvals row with via='telegram' — a value the 0001
--      CHECK ('atlas','email-link','cli','local-station') did not permit. We
--      drop and re-add the named constraint rather than mutate it in place
--      (Postgres has no ALTER CONSTRAINT for a CHECK), preserving the exact
--      constraint name so a future migration can find it.
--
--   2. autopilot.telegram_messages — the outbound send-ledger. One table doing
--      three jobs (design decision §2): dedup ledger (unique dedup_key so a
--      restart never re-sends and an attempt-2 card re-fires because `attempt`
--      is in the key the caller builds), crash-safe send state (message_id NULL
--      = claimed-but-not-yet-sent, so a scanner can retry a claim that crashed
--      mid-send), and the Telegram message_id → content_item mapping that lets
--      a reply to a card resolve back to the item it was about. FileStore holds
--      the same shape in telegram-messages.json (sibling to settings.json).
--
-- item_id is the uuid FK into content_items exactly like approvals.content_item_id
-- (the store's slug↔uuid5 bridge maps a file-mode slug to this key); ON DELETE
-- CASCADE for the same reason approvals cascade — a ledger row about an item has
-- no independent meaning once the item is purged. Passive rows with no item
-- (tick summaries, liveness/spend alerts, heartbeats) carry item_id NULL.
--
-- Apply with db/apply.mjs (Autopilot's OWN control-plane Postgres — never the
-- Forevermore platform's Supabase project; see docs/ADR-001-standalone.md).

-- 1. approvals.via — extend the CHECK vocabulary with 'telegram' -------------

alter table autopilot.approvals drop constraint approvals_via_check;
alter table autopilot.approvals add constraint approvals_via_check
  check (via in ('atlas', 'email-link', 'cli', 'local-station', 'telegram'));

-- 2. telegram_messages — the outbound send-ledger ----------------------------

create table autopilot.telegram_messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('card', 'prompt', 'summary', 'alert', 'heartbeat', 'digest', 'reply')),
  dedup_key text not null,                                             -- caller-built key, e.g. card:<id>:pending_review:<attempt>
  item_id uuid references autopilot.content_items (id) on delete cascade,
  item_status text,
  attempt integer,
  chat_id bigint not null,
  message_id bigint,                                                   -- NULL = claimed, not yet sent (crash-safe)
  payload jsonb,
  sent_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

-- The dedup contract: one row per logical event. A conflicting insert on this
-- index is exactly the "already sent / already claimed" signal the claim path
-- reads (on conflict (dedup_key) do nothing).
create unique index telegram_messages_dedup_idx on autopilot.telegram_messages (dedup_key);
-- reply-to-card lookup: (chat_id, message_id) → the item the card was about.
create index telegram_messages_reply_idx on autopilot.telegram_messages (chat_id, message_id);
-- FK-covering index (ON DELETE CASCADE would full-scan the ledger without one).
create index telegram_messages_item_idx on autopilot.telegram_messages (item_id);

-- RLS on, zero policies — the deny-by-default posture every table in §5 of 0001
-- carries. service_role bypasses RLS via its BYPASSRLS attribute; the explicit
-- grant below is what lets the runner/bot operate.
alter table autopilot.telegram_messages enable row level security;

-- 0001's ALTER DEFAULT PRIVILEGES already grants service_role CRUD on tables
-- added by future migrations in this schema; the explicit grant here mirrors
-- 0001's per-table grant style and removes any doubt.
grant select, insert, update, delete on autopilot.telegram_messages to service_role;

comment on table autopilot.telegram_messages is
  'Phase 1 Telegram send-ledger: dedup (unique dedup_key) + crash-safe send state (message_id NULL = claimed-unsent) + message_id→content_item mapping for reply-to-card. FileStore parity in telegram-messages.json.';
