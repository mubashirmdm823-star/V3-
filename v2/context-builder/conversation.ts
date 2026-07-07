// V2 phase 9 — "Current Conversation": the single-turn record shape, and
// the function that builds one from an already-completed pipeline turn.
// This never re-parses or re-decides anything — it only records what the
// intent parser / order-state-engine / response builder already produced,
// the same "observe, don't decide" rule the logging layer (v2/logger/)
// already follows.

import type { OrderState } from "../types/order";
import type { IntentName, ParseResult } from "../types/parser";
import { omitUndefined } from "./memory";

export interface ConversationTurn {
  turnNumber: number;
  timestamp: string;
  rawMessage: string;
  intent: IntentName;
  action?: string;
  category?: string;
  aiResponse: string;
  stateBefore: OrderState;
  stateAfter: OrderState;
}

export interface BuildTurnInput {
  turnNumber: number;
  parseResult: ParseResult;
  stateBefore: OrderState;
  stateAfter: OrderState;
  aiResponse: string;
}

export function buildTurn(input: BuildTurnInput, now: () => Date = () => new Date()): ConversationTurn {
  const { parseResult } = input;
  return omitUndefined({
    turnNumber: input.turnNumber,
    timestamp: now().toISOString(),
    rawMessage: parseResult.rawUserMessage,
    intent: parseResult.intent,
    action: parseResult.actions[0]?.action,
    category: parseResult.category,
    aiResponse: input.aiResponse,
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
  });
}

// A turn is "greeting/thank-you-shaped" small talk — never something the
// cart/state/topic cares about. Scoped narrowly to pruning decisions only
// (never used to classify intent for real business logic).
const GREETING_OR_THANKS_WORDS = [
  "hi", "hello", "salam", "assalam", "hey",
  "thanks", "thank you", "shukriya", "mehrbani", "great", "ok thanks",
];

export function isGreetingOrThanksTurn(turn: ConversationTurn): boolean {
  const text = turn.rawMessage.trim().toLowerCase();
  return GREETING_OR_THANKS_WORDS.some((w) => text === w || text.includes(w));
}

const LOW_SIGNAL_INTENTS: ReadonlySet<IntentName> = new Set([
  "SHOW_MENU", "SHOW_OPTIONS", "ASK_RESTAURANT_INFO", "PRICE_QUERY", "HYPOTHETICAL_TOTAL",
]);

export function isLowSignalTurn(turn: ConversationTurn): boolean {
  return LOW_SIGNAL_INTENTS.has(turn.intent) || turn.intent === "UNKNOWN";
}

// A turn belonging to an order that has since fully finished (or was
// cancelled) — once the conversation has moved past it, it's an "old
// completed conversation" per the Context Window Optimizer spec.
export function isCompletedCheckoutTurn(turn: ConversationTurn): boolean {
  return turn.stateAfter === "PENDING_VERIFICATION" || turn.stateAfter === "CANCELLED";
}
