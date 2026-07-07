// V2 phase 9 — the context builder.
//
// The intelligence layer that gives the (future) LLM memory between
// messages. This module never calls an LLM and never parses/mutates
// cart or order state itself — it only combines what the already-shipped
// layers produced (OrderContext, ParseResult, the reply text) into a
// durable ConversationMemory, and assembles a "Final AI Context Object"
// ready to hand to the next phase's LLM call.
//
// Pipeline (per this phase's spec): Current Conversation -> Conversation
// Memory -> Current Cart -> Order State -> Pending Clarification ->
// Restaurant Config -> Relevant Menu Context -> Customer Message -> Final
// AI Context Object.

import type { CartState } from "../types/cart";
import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderContext, OrderState, PendingClarificationContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import { findCategoryForItemId } from "../intent-parser/matching";
import {
  type ConversationMemory,
  type TopicUpdate,
  syncMemoryFromOrderContext,
  recordTurn,
  applyTopicUpdate,
  resetTopic,
} from "./memory";
import { type ConversationTurn, buildTurn } from "./conversation";
import { appendTurn } from "./history";
import { pruneHistory } from "./pruning";
import { buildRelevantMenu, type MenuContextResult } from "./menu-context";
import { buildContextSummary } from "./context-summary";
import { isValidAIContext } from "./context-validator";
import { type MemorySession } from "./session";

export interface AIContext {
  conversationId: string;
  sessionId: string;
  timestamp: string;
  customerMessage: string;
  memory: ConversationMemory;
  history: ConversationTurn[];
  relevantMenu: Menu;
  menuContext: MenuContextResult;
  restaurantConfig: RestaurantConfig;
  currentCart: CartState;
  currentState: OrderState;
  pendingClarification?: PendingClarificationContext;
  summary: string;
}

function cartItemIds(cart: CartState): Set<string> {
  return new Set(cart.items.map((i) => i.itemId));
}

// Intents where naming an item means the customer is actively steering the
// order toward it — worth moving the STICKY currentTopic. Everything else
// (price checks, restaurant info, show-cart, ...) can still mention an item
// in passing without hijacking what the conversation is "about" — those
// only ever update the more volatile lastMentionedCategory/Product.
const TOPIC_SHIFTING_INTENTS = new Set([
  "ADD_ITEM", "ADD_MULTIPLE_ITEMS", "REPLACE_ITEM", "CHANGE_QUANTITY", "SHOW_OPTIONS", "ASK_CLARIFICATION",
]);

// Only ever moves topic tracking FORWARD from real signal already produced
// by the intent parser/cart engine — never re-parses rawUserMessage itself.
function deriveTopicUpdate(parseResult: ParseResult, before: OrderContext, after: OrderContext, menu: Menu): TopicUpdate {
  const update: TopicUpdate = {};
  const isTopicShifting = TOPIC_SHIFTING_INTENTS.has(parseResult.intent);

  for (const ref of parseResult.items) {
    if (ref.candidateItemIds?.length === 1) {
      const category = findCategoryForItemId(menu, ref.candidateItemIds[0]);
      if (category) {
        update.lastMentionedCategory = category.title;
        if (isTopicShifting) update.currentTopic = category.title;
      }
      const item = category?.items.find((i) => i.id === ref.candidateItemIds![0]);
      if (item) update.lastMentionedProduct = item.name;
    }
  }

  if (parseResult.category) {
    const category = menu.categories.find(
      (c) => c.title.toLowerCase() === parseResult.category!.toLowerCase() || c.key === parseResult.category
    );
    const label = category?.title ?? parseResult.category;
    update.lastMentionedCategory = update.lastMentionedCategory ?? label;
    if (isTopicShifting) update.currentTopic = update.currentTopic ?? label;
  }

  // The strongest possible signal: an item actually landed in the cart.
  // Always wins over the (weaker) parseResult-derived guesses above,
  // regardless of intent — this is what makes REPLACE_ITEM's target (whose
  // ParsedAction carries no `items`/`category` at all) still update the
  // topic correctly.
  const beforeIds = cartItemIds(before.cart);
  const addedLines = after.cart.items.filter((line) => !beforeIds.has(line.itemId));
  if (addedLines.length > 0) {
    const addedCategory = findCategoryForItemId(menu, addedLines[0].itemId);
    if (addedCategory) {
      update.lastOrderedCategory = addedCategory.title;
      update.lastMentionedCategory = addedCategory.title;
      update.currentTopic = addedCategory.title;
    }
    update.lastOrderedItem = addedLines[0].name;
    update.lastMentionedProduct = addedLines[0].name;
  }

  return update;
}

