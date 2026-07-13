/**
 * Shared design system for the autopilot reel comps.
 *
 * RECONSTRUCTED 2026-07-13 after the kit loss. Source of truth: frames
 * extracted from the surviving 2026-07-13 outbox renders (hook/showcase/
 * shelf/end mp4s) — cream paper background, pill chips with a hard black
 * offset shadow, circular coin stickers, polaroid-style world cards, and
 * Schibsted Grotesk type (the platform's own webfont, staged in
 * public/fonts). Owner visual sign-off pending; tweak values here, not in
 * the comps.
 */
import React from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

export const PAPER = '#f2f1ec';
export const INK = '#111111';
export const YELLOW = '#ffe93c';
export const PINK = '#ff8adc';
export const PERIWINKLE = '#8fa3e8';
export const WHITE = '#ffffff';

export const FONT_FAMILY = "'Schibsted Grotesk', system-ui, sans-serif";

/** Load the staged Schibsted Grotesk variable woff2 (no network at render). */
let fontLoaded: Promise<void> | null = null;
export function useBrandFont(): void {
  const [handle] = React.useState(() => delayRender('load brand font'));
  React.useEffect(() => {
    if (!fontLoaded) {
      const face = new FontFace(
        'Schibsted Grotesk',
        `url(${staticFile('fonts/schibsted-grotesk-latin-wght-normal.woff2')}) format('woff2')`,
        { weight: '400 900' },
      );
      fontLoaded = face.load().then((f) => {
        document.fonts.add(f);
      });
    }
    fontLoaded.then(() => continueRender(handle));
  }, [handle]);
}

/** Pill chip with the hard black offset shadow ("paper sticker" language). */
export const Chip: React.FC<{
  bg?: string;
  color?: string;
  size?: number;
  rotate?: number;
  caps?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ bg = YELLOW, color = INK, size = 44, rotate = -3, caps = false, style, children }) => (
  <div
    style={{
      display: 'inline-block',
      background: bg,
      color,
      fontFamily: FONT_FAMILY,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: caps ? '0.06em' : '0.01em',
      textTransform: caps ? 'uppercase' : 'none',
      padding: `${size * 0.35}px ${size * 0.85}px`,
      borderRadius: 999,
      boxShadow: `${size * 0.16}px ${size * 0.18}px 0 ${INK}`,
      transform: `rotate(${rotate}deg)`,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
);

/** Circular coin sticker (yellow star / pink heart / periwinkle note). */
export const Coin: React.FC<{
  bg: string;
  glyph: 'star' | 'heart' | 'note';
  size?: number;
  rotate?: number;
  style?: React.CSSProperties;
}> = ({ bg, glyph, size = 110, rotate = 0, style }) => {
  const g = size * 0.42;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        border: `${Math.max(4, size * 0.05)}px solid ${INK}`,
        boxShadow: `0 ${size * 0.09}px 0 ${INK}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `rotate(${rotate}deg)`,
        ...style,
      }}
    >
      <svg width={g} height={g} viewBox="0 0 24 24" fill={INK}>
        {glyph === 'star' && (
          <path d="M12 1.6l3.1 6.7 7.3.9-5.4 5 1.4 7.2L12 17.8l-6.4 3.6 1.4-7.2-5.4-5 7.3-.9z" />
        )}
        {glyph === 'heart' && (
          <path d="M12 21.2C5.4 16.4 2 12.9 2 8.9 2 6 4.2 3.8 7 3.8c1.9 0 3.7 1 5 2.7 1.3-1.7 3.1-2.7 5-2.7 2.8 0 5 2.2 5 5.1 0 4-3.4 7.5-10 12.3z" />
        )}
        {glyph === 'note' && (
          <path d="M9 3v10.6a3.5 3.5 0 1 0 2 3.2V7h8V3H9zm10 0" />
        )}
      </svg>
    </div>
  );
};

/** White rounded card with black border + offset shadow (polaroid language). */
export const Card: React.FC<{
  w: number;
  h: number;
  rotate?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ w, h, rotate = 0, style, children }) => (
  <div
    style={{
      width: w,
      height: h,
      background: WHITE,
      border: `5px solid ${INK}`,
      borderRadius: 36,
      boxShadow: `12px 14px 0 rgba(17,17,17,0.9)`,
      overflow: 'hidden',
      transform: `rotate(${rotate}deg)`,
      ...style,
    }}
  >
    {children}
  </div>
);
