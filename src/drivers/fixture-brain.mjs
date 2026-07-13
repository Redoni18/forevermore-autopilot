/**
 * @file FIXTURE brain driver — a zero-cost, deterministic {@link BrainDriver}
 * that fills plausible, on-brand-ish copy from an idea payload so the whole
 * pipeline runs end-to-end without the real brain (ticket AP-301).
 *
 * It is intentionally NOT in `src/brain/` (that dir belongs to AP-301). When
 * AP-301 lands, `--driver claude-cli|agent-sdk` supersede this; the fixture
 * stays as the default + the golden-test double.
 *
 * Output shape matches PRD §5 copy fields (caption / hashtags / overlays).
 *
 * AP-820 — the copy is now FORMAT-AWARE, keyed by the slot's ap_format (read
 * from `item.format` / `inputs.formatSpec.format`), so the deterministic
 * pipeline produces the right SHAPE per format:
 *   - reel / tiktok_video / story : hook + up to 2 beats + cta (the v0 shape).
 *   - carousel                    : overlays.beats becomes 5–7 SLIDE TEXTS —
 *       slide 1 echoes the hook (cover), the last beat is a CTA line — each
 *       ≤90 chars; the caption is a save-bait, swipe-through line.
 *   - image                       : the hook IS the single static line (≤80
 *       chars), beats carries at most one optional sub-line, and the caption
 *       does the storytelling.
 * An absent format defaults to the reel/v0 shape (keeps unit callers stable).
 *
 * AP-831 — every result now also carries a deterministic, format-keyed
 * `rationale` (the item.rationale thinking log) whose `strategy.playbook_rules`
 * cites — by id — the active playbook rules injected via `inputs.playbookRules`.
 */

/** Slide-text cap for carousels (readable on a 1080×1350 poster). */
const CAROUSEL_MAX_CHARS = 90;
/** A static image line must read in one glance. */
const IMAGE_MAX_CHARS = 80;
/** Target slide-text count for a carousel (cover + body + cta). */
const CAROUSEL_MIN_SLIDES = 5;
const CAROUSEL_MAX_SLIDES = 7;

/** lowercase-alphanumeric slug for hashtags. */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** First sentence-ish fragment, trimmed. */
function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/** Trim to `max` chars on a word boundary (no ellipsis — keeps it lint-clean). */
function clamp(s, max) {
  const t = firstLine(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '').trim();
}

/** Brand + gift staples + world/occasion hashtags, capped per platform. */
function buildHashtags(idea, maxTags) {
  const world = Array.isArray(idea?.worlds) && idea.worlds[0] ? slug(idea.worlds[0]) : '';
  const occasion = Array.isArray(idea?.occasions) && idea.occasions[0] ? slug(idea.occasions[0]) : '';
  return ['forevermore', 'giftideas', 'handmadegift', world, occasion]
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, maxTags);
}

/**
 * Carousel copy: overlays.beats is the ordered SLIDE-TEXT script (5–7 entries)
 * — slide 1 echoes the hook, the last entry is a CTA line — and the caption is
 * a save-bait swipe-through. The poster adapter renders the cta slide from
 * `overlays.cta`, so the last beat + cta stay consistent.
 */
function buildCarousel(hook, allBeats, cta) {
  const cover = clamp(hook, CAROUSEL_MAX_CHARS);
  const ctaLine = clamp(cta, CAROUSEL_MAX_CHARS);
  // Middle body = the idea's beats, minus room for cover + cta.
  const room = CAROUSEL_MAX_SLIDES - 2;
  let body = allBeats.map((b) => clamp(b, CAROUSEL_MAX_CHARS)).filter(Boolean).slice(0, room);
  // Guarantee at least CAROUSEL_MIN_SLIDES total by padding the body with
  // deterministic, on-brand connective slides when an idea is beat-thin.
  const pad = ['the memories you already have, laid out one by one', 'the last one is the message you never say out loud'];
  for (let i = 0; body.length + 2 < CAROUSEL_MIN_SLIDES && i < pad.length; i++) body.push(clamp(pad[i], CAROUSEL_MAX_CHARS));

  const beats = [cover, ...body, ctaLine];
  const caption = [hook, 'swipe through — it builds to the last slide.', cta].join('\n\n');
  return { caption, overlays: { hook: cover, beats, cta } };
}

/**
 * Image copy: the hook is THE static line; beats carries at most one optional
 * sub-line; the caption carries the storytelling the single frame can't.
 */
function buildImage(hook, allBeats, cta) {
  const line = clamp(hook, IMAGE_MAX_CHARS);
  const sub = allBeats[0] ? [clamp(allBeats[0], IMAGE_MAX_CHARS)] : [];
  const story = [hook, allBeats.slice(0, 2).map(firstLine).filter(Boolean).join(' '), cta]
    .filter(Boolean)
    .join('\n\n');
  return { caption: story, overlays: { hook: line, beats: sub, cta } };
}

