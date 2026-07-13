// Review-station decision layer — now a PURE RE-EXPORT SHIM.
//
// The decision core (decide(), autoSkipSiblings, listGroupedItems, and the
// VALID_DECISIONS/REASON_REQUIRED_DECISIONS/STATUS_FOR_DECISION/isSafeId
// vocabulary) moved verbatim to src/decide/index.mjs at Phase 1 so the
// Telegram control channel can drive the *exact same* CAS decision paths the
// local review station uses — one decision transaction, one candidate-group
// auto-skip, one place to reason about correctness.
//
// This file stays so review/lib/app.mjs and the existing tests
// (test/tick.test.mjs imports `decide` from here) keep their import path with
// zero churn. It re-exports the shared core wholesale; nothing else lives here.
export * from '../../src/decide/index.mjs';
