// V2 phase 9 — conversation memory.
//
// ConversationMemory is a read-derived enrichment layer on top of the
// already-authoritative OrderContext (v2/types/order.ts, owned by the
// order-state-engine and threaded turn-to-turn by v2/core/context-manager.ts).
// It never re-decides cart/state/clarification — those fields are copied
// verbatim from the real OrderContext each turn ("pure context restoration",
// per this phase's instructions). What it adds on top: bounded history of
// prior intents/actions/replies, and topic-tracking fields (currentTopic,
// lastMentionedCategory/Product, lastOrderedCategory/Item) that don't exist
// anywhere else in the pipeline yet.

import type { CartState } from "../types/cart";
import type { OrderContext, OrderState, OrderType, PendingClarificationContext } from "../types/order";
import type { IntentName } from "../types/parser";

// Bounded so a very long conversation's memory object doesn't grow without
// limit — only the most recent N of each list is kept (the full turn-by-turn
// record, if needed, lives in history.ts's ConversationTurn[] instead, which
// pruning.ts is responsible for trimming).
export const MAX_MEMORY_LIST_LENGTH = 20;

export interface ConversationMemory {
  conversationId: string;
  sessionId: string;

  customerName?: string;
  deliveryType?: OrderType;
  deliveryAddress?: string;

  currentCart: CartState;
  currentOrderState: OrderState;
  pendingClarification?: PendingClarificationContext;

  previousIntents: IntentName[];
  previousActions: string[];
  previousAIResponses: string[];

  lastOrderedCategory?: string;
  lastOrderedItem?: string;
  currentTopic?: string;
  lastMentionedCategory?: string;
  lastMentionedProduct?: string;

  // Mirrors currentOrderState — kept as its own field because the spec
  // tracks "Order State" and "Checkout Stage" as two distinct pieces of
  // memory, even though both are sourced from the same OrderContext.state
  // in this architecture (there's no separate checkout sub-state machine).
  currentCheckoutStage: OrderState;

  currentResponseSeed: string;
  conversationTimestamp: string;
  updatedAt: string;
  messageCounter: number;
}

export function createInitialMemory(
  conversationId: string,
  sessionId: string,
  cart: CartState = { items: [] },
  now: () => Date = () => new Date()
): ConversationMemory {
  const timestamp = now().toISOString();
  return {
    conversationId,
    sessionId,
    currentCart: cart,
    currentOrderState: "BROWSING",
    currentCheckoutStage: "BROWSING",
    previousIntents: [],
    previousActions: [],
    previousAIResponses: [],
    currentResponseSeed: "",
    conversationTimestamp: timestamp,
    updatedAt: timestamp,
    messageCounter: 0,
  };
}

function pushBounded<T>(list: T[], value: T, max: number = MAX_MEMORY_LIST_LENGTH): T[] {
  const next = [...list, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

// JSON.stringify drops keys whose value is undefined, so an in-memory
// object with an explicit `key: undefined` would silently gain/lose that
// key across a save/restore round trip. Stripping it here means every
// ConversationMemory this module produces is already in its "serialized"
// shape — the round trip in session.ts is then a true no-op, not a
// normalization step.
export function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as T;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) result[key] = obj[key];
  }
  return result;
}

// Mirrors the fields OrderContext already owns — never invents a value for
// them, only copies. Immutable, matching order-state-engine/context.ts#touch's
// convention.
export function syncMemoryFromOrderContext(memory: ConversationMemory, order: OrderContext): ConversationMemory {
  return omitUndefined({
    ...memory,
    currentCart: order.cart,
    currentOrderState: order.state,
    currentCheckoutStage: order.state,
    pendingClarification: order.pendingClarification,
    customerName: order.customerName ?? memory.customerName,
    deliveryType: order.deliveryType ?? memory.deliveryType,
    deliveryAddress: order.address ?? memory.deliveryAddress,
  });
}

export interface RecordTurnInput {
  intent: IntentName;
  action?: string;
  aiResponse: string;
  responseSeed: string;
}

export function recordTurn(
  memory: ConversationMemory,
  input: RecordTurnInput,
  now: () => Date = () => new Date()
): ConversationMemory {
  return {
    ...memory,
    previousIntents: pushBounded(memory.previousIntents, input.intent),
    previousActions: input.action ? pushBounded(memory.previousActions, input.action) : memory.previousActions,
    previousAIResponses: pushBounded(memory.previousAIResponses, input.aiResponse),
    currentResponseSeed: input.responseSeed,
    messageCounter: memory.messageCounter + 1,
    updatedAt: now().toISOString(),
  };
}

export interface TopicUpdate {
  currentTopic?: string;
  lastMentionedCategory?: string;
  lastMentionedProduct?: string;
  lastOrderedCategory?: string;
  lastOrderedItem?: string;
}

// Topic fields only ever move FORWARD when new signal is found — a message
// with no menu-relevant content (e.g. "ruko", "thanks") leaves the existing
// topic untouched, per "never lose topic until conversation naturally
// changes". Use resetTopic() below for the one place a topic genuinely ends.
export function applyTopicUpdate(memory: ConversationMemory, update: TopicUpdate): ConversationMemory {
  return omitUndefined({
    ...memory,
    currentTopic: update.currentTopic ?? memory.currentTopic,
    lastMentionedCategory: update.lastMentionedCategory ?? memory.lastMentionedCategory,
    lastMentionedProduct: update.lastMentionedProduct ?? memory.lastMentionedProduct,
    lastOrderedCategory: update.lastOrderedCategory ?? memory.lastOrderedCategory,
    lastOrderedItem: update.lastOrderedItem ?? memory.lastOrderedItem,
  });
}

// The one deliberate "conversation naturally changes" boundary: the cart
// being fully cleared, or an order finishing (PENDING_VERIFICATION), means
// whatever was being discussed is over — a fresh topic should be found from
// scratch rather than carried forward.
export function resetTopic(memory: ConversationMemory): ConversationMemory {
  const { currentTopic, lastMentionedCategory, lastMentionedProduct, ...rest } = memory;
  return rest as ConversationMemory;
}
