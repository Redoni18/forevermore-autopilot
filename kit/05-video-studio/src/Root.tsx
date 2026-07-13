/**
 * Composition registry. Durations are LOAD-BEARING: src/adapters/video.mjs
 * hard-codes HOOK_FRAMES=165, MIDDLE_FRAMES=150 (Showcase + Shelf), and
 * END_FRAMES=120 to compute final.mp4 duration after `-c copy` concat.
 * Change a duration here and there together, or dur_s drifts.
 */
import React from 'react';
import { Composition } from 'remotion';
import { HookCard } from './HookCard';
import { ShowcaseCard } from './ShowcaseCard';
import { WorldShelfCard } from './WorldShelfCard';
import { EndCard } from './EndCard';

const SIZE = { width: 1080, height: 1920, fps: 30 } as const;

export const Root: React.FC = () => (
  <>
    <Composition
      id="HookCard"
      component={HookCard}
      durationInFrames={165}
      {...SIZE}
      defaultProps={{
        kicker: 'made, not generated',
        line: "it's 6pm. dinner is at 10. you have $15 and a camera roll.",
        hl: '',
        mascot: 'gift',
      }}
    />
    <Composition
      id="ShowcaseCard"
      component={ShowcaseCard}
      durationInFrames={150}
      {...SIZE}
      defaultProps={{
        world: 'The Blockheart Mine',
        thumb: 'template-thumbs/blockheart-mine.webp',
        still: '__autopilot-clips/blockheart-mine-still.jpg',
      }}
    />
    <Composition
      id="WorldShelfCard"
      component={WorldShelfCard}
      durationInFrames={150}
      {...SIZE}
      defaultProps={{
        kicker: 'pick their world',
        thumbs: [
          'template-thumbs/gone-fishing.webp',
          'template-thumbs/love-letters.webp',
          'template-thumbs/prize-claw.webp',
          'template-thumbs/blockheart-mine.webp',
          'template-thumbs/passport.webp',
          'template-thumbs/pocket-pal.webp',
          'template-thumbs/memory-garden.webp',
          'template-thumbs/starlit-letter.webp',
          'template-thumbs/matchday.webp',
        ],
      }}
    />
    <Composition id="EndCard" component={EndCard} durationInFrames={120} {...SIZE} />
  </>
);
