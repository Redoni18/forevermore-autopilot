/* Shared poster runtime: query-string params + the renderer ready flag.
 * Templates call initPoster(build) — build(params) mutates the DOM — and the
 * ready flag flips once fonts and every <img> have settled, which
 * render.mjs's waitForFunction gates the screenshot on. */

export function params() {
  return Object.fromEntries(new URLSearchParams(location.search));
}

/** Scale type down until the block fits its container (long hooks). */
export function fitText(el, { min = 0.55 } = {}) {
  const parent = el.parentElement;
  let scale = 1;
  while (scale > min && (el.scrollHeight > parent.clientHeight || el.scrollWidth > parent.clientWidth)) {
    scale -= 0.05;
    el.style.fontSize = `calc(${el.dataset.base} * ${scale})`;
  }
}

/** Render `line` into `el`, wrapping hl-matched words in a highlight span. */
export function lineWithHighlight(el, line, hl) {
  const hlSet = new Set(
    (hl || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  el.textContent = '';
  for (const word of String(line || '').split(/\s+/)) {
    const clean = word.toLowerCase().replace(/[^\w'$]/g, '');
    if (hlSet.has(clean)) {
      const mark = document.createElement('span');
      mark.className = 'hl';
      mark.textContent = word;
      el.append(mark, ' ');
    } else {
      el.append(`${word} `);
    }
  }
}

export const COIN_SVG = {
  star: '<svg viewBox="0 0 24 24"><path d="M12 1.6l3.1 6.7 7.3.9-5.4 5 1.4 7.2L12 17.8l-6.4 3.6 1.4-7.2-5.4-5 7.3-.9z"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24"><path d="M12 21.2C5.4 16.4 2 12.9 2 8.9 2 6 4.2 3.8 7 3.8c1.9 0 3.7 1 5 2.7 1.3-1.7 3.1-2.7 5-2.7 2.8 0 5 2.2 5 5.1 0 4-3.4 7.5-10 12.3z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 3v10.6a3.5 3.5 0 1 0 2 3.2V7h8V3H9z"/></svg>',
};

export function initPoster(build) {
  const run = async () => {
    build(params());
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.complete ? Promise.resolve() : new Promise((res) => ((img.onload = res), (img.onerror = res))),
      ),
    );
    window.__READY = true;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
}
