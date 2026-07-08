// V3 engine adapter — wraps v3/agent/index.ts#processAgentMessage (the
// one-call Gemini agent) behind the same shared AIEngine interface
// v1.ts/v2.ts implement. Gemini writes the customer reply and decides cart/
// checkout actions in a single call; V2 is used underneath only as the
// deterministic action-execution engine (cart engine, menu data, order-
// state guards, clarification queue) and, when the LLM path isn't
// available, as the whole-turn fallback pipeline (see v3/agent/index.ts's
// header).

import { randomUUID } from "node:crypto";
import menuData from "@/v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "@/v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "@/v2/types/menu";
import type { CartState } from "@/v2/types/cart";
import { restoreContext } from "@/v2/core/context-manager";
import {
  processAgentMessage,
  createAgentSession,
  type AgentSession,
  type AgentTurn,
} from "@/v3/agent";
import { createEmptyMemory, type ConversationMemory } from "@/v3/agent/conversation-memory";
import type { AIEngine, EngineCartItem, EngineRequest, EngineResponse } from "./types";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

const FINISHED_STATES: ReadonlySet<string> = new Set(["PENDING_VERIFICATION", "CANCELLED"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasContent(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function freshSession(): AgentSession {
  return createAgentSession(randomUUID(), randomUUID());
}

function isValidHistory(value: unknown): value is AgentTurn[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t) => isPlainObject(t) && (t.role === "customer" || t.role === "agent") && typeof t.text === "string"
    )
  );
}

// "Restore it safely" — same rule as v1.ts/v2.ts: a missing/empty/foreign
// context (including one produced by V1 or V2, which have incompatible
// shapes) always falls back to a brand-new session rather than throwing.
function resolveSession(raw: unknown): AgentSession {
  if (!hasContent(raw)) return freshSession();
  try {
    const obj = raw as Record<string, unknown>;
    const conversation = restoreContext(JSON.stringify(obj.conversation));
    const history = isValidHistory(obj.history) ? obj.history : [];
    // Older serialized sessions (pre-Phase-2) never had a `memory` field —
    // defaulting missing/malformed pieces to createEmptyMemory() is a safe
    // restore, same "never throw on foreign/old state" rule as conversation/
    // history above.
    const memory = (isPlainObject(obj.memory) ? { ...createEmptyMemory(), ...obj.memory } : createEmptyMemory()) as ConversationMemory;
    return { conversation, history, memory };
  } catch {
    return freshSession();
  }
}

function toEngineCart(cart: CartState): EngineCartItem[] {
  return cart.items.map((line) => ({ itemId: line.itemId, name: line.name, price: line.price, qty: line.qty }));
}

export const v3Engine: AIEngine = {
  name: "v3",

  async processMessage(request: EngineRequest): Promise<EngineResponse> {
    const session = resolveSession(request.context);

    const turn = await processAgentMessage(session, request.message, menu, restaurantConfig);

    const debug = request.debug
      ? {
          activeEngine: "v3" as const,
          parserSource: turn.usedLLM ? ("llm" as const) : ("deterministic" as const),
          fallbackUsed: turn.fallbackUsed,
          rawState: turn.session.conversation.order.state,
          // V3-specific — visible only in debug mode. Always 0 or 1: the
          // one-call architecture makes more than one Gemini call per
          // customer message structurally impossible.
          cartActions: turn.cartActions,
          checkoutAction: turn.checkoutAction,
          apiCallsThisTurn: turn.apiCallsThisTurn,
          providerAttempted: turn.providerAttempted,
          cooldownActive: turn.cooldownActive,
          providerError: turn.providerError,
          rateLimited429: turn.rateLimited429,
        }
      : undefined;

    return {
      reply: turn.reply,
      context: turn.session,
      cart: toEngineCart(turn.session.conversation.order.cart),
      state: turn.session.conversation.order.state,
      isFinished: FINISHED_STATES.has(turn.session.conversation.order.state),
      ...(debug ? { debug } : {}),
    };
  },
};
