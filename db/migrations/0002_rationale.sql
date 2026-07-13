-- 0002_rationale.sql — the "thinking log" column (AP-831).
--
-- Adds content_items.rationale: the reasoning behind every generated draft — what
-- the model referred to, which skills/rules it used, and why it believes the post
-- works (PRD §8 "thinking logs"). Written by the generate stage as jsonb:
--   { summary, hook_reasoning,
--     strategy: { idea_id, idea_title, pillar, playbook_rules: [{ id, rule }] },
--     craft: [text], limits: [text], audience }
-- The copywriter cites active playbook rules by ID; the generate pipeline joins
-- each id → rule text at persist time, so the stored log is self-contained.
--
-- Nullable, no default (matching the other jsonb columns lint/dedupe): planned
-- shells and historical rows carry null until (re)generated, and the review API
-- treats a null rationale as "no thinking log yet". Additive + backward-safe.
--
-- Apply with db/apply.mjs (Autopilot's OWN control-plane Postgres — never the
-- Forevermore platform's Supabase project; see docs/ADR-001-standalone.md).

alter table autopilot.content_items
  add column if not exists rationale jsonb;

comment on column autopilot.content_items.rationale is
  'AP-831 thinking log: { summary, hook_reasoning, strategy:{idea_id, idea_title, pillar, playbook_rules:[{id,rule}]}, craft[], limits[], audience }. Written by the generate stage; playbook rules are cited by id then joined to rule text at persist time so the log is self-contained.';
