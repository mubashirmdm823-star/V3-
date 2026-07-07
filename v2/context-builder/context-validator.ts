// V2 phase 9 — context validation.
//
// Structural "is this shape well-formed" checks only, mirroring
// v2/core/validator.ts's pattern (and reusing isValidCartState from it
// rather than re-checking cart shape a second way). Never re-decides
// business rules — only guards against a malformed memory/context object
// silently propagating into the (future) LLM prompt.

import type { OrderState } from "../types/order";
import { isValidCartState } from "../core/validator";
import type { ConversationMemory } from "./memory";
import type { ConversationTurn } from "./conversation";
import type { MenuContextResult } from "./menu-context";
import type { AIContext } from "./context-builder";

const ORDER_STATES: ReadonlySet<OrderState> = new Set([
  "BROWSING", "CART_EDITING", "AWAITING_CLARIFICATION", "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP", "AWAITING_ADDRESS", "AWAITING_NAME",
  "READY_TO_SUBMIT", "PENDING_VERIFICATION", "CANCELLED",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidConversationMemory(value: unknown): value is ConversationMemory {
  if (!isPlainObject(value)) return false;
  if (typeof value.conversationId !== "string" || value.conversationId.length === 0) return false;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return false;
  if (!isValidCartState(value.currentCart)) return false;
  if (typeof value.currentOrderState !== "string" || !ORDER_STATES.has(value.currentOrderState as OrderState)) return false;
  if (typeof value.currentCheckoutStage !== "string" || !ORDER_STATES.has(value.currentCheckoutStage as OrderState)) return false;
  if (!Array.isArray(value.previousIntents)) return false;
  if (!Array.isArray(value.previousActions)) return false;
  if (!Array.isArray(value.previousAIResponses)) return false;
  if (typeof value.currentResponseSeed !== "string") return false;
  if (typeof value.conversationTimestamp !== "string") return false;
  if (typeof value.updatedAt !== "string") return false;
  if (typeof value.messageCounter !== "number" || value.messageCounter < 0) return false;
  return true;
}

export function isValidConversationTurn(value: unknown): value is ConversationTurn {
  if (!isPlainObject(value)) return false;
  if (typeof value.turnNumber !== "number") return false;
  if (typeof value.timestamp !== "string") return false;
  if (typeof value.rawMessage !== "string") return false;
  if (typeof value.intent !== "string") return false;
  if (typeof value.aiResponse !== "string") return false;
  if (typeof value.stateBefore !== "string" || !ORDER_STATES.has(value.stateBefore as OrderState)) return false;
  if (typeof value.stateAfter !== "string" || !ORDER_STATES.has(value.stateAfter as OrderState)) return false;
  return true;
}

export function isValidMenuContextResult(value: unknown): value is MenuContextResult {
  if (!isPlainObject(value)) return false;
  if (!Array.isArray(value.categories)) return false;
  if (!Array.isArray(value.matchedCategoryKeys)) return false;
  if (typeof value.isFullMenu !== "boolean") return false;
  if (typeof value.restaurantOnly !== "boolean") return false;
  return true;
}

export function isValidAIContext(value: unknown): value is AIContext {
  if (!isPlainObject(value)) return false;
  if (typeof value.conversationId !== "string") return false;
  if (typeof value.sessionId !== "string") return false;
  if (typeof value.timestamp !== "string") return false;
  if (typeof value.customerMessage !== "string") return false;
  if (!isValidConversationMemory(value.memory)) return false;
  if (!isPlainObject(value.relevantMenu) || !Array.isArray((value.relevantMenu as Record<string, unknown>).categories)) return false;
  if (!isPlainObject(value.restaurantConfig)) return false;
  if (!isValidCartState(value.currentCart)) return false;
  if (typeof value.currentState !== "string" || !ORDER_STATES.has(value.currentState as OrderState)) return false;
  if (typeof value.summary !== "string" || value.summary.length === 0) return false;
  return true;
}
