// V2 phase 11 — ParseResult mapper.
//
// Converts a validated LLMStructuredResponse (v2/llm/json-validator.ts
// already guaranteed every item id is a real menu item, every quantity is a
// bounded positive integer, and the intent is recognized) into the EXACT
// same ParseResult contract the deterministic intent parser
// (v2/intent-parser/parser.ts) produces. Everything after this point in the
// pipeline — safety, cart engine, order state engine, response builder,
// logger — reads a ParseResult and has no way to tell whether it came from
// here or from parseMessage().
//
// This file does not re-decide any business rule. It reuses:
//   - parser.ts's own IntentName -> legacy IntentType bridge (toLegacyType)
//   - safety.ts's evaluateSafety() — the SAME safety evaluation
//     parseMessage() runs internally, so a mapped ParseResult's
//     safetyDecision is produced by the identical function, not a
//     re-implementation of it.
//   - intent-parser/clarification.ts's clarifyUnclearMessage() for the one
//     case (the LLM itself flagged uncertainty) that has no deterministic
//     parser equivalent to imitate.
// The only genuinely new code here is structural: shaping IntentItemRef[]/
// ParsedAction[] from the LLM's much simpler {id, quantity} item shape —
// there is no existing function to reuse for that translation, since no
// other module has ever needed to go this direction (JSON -> ParseResult)
// before.

import type { CartState } from "../types/cart";
import type { Intent, IntentItemRef, ReplaceIntentDetail } from "../types/intent";
import type { Menu } from "../types/menu";
import type { CartActionName, IntentName, ParsedAction, ParseResult } from "../types/parser";
import { evaluateSafety } from "../intent-parser/safety";
import { toLegacyType } from "../intent-parser/parser";
import { clarifyUnclearMessage } from "../intent-parser/clarification";
import { normalizeMessage } from "../intent-parser/normalize";
import { findMenuItem } from "../cart-engine/validate";
import type { LLMReplaceDetail, LLMResponseItem, LLMStructuredResponse } from "./types";

const CART_ACTION_INTENTS: ReadonlySet<IntentName> = new Set([
  "ADD_ITEM", "ADD_MULTIPLE_ITEMS", "REMOVE_ITEM", "REMOVE_ALL", "REPLACE_ITEM", "CHANGE_QUANTITY",
]);

function mapItems(items: LLMResponseItem[], menu: Menu): IntentItemRef[] {
  return items.map((item) => ({
    // No raw customer phrase exists for an LLM-resolved item — the real
    // item's own name is the closest honest stand-in, used only for
    // display/logging (e.g. response-builder's confirmation templates),
    // never for re-resolution (candidateItemIds is what actually drives
    // downstream behavior).
    query: findMenuItem(menu, item.id)?.name ?? item.id,
    quantity: item.quantity,
    candidateItemIds: [item.id],
  }));
}

function mapReplace(replace: LLMReplaceDetail, menu: Menu): ReplaceIntentDetail {
  return {
    sourceQuery: findMenuItem(menu, replace.fromId)?.name ?? replace.fromId,
    targetQuery: findMenuItem(menu, replace.toId)?.name ?? replace.toId,
    sourceCandidateItemIds: [replace.fromId],
    targetCandidateItemIds: [replace.toId],
  };
}

function buildActions(
  intent: IntentName,
  items: IntentItemRef[],
  replace: ReplaceIntentDetail | undefined
): ParsedAction[] {
  if (!CART_ACTION_INTENTS.has(intent)) return [];
  if (intent === "REMOVE_ALL") return [{ action: "REMOVE_ALL" }];
  if (intent === "REPLACE_ITEM") return replace ? [{ action: "REPLACE_ITEM", replace }] : [];
  return [{ action: intent as CartActionName, items }];
}

export function mapLLMResponseToParseResult(
  response: LLMStructuredResponse,
  rawMessage: string,
  cart: CartState,
  menu: Menu
): ParseResult {
  const normalizedMessage = normalizeMessage(rawMessage);
  const items = mapItems(response.items, menu);
  const replace = response.replace ? mapReplace(response.replace, menu) : undefined;
  const actions = buildActions(response.intent, items, replace);

  const legacyIntent: Intent = {
    type: toLegacyType(response.intent),
    rawText: rawMessage,
    confidence: response.confidence,
    items: items.length > 0 ? items : undefined,
    replace,
  };
  const safety = evaluateSafety(legacyIntent, cart, menu);

  // The LLM's own signal that it wasn't confident enough to name a
  // concrete item — there is no ambiguous-candidate list to build a
  // pending-clarification question from (the LLM's schema only ever names
  // ONE id per item), so this mirrors the deterministic parser's own
  // "order-like phrasing but nothing resolvable" fallback rather than
  // inventing new customer-facing behavior.
  const needsClarification = response.needsClarification ?? safety.decision === "ASK_CLARIFICATION";
  const clarificationQuestion = safety.message ?? (response.needsClarification ? clarifyUnclearMessage() : undefined);

  return {
    intent: response.intent,
    confidence: response.confidence,
    items,
    actions,
    category: response.category,
    needsClarification,
    clarificationQuestion,
    safetyDecision: safety.decision,
    rawUserMessage: rawMessage,
    normalizedMessage,
  };
}