/** Capitalize the first letter (the thinking log is founder-facing meta, not post copy). */
function cap(s) {
  const t = String(s || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/**
 * A deterministic, format-keyed THINKING LOG (AP-831) so mock/offline runs carry
 * the full item.rationale shape. `playbook_rules` cites — by id — every ACTIVE
 * PLAYBOOK RULE the request injected (the generate pipeline joins those ids back
 * to rule text at persist time). Limits are HONEST about the fixture's real
 * constraints per format.
 * @param {Object|null} idea @param {Object} item @param {string} format @param {string[]} citedIds
 * @returns {import('../brain/schema.mjs').RationaleLog}
 */
function buildRationale(idea, item, format, citedIds) {
  const world = (Array.isArray(idea?.worlds) && idea.worlds[0]) ? String(idea.worlds[0]) : 'the world';
  const occasion = (Array.isArray(idea?.occasions) && idea.occasions[0]) ? String(idea.occasions[0]) : 'just because';
  const ideaId = (idea && idea.id) || item?.idea_id || 'OFFLIST';
  const ideaTitle = (idea && (idea.title || idea.hook)) ? String(idea.title || idea.hook) : 'untitled idea';
  const pillar = item?.pillar || (idea && idea.pillar) || 'P?';

  let craft;
  let limits;
  let shape;
  let hookWhy;
  if (format === 'carousel') {
    craft = ['cover-line pattern interrupt', 'swipe-through escalation', 'save-bait CTA'];
    limits = [`static poster carousel — no motion or product footage for ${world} yet, so the deck carries the story on slide text alone.`];
    shape = `a swipeable ${world} deck that escalates slide to slide to a save-worthy payoff`;
    hookWhy = 'the cover names a specific, true-feeling tension, so the thumb stops before the swipe even starts';
  } else if (format === 'image') {
    craft = ['single-line pattern interrupt', 'caption-carries-the-story'];
    limits = [`one static frame — the image holds a single line, so the caption does the emotional work; no ${world} footage available yet.`];
    shape = `one ${world} frame built around a single scroll-stopping line`;
    hookWhy = 'a single concrete statement reads in one glance, with no second line competing for the eye';
  } else {
    craft = ['POV framing', 'orientation beat', 'kinetic-text pacing'];
    limits = [`kinetic-text video — no product footage available for ${world} yet, so the beats are on-screen text over motion, not a screen recording of the real world.`];
    shape = `a first-person ${world} reel that lands the tension in the first two seconds`;
    hookWhy = 'it opens on a concrete POV the viewer already feels, then lets the world resolve it';
  }

  return {
    summary: cap(
      `${shape}. It plays the "${ideaTitle}" angle for a ${occasion} audience and points them at getforevermore.co. ` +
        (citedIds.length
          ? 'Shaped by the active playbook rules cited in strategy.'
          : 'No active playbook rules applied to this draft.'),
    ),
    hook_reasoning: cap(`${hookWhy}.`),
    strategy: {
      idea_id: String(ideaId),
      idea_title: String(ideaTitle),
      pillar: String(pillar),
      playbook_rules: citedIds,
    },
    craft,
    limits,
    audience: cap(`people shopping for a ${occasion} gift who'd rather give something personal than store-bought.`),
  };
}

export class FixtureBrain {
  constructor() {
    this.name = 'fixture';
  }

  /**
   * @param {import('../types.mjs').StageRequest} req
   * @returns {Promise<import('../types.mjs').StageResult>}
   */
  async complete(req) {
    const { item, idea } = req;
    const platform = item.platform;
    const format = item.format || (req.inputs && req.inputs.formatSpec && req.inputs.formatSpec.format) || 'reel';
    const maxTags = platform === 'tiktok' ? 5 : 10;

    // Cite (by id) every active playbook rule the generate stage injected, so
    // the deterministic path also exercises the obey-and-cite contract (AP-831).
    const rules = Array.isArray(req.inputs && req.inputs.playbookRules) ? req.inputs.playbookRules : [];
    const citedIds = [...new Set(rules.map((r) => r && r.id).filter(Boolean))];

    const hook = idea?.hook ? firstLine(idea.hook) : 'someone you love is one message away.';
    const cta = idea?.cta ? firstLine(idea.cta) : 'getforevermore.co — from $15';
    const allBeats = Array.isArray(idea?.beats) ? idea.beats.map(firstLine).filter(Boolean) : [];

    const hashtags = buildHashtags(idea, maxTags);

    let caption;
    let overlays;
    if (format === 'carousel') {
      ({ caption, overlays } = buildCarousel(hook, allBeats, cta));
    } else if (format === 'image') {
      ({ caption, overlays } = buildImage(hook, allBeats, cta));
    } else {
      // reel / tiktok_video / story / default — the original v0 shape (kept
      // byte-identical so existing callers + golden tests are unaffected).
      const beats = Array.isArray(idea?.beats) ? idea.beats.slice(0, 2) : [];
      const captionParts = [hook];
      if (beats[0]) captionParts.push(firstLine(beats[0]));
      captionParts.push(cta);
      caption = captionParts.join('\n\n');
      overlays = { hook, beats, cta };
    }

    return {
      caption,
      hashtags,
      overlays,
      rationale: buildRationale(idea, item, format, citedIds),
      meta: {
        driver: 'fixture',
        model: 'fixture',
        prompt_sha: null,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      },
    };
  }
}
