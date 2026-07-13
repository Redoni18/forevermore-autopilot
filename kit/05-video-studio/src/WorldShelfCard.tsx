/**
 * WorldShelfCard — the shelf product act (150 frames = 5s), AP-835/836.
 * The owner's "show a card layout of all the worlds": kicker chip top-center,
 * a 3×3 grid of real world posters as white-bordered cards popping in with a
 * stagger, star coin top-right, heart coin bottom-left.
 * Props: { kicker, thumbs } — see video.mjs planVideo() shelf route.
 */
import React from 'react';
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Card, Chip, Coin, FONT_FAMILY, PAPER, PINK, YELLOW, useBrandFont } from './design';

export type WorldShelfCardProps = {
  kicker: string;
  thumbs: string[];
};

const COLS = 3;
const CARD_W = 315;
const CARD_H = 425;
const GAP_X = 30;
const GAP_Y = 32;
const GRID_TOP = 350;

export const WorldShelfCard: React.FC<WorldShelfCardProps> = ({ kicker, thumbs }) => {
  useBrandFont();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const chipIn = spring({ frame, fps, config: { damping: 12, stiffness: 160 } });
  const coinIn = spring({ frame: frame - 6, fps, config: { damping: 10, stiffness: 180 } });
  const heartIn = spring({ frame: frame - 70, fps, config: { damping: 10, stiffness: 180 } });

  const nine = thumbs.slice(0, 9);
  const gridW = COLS * CARD_W + (COLS - 1) * GAP_X;
  const left0 = (1080 - gridW) / 2;

  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: FONT_FAMILY }}>
      <Audio src={staticFile('sfx/shelf.m4a')} />
      <div
        style={{
          position: 'absolute',
          top: 150,
          width: '100%',
          textAlign: 'center',
          transform: `translateY(${interpolate(chipIn, [0, 1], [-240, 0])}px)`,
        }}
      >
        <Chip bg={YELLOW} size={46} rotate={-2}>
          {kicker}
        </Chip>
      </div>

      <Coin
        bg={YELLOW}
        glyph="star"
        size={90}
        rotate={10}
        style={{ position: 'absolute', top: 215, right: 105, transform: `scale(${coinIn})` }}
      />

      {nine.map((t, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const pop = spring({ frame: frame - 10 - i * 6, fps, config: { damping: 13, stiffness: 130 } });
        return (
          <div
            key={t}
            style={{
              position: 'absolute',
              left: left0 + col * (CARD_W + GAP_X),
              top: GRID_TOP + row * (CARD_H + GAP_Y),
              transform: `scale(${pop})`,
            }}
          >
            <Card w={CARD_W} h={CARD_H} rotate={(i % 2 === 0 ? -1 : 1) * (1 + (i % 3) * 0.6)} style={{ borderRadius: 28, borderWidth: 4 }}>
              <img src={staticFile(t)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </Card>
          </div>
        );
      })}

      <Coin
        bg={PINK}
        glyph="heart"
        size={78}
        rotate={-8}
        style={{ position: 'absolute', bottom: 105, left: 90, transform: `scale(${heartIn})` }}
      />
    </AbsoluteFill>
  );
};
