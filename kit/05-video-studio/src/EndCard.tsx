/**
 * EndCard — the fixed closing act (120 frames = 4s). No props.
 * Recovered from the surviving renders: pink heart coin top-center, the
 * "Someone you love is one message away." line, the white URL pill, the
 * yellow price banner (FROM $15 · PAY ONCE · NO SUBSCRIPTION — an approved
 * badge, not body copy), star coin bottom-left, periwinkle note coin
 * top-right.
 */
import React from 'react';
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Chip, Coin, FONT_FAMILY, INK, PAPER, PERIWINKLE, PINK, WHITE, YELLOW, useBrandFont } from './design';

export const EndCard: React.FC = () => {
  useBrandFont();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const heartIn = spring({ frame, fps, config: { damping: 11, stiffness: 150 } });
  const textIn = spring({ frame: frame - 10, fps, config: { damping: 14, stiffness: 120 } });
  const pillIn = spring({ frame: frame - 26, fps, config: { damping: 12, stiffness: 140 } });
  const bannerIn = spring({ frame: frame - 38, fps, config: { damping: 12, stiffness: 140 } });
  const noteIn = spring({ frame: frame - 20, fps, config: { damping: 10, stiffness: 170 } });
  const starIn = spring({ frame: frame - 48, fps, config: { damping: 10, stiffness: 170 } });

  return (
    <AbsoluteFill style={{ background: PAPER, fontFamily: FONT_FAMILY }}>
      <Audio src={staticFile('sfx/end.m4a')} />
      <Coin
        bg={PINK}
        glyph="heart"
        size={190}
        style={{ position: 'absolute', top: 480, left: '50%', marginLeft: -95, transform: `scale(${heartIn})` }}
      />
      <Coin
        bg={PERIWINKLE}
        glyph="note"
        size={100}
        rotate={10}
        style={{ position: 'absolute', top: 430, right: 140, transform: `scale(${noteIn})` }}
      />

      <div
        style={{
          position: 'absolute',
          top: 760,
          left: 90,
          right: 90,
          textAlign: 'center',
          fontSize: 104,
          lineHeight: 1.18,
          fontWeight: 500,
          color: INK,
          letterSpacing: '-0.015em',
          opacity: textIn,
          transform: `translateY(${interpolate(textIn, [0, 1], [40, 0])}px)`,
        }}
      >
        Someone you love is one message away.
      </div>

      {/* URL pill */}
      <div
        style={{
          position: 'absolute',
          top: 1195,
          width: '100%',
          textAlign: 'center',
          transform: `scale(${pillIn})`,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 22,
            background: WHITE,
            border: `4px solid ${INK}`,
            borderRadius: 999,
            boxShadow: `8px 10px 0 ${INK}`,
            padding: '26px 56px',
            transform: 'rotate(-1deg)',
          }}
        >
          <Coin bg={PINK} glyph="heart" size={52} />
          <span style={{ fontSize: 56, fontWeight: 700, color: INK }}>getforevermore.co</span>
        </div>
      </div>

      {/* price banner — badge language, the approved all-caps carve-out */}
      <div
        style={{
          position: 'absolute',
          top: 1385,
          width: '100%',
          textAlign: 'center',
          transform: `translateY(${interpolate(bannerIn, [0, 1], [120, 0])}px)`,
          opacity: bannerIn,
        }}
      >
        <Chip caps bg={YELLOW} size={38} rotate={-2}>
          from $15 · pay once · no subscription
        </Chip>
      </div>

      <Coin
        bg={YELLOW}
        glyph="star"
        size={96}
        style={{ position: 'absolute', top: 1470, left: 140, transform: `scale(${starIn})` }}
      />
    </AbsoluteFill>
  );
};
