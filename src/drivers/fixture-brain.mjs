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
 */

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
    const maxTags = platform === 'tiktok' ? 5 : 10;

    const hook = idea?.hook ? firstLine(idea.hook) : 'someone you love is one message away.';
    const beats = Array.isArray(idea?.beats) ? idea.beats.slice(0, 2) : [];
    const cta = idea?.cta ? firstLine(idea.cta) : 'getforevermore.co — from $15';

    // Caption: hook + a soft beat + CTA. Sentence-case, no banned claims.
    const captionParts = [hook];
    if (beats[0]) captionParts.push(firstLine(beats[0]));
    captionParts.push(cta);
    const caption = captionParts.join('\n\n');

    // Hashtags: brand + gift staples + world/occasion, capped per platform.
    const world = Array.isArray(idea?.worlds) && idea.worlds[0] ? slug(idea.worlds[0]) : '';
    const occasion = Array.isArray(idea?.occasions) && idea.occasions[0] ? slug(idea.occasions[0]) : '';
    const hashtags = ['forevermore', 'giftideas', 'handmadegift', world, occasion]
      .filter(Boolean)
      .filter((t, i, a) => a.indexOf(t) === i)
      .slice(0, maxTags);

    const overlays = {
      hook,
      beats,
      cta,
    };

    return {
      caption,
      hashtags,
      overlays,
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
