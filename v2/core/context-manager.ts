// V2 phase 8 — conversation context wrapper.
//
// Wraps the order-state-engine's OrderContext (state, cart, pending
// clarification, customer name, delivery type/address, last intent/action —
// see v2/types/order.ts) with the extra identity/observability fields the
// orchestrator needs: conversation id, session id, and the response seed
// used for this turn's deterministic reply variation. It never invents new
// cart/state/checkout rules — those all still live in OrderContext exactly
// as the order-state-engine already produces them.
//
// Everything here is plain data + immutable updates (matching
// order-state-engine/context.ts#touch's convention), so a ConversationContext
// is trivially serializable for future session/database storage.

import type { CartState } from "../types/cart";
import type { OrderContext } from "../types/order";
import { createInitialContext } from "../order-state-engine/context";
import { isValidOrderContext } from "./validator";
import { PipelineError } from "./errors";

export interface ConversationContext {
  conversationId: string;
  sessionId: string;
  order: OrderContext;
  // The raw message that produced the current `order` — the same value
  // v2/response-builder/variation.ts#pickEndingVariation already seeds its
  // deterministic rotation from. Carried on the context purely so a
  // restored/persisted conversation can report what drove its last reply
  // variation; the response builder still computes its own seed per call.
  responseSeed: string;
}

export function createConversationContext(
  conversationId: string,
  sessionId: string,
  cart: CartState = { items: [] },
  now: () => Date = () => new Date()
): ConversationContext {
  return {
    conversationId,
    sessionId,
    order: createInitialContext(cart, now),
    responseSeed: "",
  };
}

// Immutable update — the only way orchestrator code should advance a
// ConversationContext from one turn to the next.
export function withOrder(
  ctx: ConversationContext,
  order: OrderContext,
  responseSeed: string
): ConversationContext {
  return { ...ctx, order, responseSeed };
}

export function saveContext(ctx: ConversationContext): string {
  return JSON.stringify(ctx);
}

export function restoreContext(serialized: string): ConversationContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new PipelineError("CONTEXT", "Stored conversation context is not valid JSON.", error);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).conversationId !== "string" ||
    typeof (parsed as Record<string, unknown>).sessionId !== "string" ||
    typeof (parsed as Record<string, unknown>).responseSeed !== "string" ||
    !isValidOrderContext((parsed as Record<string, unknown>).order)
  ) {
    throw new PipelineError("CONTEXT", "Stored conversation context has an invalid shape.");
  }

  return parsed as ConversationContext;
}

// Starts a brand-new order over the same conversation/session identity —
// e.g. the customer starting a fresh order after PENDING_VERIFICATION.
export function resetContext(ctx: ConversationContext, now: () => Date = () => new Date()): ConversationContext {
  return {
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    order: createInitialContext({ items: [] }, now),
    responseSeed: "",
  };
}

export function cloneContext(ctx: ConversationContext): ConversationContext {
  return JSON.parse(JSON.stringify(ctx)) as ConversationContext;
}
