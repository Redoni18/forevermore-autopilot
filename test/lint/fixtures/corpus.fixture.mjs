// autopilot/test/lint/fixtures/corpus.fixture.mjs
//
// Small trailing-90-day dedupe corpus stand-in: [{id, hook}, ...].
// Jaccard 4-gram similarity values against 'ci_prior_1' are documented
// next to each candidate hook used in dedupe.test.mjs so the warn/block
// band assertions are traceable back to the exact numbers.

export const FIXTURE_CORPUS = [
  { id: 'ci_prior_1', hook: 'he ignores me for minecraft so i said it in his language' },
  { id: 'ci_prior_2', hook: 'we built a whole night fair just to hand you your own memories' },
];
