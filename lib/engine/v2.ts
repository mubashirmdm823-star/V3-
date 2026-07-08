// V2 phase 13 — V2 engine adapter.
//
// Wraps v2/core/process-message.ts#processCustomerMessage behind the same
// shared AIEngine interface v1.ts implements. This is the same
// context-resolution logic app/api/chat/route.ts used inline in phase 12 —
// moved here so both the API route and (now) the WhatsApp simulator go
// through one implementation instead of duplicating it (this phase's
// explicit "no duplicated logic" rule).

import { randomUUID } from "node:crypto";
import menuData from "@/v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "@/v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "@/v2/types/menu";
import type { CartState } from "@/v2/types/cart";
import { createConversationContext, restoreContext, type ConversationContext } from "@/v2/core/context-manager";
import { processCustomerMessage } from "@/v2/core/process-message";
import { Logger } from "@/v2/logger";
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

function freshContext(): ConversationContext {
  return createConversationContext(randomUUID(), randomUUID());
}

// "Restore it safely" — see app/api/chat/route.ts's phase-12 header for the
// same reasoning: a missing/empty/foreign context (e.g. one produced by
// the V1 engine) always falls back to a brand-new conversation rather than
// throwing.
function resolveContext(raw: unknown): ConversationContext {
  if (!hasContent(raw)) return freshContext();
  try {
    return restoreContext(JSON.stringify(raw));
  } catch {
    return freshContext();
  }
}

function toEngineCart(cart: CartState): EngineCartItem[] {
  return cart.items.map((line) => ({ itemId: line.itemId, name: line.name, price: line.price, qty: line.qty }));
}

export const v2Engine: AIEngine = {
  name: "v2",

  async processMessage(request: EngineRequest): Promise<EngineResponse> {
    const conversation = resolveContext(request.context);
    const logger = new Logger(conversation.sessionId, conversation.conversationId);

    const { result, conversation: nextConversation } = await processCustomerMessage({
      rawMessage: request.message,
      conversation,
      menu,
      restaurantConfig,
      logger,
    });

    const debug = request.debug
      ? {
          activeEngine: "v2" as const,
          parserSource: result.parserSource,
          pipelineTiming: result.timing,
          fallbackUsed: false,
          rawState: nextConversation.order.state,
        }
      : undefined;

    return {
      reply: result.reply,
      context: nextConversation,
      cart: toEngineCart(nextConversation.order.cart),
      state: nextConversation.order.state,
      isFinished: FINISHED_STATES.has(nextConversation.order.state),
      ...(debug ? { debug } : {}),
    };
  },
};
