// autopilot/test/lint/fixtures/catalog.fixture.mjs
//
// Small deterministic stand-in for marketing/_research/template-catalog.md
// used by most unit tests, so rule-family tests don't break when the real
// catalog changes. Shapes mirror the real file's fenced JSON exactly
// (slug/name/tier/isActive/description). engine.test.mjs separately loads
// the REAL catalog file to prove the fenced-JSON parser + an end-to-end
// inactive-world block against live data.

export const FIXTURE_CATALOG = [
  {
    slug: 'blockheart-mine',
    name: 'The Blockheart Mine',
    tier: 'premium',
    isActive: true,
    description: 'A fully-3D voxel world you explore in first person.',
  },
  {
    slug: 'drive-in-night',
    name: 'Drive-In Night',
    tier: 'premium',
    isActive: true,
    description: 'A private drive-in premiere of a film about them.',
  },
  {
    slug: 'birthday-trolley',
    name: 'Birthday Trolley',
    tier: 'standard',
    isActive: true,
    description: 'A toy trolley rides a celebration line.',
  },
  {
    slug: 'blooming-garden',
    name: 'Blooming Message Garden',
    tier: 'standard',
    isActive: true,
    description: 'A quiet garden that grows as memories are planted.',
  },
  {
    slug: 'sticker-book',
    name: 'Sticker Book',
    tier: 'standard',
    isActive: true,
    description: 'A playful sticker album page.',
  },
  {
    slug: 'star-map-letter',
    name: 'Star Map Letter',
    tier: 'standard',
    isActive: false,
    description: 'A night-sky letter where stars open memories.',
  },
  {
    slug: 'golden-claw',
    name: 'The Golden Claw',
    tier: 'premium',
    isActive: false,
    description: 'The arcade stayed open late, just for them.',
  },
];
