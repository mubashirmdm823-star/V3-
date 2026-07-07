// V2 safety layer.
//
// This sits between the (future) NLU intent parser and the cart engine.
// Every parsed Intent must pass through evaluateSafety() before the cart
// engine is allowed to touch anything. Core rule driving every decision
// here: a wrong cart mutation is worse than asking the customer to clarify,
// so when in doubt this layer always chooses NOT to mutate the cart.

import type { Intent, IntentItemRef } from "../types/intent";
import type { CartState } from "../types/cart";
import type { Menu, MenuItem } from "../types/menu";
import { isHighConfidence, isLowConfidence } from "./confidence";
import {
  clarifyItemOptions,
  clarifyUnclearMessage,
  itemNotInCartMessage,
  itemUnavailableMessage,
} from "./clarification";

export type SafetyDecisionType =
  | "SAFE_TO_EXECUTE"
  | "ASK_CLARIFICATION"
  | "REJECT_UNAVAILABLE"
  | "REJECT_NOT_IN_CART"
  | "NO_CART_ACTION";

export interface SafetyDecision {
  decision: SafetyDecisionType;
  reason: string;
  // Customer-facing clarification/rejection copy, when applicable.
  message?: string;
  // Populated for ASK_CLARIFICATION when the ambiguity is "which menu item".
  candidateItems?: MenuItem[];
}

// Exported so the intent parser (v2/intent-parser/parser.ts) can reuse the
// exact same trigger vocabulary for its own SHOW_*/PRICE_QUERY classification
// instead of maintaining a second, potentially-drifting copy.
export const SHOW_WORDS = [
  "dikhao",
  "show",
  "batao",
  "btao",
  "options",
  "menu",
  "konsay",
  "kaunse",
  "available",
];

export const PRICE_WORDS = [
  "price",
  "rate",
  "kitne ka",
  "total",
  "agar add karun",
  "sirf price",
  // A price/cost question must NEVER mutate the cart — the QA simulator
  // proved "how much is X" was being parsed as an ADD. These widen both
  // the parser's PRICE_QUERY detection and this layer's own
  // no-cart-action guard (evaluateSafety checks rawText against this list
  // for every intent, so even a misclassified add is stopped here).
  "how much",
  "kitna",
  "kitni",
  "kitne",
  "cost",
];

function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

function allMenuItems(menu: Menu): MenuItem[] {
  return menu.categories.flatMap((c) => c.items);
}

function findMenuItemById(menu: Menu, itemId: string): MenuItem | undefined {
  return allMenuItems(menu).find((i) => i.id === itemId);
}

function candidatesAsMenuItems(menu: Menu, ids: string[]): MenuItem[] {
  return ids
    .map((id) => findMenuItemById(menu, id))
    .filter((item): item is MenuItem => Boolean(item));
}

function isInCart(cart: CartState, itemId: string): boolean {
  return cart.items.some((line) => line.itemId === itemId);
}

// Priority used when an intent carries more than one item ref (e.g. "2
// zinger 2 pasta") — the least-safe individual decision wins for the whole
// intent, since one bad/ambiguous item is reason enough not to touch the
// cart for the rest of the message either.
const DECISION_PRIORITY: SafetyDecisionType[] = [
  "REJECT_UNAVAILABLE",
  "REJECT_NOT_IN_CART",
  "ASK_CLARIFICATION",
  "NO_CART_ACTION",
  "SAFE_TO_EXECUTE",
];

function worstOf(decisions: SafetyDecision[]): SafetyDecision {
  for (const type of DECISION_PRIORITY) {
    const match = decisions.find((d) => d.decision === type);
    if (match) return match;
  }
  return decisions[0];
}

// ─── Per-item evaluation ─────────────────────────────────────────────────────

function evaluateAddItem(ref: IntentItemRef, confidence: number, menu: Menu): SafetyDecision {
  const candidateIds = ref.candidateItemIds ?? [];

  if (candidateIds.length === 0) {
    return {
      decision: "REJECT_UNAVAILABLE",
      reason: `"${ref.query}" does not match any menu item.`,
      message: itemUnavailableMessage(ref.query),
    };
  }

  if (candidateIds.length > 1) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: `"${ref.query}" matches ${candidateIds.length} menu items — ambiguous.`,
      message: clarifyItemOptions(ref.query, candidatesAsMenuItems(menu, candidateIds)),
      candidateItems: candidatesAsMenuItems(menu, candidateIds),
    };
  }

  if (!isHighConfidence(confidence)) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: "Single matching item, but confidence is below the high threshold.",
      message: clarifyItemOptions(ref.query, candidatesAsMenuItems(menu, candidateIds)),
      candidateItems: candidatesAsMenuItems(menu, candidateIds),
    };
  }

  return { decision: "SAFE_TO_EXECUTE", reason: "Single unambiguous item, high confidence." };
}

function evaluateRemoveItem(ref: IntentItemRef, confidence: number, cart: CartState): SafetyDecision {
  const candidateIds = ref.candidateItemIds ?? [];
  const inCart = candidateIds.filter((id) => isInCart(cart, id));

  if (inCart.length === 0) {
    return {
      decision: "REJECT_NOT_IN_CART",
      reason: `"${ref.query}" is not in the current cart.`,
      message: itemNotInCartMessage(ref.query),
    };
  }

  if (inCart.length > 1) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: `"${ref.query}" matches ${inCart.length} items currently in the cart — ambiguous which to remove.`,
    };
  }

  if (!isHighConfidence(confidence)) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: "Single matching cart item, but confidence is below the high threshold.",
    };
  }

  return { decision: "SAFE_TO_EXECUTE", reason: "Single unambiguous cart item, high confidence." };
}