// The one deliberate "the conversation naturally moved on" boundary this
// phase implements: an explicit REMOVE_ALL that actually emptied a
// previously non-empty cart.
function shouldResetTopic(before: OrderContext, after: OrderContext): boolean {
  return before.cart.items.length > 0 && after.cart.items.length === 0;
}

export interface UpdateMemoryAfterTurnInput {
  rawMessage: string;
  parseResult: ParseResult;
  before: OrderContext;
  after: OrderContext;
  reply: string;
  menu: Menu;
}

export function updateMemoryAfterTurn(
  session: MemorySession,
  input: UpdateMemoryAfterTurnInput,
  now: () => Date = () => new Date()
): MemorySession {
  const { parseResult, before, after, reply, menu } = input;

  let memory = syncMemoryFromOrderContext(session.memory, after);
  memory = recordTurn(
    memory,
    {
      intent: parseResult.intent,
      action: parseResult.actions[0]?.action,
      aiResponse: reply,
      responseSeed: input.rawMessage,
    },
    now
  );

  memory = shouldResetTopic(before, after) ? resetTopic(memory) : applyTopicUpdate(memory, deriveTopicUpdate(parseResult, before, after, menu));

  const turn = buildTurn(
    {
      turnNumber: memory.messageCounter,
      parseResult,
      stateBefore: before.state,
      stateAfter: after.state,
      aiResponse: reply,
    },
    now
  );

  const history = pruneHistory(appendTurn(session.history, turn), { currentTopic: memory.currentTopic });

  return { memory, history };
}

const FALLBACK_SUMMARY = "Current State:\nBROWSING\n\nCurrent Cart:\nEmpty";

function fallbackAIContext(session: MemorySession, customerMessage: string, restaurantConfig: RestaurantConfig, now: () => Date): AIContext {
  const timestamp = now().toISOString();
  return {
    conversationId: session.memory.conversationId,
    sessionId: session.memory.sessionId,
    timestamp,
    customerMessage,
    memory: session.memory,
    history: [],
    relevantMenu: { categories: [] },
    menuContext: { categories: [], matchedCategoryKeys: [], isFullMenu: false, restaurantOnly: false },
    restaurantConfig,
    currentCart: session.memory.currentCart,
    currentState: session.memory.currentOrderState,
    pendingClarification: session.memory.pendingClarification,
    summary: FALLBACK_SUMMARY,
  };
}

// Builds the "Final AI Context Object" for the NEXT customer message — this
// runs BEFORE that message is parsed, so it can only use the menu-vocabulary
// heuristics in menu-context.ts (no ParseResult exists yet for `customerMessage`).
export function buildAIContext(
  session: MemorySession,
  customerMessage: string,
  menu: Menu,
  restaurantConfig: RestaurantConfig,
  now: () => Date = () => new Date()
): AIContext {
  const { memory, history } = session;
  const menuContext = buildRelevantMenu(menu, customerMessage, {
    currentTopic: memory.currentTopic,
    lastMentionedCategory: memory.lastMentionedCategory,
  });

  const context: AIContext = {
    conversationId: memory.conversationId,
    sessionId: memory.sessionId,
    timestamp: now().toISOString(),
    customerMessage,
    memory,
    history,
    relevantMenu: { categories: menuContext.categories },
    menuContext,
    restaurantConfig,
    currentCart: memory.currentCart,
    currentState: memory.currentOrderState,
    pendingClarification: memory.pendingClarification,
    summary: buildContextSummary(memory),
  };

  // Reject invalid context, fall back safely rather than handing a
  // malformed object to whatever calls this next.
  return isValidAIContext(context) ? context : fallbackAIContext(session, customerMessage, restaurantConfig, now);
}
