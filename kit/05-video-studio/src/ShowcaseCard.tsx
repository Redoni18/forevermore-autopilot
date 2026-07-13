/**
 * ShowcaseCard — the two-image product act (150 frames = 5s), AP-835.
 * "HookCard style plus a second portion where two images pop up: the template
 * thumbnail and how the template looks in use" (owner's words in the AP-835
 * commit). Recovered layout: world-name chip top-center (yellow, lowercase),
 * poster-art card upper-left labelled THEIR WORLD (pink chip), in-experience
 * still card lower-right labelled INSIDE IT (yellow chip), star coin
 * top-right, heart coin bottom-left.
 * Props: { world, thumb, still } — see video.mjs showcaseProps().
 */
import React from 'react';
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Card, Chip, Coin, FONT_FAMILY, PAPER, PINK, YELLOW, useBrandFont } from './design';

export type ShowcaseCardProps = {
  world: string;
  thumb: string;
  still: string;
};

export const ShowcaseCard: React.FC<ShowcaseCardProps> = ({ world, thumb, still }) => {
  useBrandFont();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const chipIn = spring({ frame, fps, config: { damping: 12, stiffness: 160 } });
  const card1In = spring({ frame: frame - 12, fps, config: { damping: 13, stiffness: 110 } });
  const card2In = spring({ frame: frame - 48, fps, config: { damping: 13, stiffness: 110 } });
  const coinIn = spring({ frame: frame - 8, fps, config: { damping: 10, stiffness: 180 } });

  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: FONT_FAMILY }}>
      <Audio src={staticFile('sfx/showcase.m4a')} />
      <div
        style={{
          position: 'absolute',
          top: 165,
          width: '100%',
          textAlign: 'center',
          transform: `translateY(${interpolate(chipIn, [0, 1], [-240, 0])}px)`,
        }}
      >
        <Chip bg={YELLOW} size={46} rotate={-2}>
          {world.toLowerCase()}
        </Chip>
      </div>

      <Coin
        bg={YELLOW}
        glyph="star"
        size={96}
        rotate={10}
        style={{ position: 'absolute', top: 270, right: 120, transform: `scale(${coinIn})` }}
      />

      {/* card 1 — the poster art ("their world") */}
      <div
        style={{
          position: 'absolute',
          top: 400,
          left: 60,
          transform: `translateY(${interpolate(card1In, [0, 1], [900, 0])}px) `,
        }}
      >
        <Card w={620} h={840} rotate={-4}>
          <img src={staticFile(thumb)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Card>
        <div style={{ position: 'absolute', top: -18, left: 24 }}>
          <Chip caps bg={PINK} size={30} rotate={-5}>
            their world
          </Chip>
        </div>
      </div>

      {/* card 2 — the real in-experience still ("inside it") */}
      <div
        style={{
          position: 'absolute',
          top: 800,
          right: 45,
          transform: `translateY(${interpolate(card2In, [0, 1], [1000, 0])}px)`,
        }}
      >
        <Card w={600} h={920} rotate={3}>
          <img src={staticFile(still)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Card>
        <div style={{ position: 'absolute', top: -18, left: -30 }}>
          <Chip caps bg={YELLOW} size={30} rotate={-4}>
            inside it
          </Chip>
        </div>
      </div>

      <Coin
        bg={PINK}
        glyph="heart"
        size={80}
        rotate={-8}
        style={{ position: 'absolute', bottom: 130, left: 95, transform: `scale(${card2In})` }}
      />
    </AbsoluteFill>
  );
};
