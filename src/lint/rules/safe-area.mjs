// autopilot/src/lint/rules/safe-area.mjs
//
// TICKETS.md AP-401: "given overlays with optional {x,y,w,h} coords on a
// 1080x1920 canvas, block intersections with TikTok gutters (bottom 320px,
// right 140px) — skip silently when no coords." PRD §7.3 gate 3 names the
// same gutter geometry for the (model-driven) visual QA stage; this is its
// deterministic pre-check.
//
// item.overlays in the base ContentItem contract is just {hook, beats} —
// no geometry. Overlay-chip producers (e.g. the future OverlayReel comp,
// AP-302) may attach positioned chips anywhere under `overlays` (an array
// of {text,x,y,w,h}, a single {x,y,w,h} box, etc.), so this walks the whole
// `overlays` value recursively and evaluates every object that carries
// finite numeric x/y/w/h — anything else is simply not geometry and is
// skipped, which is what makes "no coords" a silent no-op.

const CANVAS = { w: 1080, h: 1920 };
const BOTTOM_GUTTER = { x: 0, y: CANVAS.h - 320, w: CANVAS.w, h: 320 };
const RIGHT_GUTTER = { x: CANVAS.w - 140, y: 0, w: 140, h: CANVAS.h };

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function collectBoxes(node, pathStr, acc) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectBoxes(child, `${pathStr}[${i}]`, acc));
    return;
  }
  const { x, y, w, h } = node;
  if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
    const label = typeof node.text === 'string' ? node.text : typeof node.label === 'string' ? node.label : undefined;
    acc.push({ path: pathStr, x, y, w, h, label });
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') collectBoxes(value, `${pathStr}.${key}`, acc);
  }
}

export function checkSafeArea(item, _ctx) {
  const violations = [];
  if (!item.overlays || typeof item.overlays !== 'object') return violations;

  const boxes = [];
  collectBoxes(item.overlays, 'overlays', boxes);

  for (const box of boxes) {
    const hitsBottom = intersects(box, BOTTOM_GUTTER);
    const hitsRight = intersects(box, RIGHT_GUTTER);
    if (!hitsBottom && !hitsRight) continue;
    const gutters = [hitsBottom && 'bottom', hitsRight && 'right'].filter(Boolean).join(' + ');
    violations.push({
      rule: 'safe-area:gutter-intersection',
      severity: 'block',
      excerpt: `[${box.path}]${box.label ? ` "${box.label}"` : ''} box(x:${box.x},y:${box.y},w:${box.w},h:${box.h}) intersects the TikTok ${gutters} gutter`,
    });
  }

  return violations;
}
