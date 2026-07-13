/**
 * HookCard — the kinetic opening act (165 frames @30fps = 5.5s).
 * Choreography recovered from the surviving 2026-07-13 renders:
 *   f0–12   kicker chip drops in top-center
 *   ~f40    star coin pops top-right, heart coin bottom-left
 *   f45–105 the hook line types on word-by-word, big and centered
 *   f120+   mascot sticker walks in bottom-right
 * Props: { kicker, line, hl, mascot } — see src/adapters/video.mjs hookProps().
 */
import React from 'react';
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Chip, Coin, FONT_FAMILY, INK, PAPER, PINK, YELLOW, useBrandFont } from './design';

export type HookCardProps = {
  kicker: string;
  line: string;
  hl: string;
  mascot: string;
};

const TYPE_START = 45;
const WORDS_PER_FRAME = 0.14; // ≈ 4.2 words/second

export const HookCard: React.FC<HookCardProps> = ({ kicker, line, hl, mascot }) => {
  useBrandFont();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const chipIn = spring({ frame, fps, config: { damping: 12, stiffness: 160 } });
  const coinIn = spring({ frame: frame - 38, fps, config: { damping: 10, stiffness: 180 } });
  const heartIn = spring({ frame: frame - 44, fps, config: { damping: 10, stiffness: 180 } });
  const mascotIn = spring({ frame: frame - 118, fps, config: { damping: 14, stiffness: 90 } });

  const words = line.split(/\s+/).filter(Boolean);
  const shown = Math.max(0, Math.floor((frame - TYPE_START) * WORDS_PER_FRAME * 10) / 10);
  const visible = words.slice(0, Math.floor(shown + 1e-6) >= words.length ? words.length : Math.floor(shown));
  // Word-by-word reveal with the last word fading in (matches the typed feel).
  const partial = shown - Math.floor(shown);
  const nextWord = visible.length < words.length ? words[visible.length] : null;

  const hlSet = new Set(
    hl
      ? hl
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
      : [],
  );

  const renderWord = (w: string, key: number, opacity = 1) => (
    <span
      key={key}
      style={{
        opacity,
        background: hlSet.has(w.toLowerCase().replace(/[^\w'$]/g, '')) ? YELLOW : 'none',
        padding: hlSet.has(w.toLowerCase().replace(/[^\w'$]/g, '')) ? '0 12px' : undefined,
        borderRadius: 14,
      }}
    >
      {w}{' '}
    </span>
  );

  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: FONT_FAMILY }}>
      <Audio src={staticFile('sfx/hook.m4a')} />
      {/* kicker chip */}
      <div
        style={{
          position: 'absolute',
          top: 190,
          width: '100%',
          textAlign: 'center',
          transform: `translateY(${interpolate(chipIn, [0, 1], [-260, 0])}px)`,
        }}
      >
        <Chip caps size={40} rotate={-3}>
          {kicker}
        </Chip>
      </div>

      {/* coins */}
      <Coin
        bg={YELLOW}
        glyph="star"
        size={104}
        rotate={8}
        style={{ position: 'absolute', top: 340, right: 150, transform: `scale(${coinIn})` }}
      />
      <Coin
        bg={PINK}
        glyph="heart"
        size={78}
        rotate={-6}
        style={{ position: 'absolute', bottom: 420, left: 130, transform: `scale(${heartIn})` }}
      />

      {/* the hook line, typed on */}
      <div
        style={{
          position: 'absolute',
          top: 700,
          left: 90,
          right: 90,
          textAlign: 'center',
          fontSize: 92,
          lineHeight: 1.22,
          fontWeight: 500,
          color: INK,
          letterSpacing: '-0.015em',
        }}
      >
        {visible.map((w, i) => renderWord(w, i))}
        {nextWord ? renderWord(nextWord, visible.length, partial) : null}
      </div>

      {/* mascot walks in bottom-right */}
      <img
        src={staticFile(`mascot-stickers/${mascot}.png`)}
        alt=""
        style={{
          position: 'absolute',
          bottom: -30,
          right: interpolate(mascotIn, [0, 1], [-460, 40]),
          width: 430,
        }}
      />
    </AbsoluteFill>
  );
};
