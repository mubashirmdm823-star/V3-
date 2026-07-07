// V2 phase 3 — AI intent parser.
//
// Responsibility: take raw customer text (+ current cart, for existence
// checks) and return a single ParseResult (see v2/types/parser.ts). Nothing
// else. This module must NOT touch CartState/ConversationState — it only
// classifies what the customer said and resolves item mentions to candidate
// menu ids. Deterministic cart/order mutation belongs to cart-engine /
// order-state-engine.

export { parseMessage } from "./parser";

export type { SafetyDecision, SafetyDecisionType } from "./safety";
export { evaluateSafety, SHOW_WORDS, PRICE_WORDS } from "./safety";

export type { ConfidenceLevel } from "./confidence";
export { CONFIDENCE_THRESHOLDS, classifyConfidence, isHighConfidence, isLowConfidence } from "./confidence";

export {
  clarifyItemOptions,
  clarifyCategoryChoice,
  clarifyUnclearMessage,
  itemNotInCartMessage,
  itemUnavailableMessage,
} from "./clarification";
