// V2 phase 10 — the canonical JSON schema the LLM's response must satisfy.
//
// A lightweight, hand-written schema description (no external JSON-schema
// library dependency) — json-validator.ts is the code that actually
// enforces it. Kept as its own file so the "what fields/values are
// allowed" question has one authoritative answer both the validator and
// system-prompt.ts's documented shape can be checked against.

import type { IntentName } from "../types/parser";

// Mirrors v2/types/parser.ts's IntentName exactly — the LLM is expected to
// classify into the same vocabulary the deterministic parser already uses,
// so a validated LLM response and a ParseResult stay interchangeable for
// whatever wires this into the pipeline in a future phase.
export const ALLOWED_LLM_INTENTS: ReadonlySet<IntentName> = new Set([
  "GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT",
  "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK",
  "IRRELEVANT_QUERY", "HELP", "GOODBYE",
  "ADD_ITEM", "ADD_MULTIPLE_ITEMS", "REMOVE_ITEM", "REMOVE_ALL", "REPLACE_ITEM",
  "CHANGE_QUANTITY", "SHOW_OPTIONS", "SHOW_MENU", "SHOW_CART", "PRICE_QUERY",
  "HYPOTHETICAL_TOTAL", "CHECKOUT_START", "CONFIRM_ORDER", "SELECT_DELIVERY",
  "SELECT_PICKUP", "PROVIDE_ADDRESS", "PROVIDE_NAME", "ASK_RESTAURANT_INFO",
  "ASK_CLARIFICATION", "UNKNOWN",
]);

// Every field the model is allowed to return — anything else in the
// top-level object is rejected as an "unknown field" (a model hallucinating
// extra keys, e.g. "total" or "reply", is exactly the failure mode this
// phase's absolute rules forbid).
export const LLM_RESPONSE_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "intent", "confidence", "items", "category", "replace", "needsClarification",
]);

export const LLM_RESPONSE_REQUIRED_FIELDS: readonly string[] = ["intent", "confidence", "items"];

export const LLM_ITEM_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["id", "quantity"]);
export const LLM_REPLACE_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["fromId", "toId"]);

export const MAX_REASONABLE_QUANTITY = 50;
export const MIN_CONFIDENCE_TO_ACCEPT = 0.85; // matches CONFIDENCE_THRESHOLDS.high in intent-parser/confidence.ts
