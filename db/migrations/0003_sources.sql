-- 0003_sources.sql — the "what I pulled from" log (AP-833).
--
-- Adds content_items.sources: per-item provenance of the KNOWLEDGE and SKILLS
-- behind the draft, so the review station can show the owner exactly what the
-- model was given — not just why it believes the draft works (that is 0002's
-- `rationale`). Written in two layers that never clobber each other:
--
--   sources.plan        — by the plan stage: why this idea won this slot
--                         { picked_because, idea:{id,title}, score, base_score,
--                           recency_penalty, format, format_fit, last_used,
--                           pool_size, reused_this_week, runners_up:[{id,title,score}] }
--   sources.generation  — by the generate stage: what was injected into the brain
--                         { brand_guide:{path,sections,sha}, skill:{stage,path,sha},
--                           playbook_rules:[{id,rule,weight,category}], idea, worlds,
--                           format_spec, recent_posts, feedback, variant, prompt_sha }
--
-- Nullable, no default (matching lint/dedupe/rationale): historical rows carry
-- null and the review API treats that as "no source log". Additive + backward-safe.
--
-- Apply with db/apply.mjs (Autopilot's OWN control-plane Postgres — never the
-- Forevermore platform's Supabase project; see docs/ADR-001-standalone.md).

alter table autopilot.content_items
  add column if not exists sources jsonb;

comment on column autopilot.content_items.sources is
  'AP-833 source log: { plan:{picked_because, score, runners_up…}, generation:{brand_guide, skill, playbook_rules, idea, format_spec, recent_posts, feedback, variant, prompt_sha} }. plan is written by the planner, generation by the generate stage; each writer merges, never clobbers the other layer.';
