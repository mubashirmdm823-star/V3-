// Public output contract for the V2 intent parser (v2/intent-parser/parser.ts).
//
// This is deliberately a DIFFERENT vocabulary from the internal Intent/IntentType
// in v2/types/intent.ts (which the safety layer already consumes and is tested
// against). The parser builds an internal Intent to run through the existing
// evaluateSafety(), then reports the result here using the SCREAMING_SNAKE_CASE
// names product/tests expect. Keeping the two separate means the already-shipped
// safety layer (v2/intent-parser/safety.ts + its tests) never had to change.

import type { IntentItemRef, ReplaceIntentDetail } from "./intent";
import type { SafetyDecisionType } from "../intent-parser/safety";

export type IntentName =
  // Conversational intents (the V2 Customer Conversation Layer): these never
  // mutate the cart unless a state explicitly requires it (YES confirming a
  // review, CANCEL_ORDER ending the order).
  | "GREETING"
  | "THANKS"
  | "YES"
  | "NO"
  | "WAIT"
  | "CANCEL_ORDER"
  | "HUMAN_SUPPORT"
  | "COMPLAINT"
  | "RECOMMENDATION_REQUEST"
  | "CONFUSED_CUSTOMER"
  | "SMALL_TALK"
  | "IRRELEVANT_QUERY"
  | "HELP"
  | "GOODBYE"
  // Ordering intents.
  | "ADD_ITEM"
  | "ADD_MULTIPLE_ITEMS"
  | "REMOVE_ITEM"
  | "REMOVE_ALL"
  | "REPLACE_ITEM"
  | "CHANGE_QUANTITY"
  | "SHOW_OPTIONS"
  | "SHOW_MENU"
  | "SHOW_CART"
  | "PRICE_QUERY"
  | "HYPOTHETICAL_TOTAL"
  | "CHECKOUT_START"
  | "CONFIRM_ORDER"
  | "SELECT_DELIVERY"
  | "SELECT_PICKUP"
  | "PROVIDE_ADDRESS"
  | "PROVIDE_NAME"
  | "ASK_RESTAURANT_INFO"
  | "ASK_CLARIFICATION"
  | "UNKNOWN";

// The subset of IntentName values that actually imply a cart-affecting
// operation — this is what populates ParseResult.actions.
export type CartActionName =
  | "ADD_ITEM"
  | "ADD_MULTIPLE_ITEMS"
  | "REMOVE_ITEM"
  | "REMOVE_ALL"
  | "REPLACE_ITEM"
  | "CHANGE_QUANTITY";

export interface ParsedAction {
  action: CartActionName;
  items?: IntentItemRef[];
  replace?: ReplaceIntentDetail;
}

export interface ParseResult {
  intent: IntentName;
  confidence: number;
  items: IntentItemRef[];
  actions: ParsedAction[];
  category?: string;
  needsClarification: boolean;
  // Doubles as the customer-facing copy for a rejection (e.g. "not in cart"),
  // not just a literal question — there's no separate field in this contract
  // for rejection text, and reusing this one keeps the schema exactly what
  // was asked for.
  clarificationQuestion?: string;
  safetyDecision: SafetyDecisionType;
  rawUserMessage: string;
  normalizedMessage: string;
}
