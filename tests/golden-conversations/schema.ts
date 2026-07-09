// Golden Conversation Test Suite — schema (Production Stabilization Mode).
//
// Defines the SHAPE of a golden scenario only. This file contains no
// runner/execution logic on purpose — scenarios are pure fixture data
// (tests/golden-conversations/*.json) checked in so a future test-running
// pass has a stable, agreed-upon contract to build against. Nothing here
// executes anything, calls the AI Gateway, or touches production code.
//
// A golden scenario is a short, realistic customer conversation (one or
// more messages, in order, as a single ongoing session) plus the
// deterministic, backend-verifiable facts the FINAL turn's reply and cart
// state must satisfy. "Deterministic" is the operative word: every field
// below should only ever assert something the real backend guarantees
// (real cart contents, real total, real order state, required/forbidden
// substrings) — never an exact sentence, since wording legitimately varies
// turn to turn even for the same intent.

// One expected line in the final cart, by real menu item name (never a
// raw item id) — matches v3/agent/actions.ts#CartLineFact's shape closely
// enough for a future runner to diff against the real
// session.conversation.order.cart.items, but is deliberately its own,
// simpler type here since this file has no dependency on production code.
export interface GoldenCartLine {
  name: string;
  quantity: number;
  // Optional — the real menu price, included for readability/documentation
  // in the fixture. A runner should always prefer the LIVE menu price over
  // this value; menu prices are never asserted or changed by this suite.
  price?: number;
}

// Every field is optional: a given scenario only ever asserts what's
// actually meaningful for the behaviour it's locking in (a pure greeting
// scenario has no cart/total/state expectations at all; a checkout-state
// scenario cares about `state` but not necessarily `cart`).
export interface GoldenExpected {
  // The exact expected cart contents after the LAST message in `messages`
  // has been processed. Omit entirely when the scenario isn't about cart
  // contents. An empty array explicitly asserts "the cart must be empty."
  cart?: GoldenCartLine[];
  // The real, backend-computed subtotal after the last message. Omit when
  // not relevant to what the scenario is locking in.
  total?: number;
  // The real v2/v3 OrderState after the last message — one of: BROWSING,
  // CART_EDITING, AWAITING_CLARIFICATION, ORDER_REVIEW,
  // AWAITING_DELIVERY_PICKUP, AWAITING_ADDRESS, AWAITING_NAME,
  // READY_TO_SUBMIT, PENDING_VERIFICATION, CANCELLED.
  state?: string;
  // Every one of these substrings/patterns must appear somewhere in the
  // final reply (case-insensitive substring match is the intended runner
  // semantics — kept loose here since this file defines shape, not
  // matching logic).
  mustContain?: string[];
  // None of these substrings/patterns may appear anywhere in the final
  // reply.
  mustNotContain?: string[];
  // Internal/leaked terms that must never appear in ANY reply across the
  // whole conversation, not just the final one. If omitted, a runner
  // should apply DEFAULT_FORBIDDEN_TERMS below — every scenario file in
  // this suite implicitly inherits this list even when a given scenario
  // doesn't repeat it, to keep the JSON fixtures from being needlessly
  // repetitive.
  forbiddenTerms?: string[];
  // Free-text explanation of WHY this scenario exists / what regression or
  // rule it locks in — required for every scenario that documents a fixed
  // bug or a specific behavioural rule (see rules.ts / RESTAURANT_AI_POLICY.md).
  notes?: string;
}

export interface GoldenScenario {
  // Unique across the ENTIRE suite (not just within one file) —
  // kebab-case, descriptive, stable (never renumbered/reused once
  // published, so a future regression report can reference it by id).
  id: string;
  // Short, human-readable summary shown in test output / reports.
  title: string;
  // One or more customer messages, sent in order within a single ongoing
  // conversation/session. `expected` describes the state after the LAST
  // message in this array has been processed.
  messages: string[];
  expected: GoldenExpected;
}

// The canonical set of internal/system terms that must never leak into a
// customer-facing reply, mirroring v3/agent/rules.ts#BANNED_CUSTOMER_REPLY_TERMS
// exactly (kept as a plain literal here, not imported, so this fixture
// directory has zero dependency on production code — see file header).
export const DEFAULT_FORBIDDEN_TERMS: readonly string[] = [
  "backend",
  "tool",
  "json",
  "provider",
  "gateway",
  "internal",
  "system",
  "debug",
  "V2",
  "V3",
  "engine",
];

// The full canonical list of v2/v3 OrderState values, for reference/
// validation by a future runner or scenario linter.
export const ORDER_STATES: readonly string[] = [
  "BROWSING",
  "CART_EDITING",
  "AWAITING_CLARIFICATION",
  "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
  "PENDING_VERIFICATION",
  "CANCELLED",
];

export type GoldenScenarioFile = GoldenScenario[];
