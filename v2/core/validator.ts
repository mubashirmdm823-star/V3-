// V2 phase 8 — pipeline output validation.
//
// Structural "is this shape well-formed" checks only, run after every stage
// the orchestrator calls. This is NOT business logic (it never decides
// which safety decision or state transition is *correct* — that's the
// safety layer's / order-state-engine's job) — it only guards against a
// stage returning a malformed/undefined/corrupt value that would otherwise
// silently propagate into the next stage or the customer's reply.

import type { CartState } from "../types/cart";
import type { OrderContext, OrderState } from "../types/order";
import type { IntentName, ParseResult } from "../types/parser";
import type { SafetyDecisionType } from "../intent-parser/safety";

const INTENT_NAMES: ReadonlySet<IntentName> = new Set([
  "GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT",
  "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK",
  "IRRELEVANT_QUERY", "HELP", "GOODBYE",
  "ADD_ITEM", "ADD_MULTIPLE_ITEMS", "REMOVE_ITEM", "REMOVE_ALL", "REPLACE_ITEM",
  "CHANGE_QUANTITY", "SHOW_OPTIONS", "SHOW_MENU", "SHOW_CART", "PRICE_QUERY",
  "HYPOTHETICAL_TOTAL", "CHECKOUT_START", "CONFIRM_ORDER", "SELECT_DELIVERY",
  "SELECT_PICKUP", "PROVIDE_ADDRESS", "PROVIDE_NAME", "ASK_RESTAURANT_INFO",
  "ASK_CLARIFICATION", "UNKNOWN",
]);

const ORDER_STATES: ReadonlySet<OrderState> = new Set([
  "BROWSING", "CART_EDITING", "AWAITING_CLARIFICATION", "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP", "AWAITING_ADDRESS", "AWAITING_NAME",
  "READY_TO_SUBMIT", "PENDING_VERIFICATION", "CANCELLED",
]);

const SAFETY_DECISIONS: ReadonlySet<SafetyDecisionType> = new Set([
  "SAFE_TO_EXECUTE", "ASK_CLARIFICATION", "REJECT_UNAVAILABLE",
  "REJECT_NOT_IN_CART", "NO_CART_ACTION",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidCartState(value: unknown): value is CartState {
  if (!isPlainObject(value)) return false;
  const items = value.items;
  if (!Array.isArray(items)) return false;
  return items.every(
    (line) =>
      isPlainObject(line) &&
      typeof line.itemId === "string" &&
      typeof line.name === "string" &&
      typeof line.price === "number" &&
      typeof line.qty === "number"
  );
}

export function isValidParseResult(value: unknown): value is ParseResult {
  if (!isPlainObject(value)) return false;
  if (typeof value.intent !== "string" || !INTENT_NAMES.has(value.intent as IntentName)) return false;
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) return false;
  if (!Array.isArray(value.items)) return false;
  if (!Array.isArray(value.actions)) return false;
  if (typeof value.needsClarification !== "boolean") return false;
  if (typeof value.safetyDecision !== "string" || !SAFETY_DECISIONS.has(value.safetyDecision as SafetyDecisionType)) return false;
  if (typeof value.rawUserMessage !== "string") return false;
  if (typeof value.normalizedMessage !== "string") return false;
  return true;
}

export function isValidOrderContext(value: unknown): value is OrderContext {
  if (!isPlainObject(value)) return false;
  if (typeof value.state !== "string" || !ORDER_STATES.has(value.state as OrderState)) return false;
  if (!isValidCartState(value.cart)) return false;
  if (typeof value.orderReviewShown !== "boolean") return false;
  if (typeof value.createdAt !== "string") return false;
  if (typeof value.updatedAt !== "string") return false;
  return true;
}

// A "valid customer response" is simply non-empty, printable text — the
// response builder owns everything about *what* it says.
export function isValidCustomerResponse(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