function evaluateReplaceItem(intent: Intent, cart: CartState, menu: Menu): SafetyDecision {
  const replace = intent.replace;
  if (!replace) {
    return { decision: "ASK_CLARIFICATION", reason: "replace_item intent missing replace detail." };
  }

  const sourceInCart = (replace.sourceCandidateItemIds ?? []).filter((id) => isInCart(cart, id));
  if (sourceInCart.length === 0) {
    return {
      decision: "REJECT_NOT_IN_CART",
      reason: `Source item "${replace.sourceQuery}" is not in the current cart.`,
      message: itemNotInCartMessage(replace.sourceQuery),
    };
  }

  const targetCandidates = replace.targetCandidateItemIds ?? [];
  if (targetCandidates.length === 0) {
    return {
      decision: "REJECT_UNAVAILABLE",
      reason: `Target item "${replace.targetQuery}" does not match any menu item.`,
      message: itemUnavailableMessage(replace.targetQuery),
    };
  }

  if (sourceInCart.length > 1 || targetCandidates.length > 1) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: "Replace source or target is ambiguous.",
      candidateItems: candidatesAsMenuItems(menu, targetCandidates),
    };
  }

  if (!isHighConfidence(intent.confidence)) {
    return {
      decision: "ASK_CLARIFICATION",
      reason: "Replace source/target both resolved, but confidence is below the high threshold.",
    };
  }

  return { decision: "SAFE_TO_EXECUTE", reason: "Unambiguous replace, high confidence." };
}

// ─── Top-level entry point ───────────────────────────────────────────────────

export function evaluateSafety(intent: Intent, cart: CartState, menu: Menu): SafetyDecision {
  // Show-intent guard always wins: a customer asking to see options is never
  // trying to mutate the cart, no matter what item names appear in the text.
  if (
    intent.type === "show_menu" ||
    intent.type === "show_category" ||
    intent.type === "show_options" ||
    containsAny(intent.rawText, SHOW_WORDS)
  ) {
    return {
      decision: "NO_CART_ACTION",
      reason: "Message is asking to see options/menu, not to order.",
    };
  }

  // Price queries never mutate the cart on their own. Also checked against
  // the space-stripped text so a spacing-corrupted price question ("kipric
  // eky ahai") still can't mutate the cart.
  const compactText = intent.rawText.toLowerCase().replace(/\s+/g, "");
  const COMPACT_PRICE_TOKENS = ["price", "howmuch", "kitneka", "kitna", "kitni", "cost"];
  if (
    intent.type === "price_query" ||
    containsAny(intent.rawText, PRICE_WORDS) ||
    COMPACT_PRICE_TOKENS.some((w) => compactText.includes(w))
  ) {
    return {
      decision: "NO_CART_ACTION",
      reason: "Message is asking about price, not confirming an order.",
    };
  }

  // Hard floor: below "low" confidence, never mutate the cart regardless of
  // intent type.
  if (isLowConfidence(intent.confidence)) {
    if (intent.type === "unknown") {
      return {
        decision: "NO_CART_ACTION",
        reason: "Confidence too low and intent unrecognized.",
        message: clarifyUnclearMessage(),
      };
    }
    return {
      decision: "ASK_CLARIFICATION",
      reason: "Confidence too low to safely act on this intent.",
      message: clarifyUnclearMessage(),
    };
  }

  if (intent.type === "unknown") {
    return {
      decision: "NO_CART_ACTION",
      reason: "Message could not be classified.",
      message: clarifyUnclearMessage(),
    };
  }

  if (intent.type === "add_item") {
    const items = intent.items ?? [];
    if (items.length === 0) {
      return { decision: "NO_CART_ACTION", reason: "add_item intent carried no items." };
    }
    return worstOf(items.map((ref) => evaluateAddItem(ref, intent.confidence, menu)));
  }

  if (intent.type === "remove_item") {
    const items = intent.items ?? [];
    if (items.length === 0) {
      return { decision: "NO_CART_ACTION", reason: "remove_item intent carried no items." };
    }
    return worstOf(items.map((ref) => evaluateRemoveItem(ref, intent.confidence, cart)));
  }

  if (intent.type === "update_quantity") {
    const items = intent.items ?? [];
    if (items.length === 0) {
      return { decision: "NO_CART_ACTION", reason: "update_quantity intent carried no items." };
    }
    // Same existence rule as remove: you can't retarget the quantity of
    // something that isn't in the cart.
    return worstOf(items.map((ref) => evaluateRemoveItem(ref, intent.confidence, cart)));
  }

  if (intent.type === "replace_item") {
    return evaluateReplaceItem(intent, cart, menu);
  }

  if (intent.type === "clear_cart") {
    if (cart.items.length === 0) {
      return { decision: "NO_CART_ACTION", reason: "Cart is already empty." };
    }
    if (!isHighConfidence(intent.confidence)) {
      return {
        decision: "ASK_CLARIFICATION",
        reason: "Clearing the cart is destructive and requires high confidence.",
      };
    }
    return { decision: "SAFE_TO_EXECUTE", reason: "High-confidence explicit clear request." };
  }

  // Everything else (checkout/confirm_order/provide_*/ask_info/small_talk)
  // doesn't touch the cart directly — fall back to the generic confidence
  // rule so this layer never authorizes anything below high confidence.
  if (isHighConfidence(intent.confidence)) {
    return { decision: "SAFE_TO_EXECUTE", reason: "High-confidence non-cart intent." };
  }
  return {
    decision: "ASK_CLARIFICATION",
    reason: "Medium-confidence non-cart intent.",
    message: clarifyUnclearMessage(),
  };
}
