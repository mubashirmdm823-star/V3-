// Building and resolving AWAITING_CLARIFICATION. Reuses the intent parser's
// own menu-resolution primitives (v2/intent-parser/matching.ts) rather than
// re-implementing item matching here — this module only adds the STATE-
// scoped piece: re-resolving a follow-up reply against the specific pending
// category, which the (stateless, per-message) intent parser has no way to
// know about on its own.

import type { Menu } from "../types/menu";
import type { ParseResult } from "../types/parser";
import type { OrderContext, PendingClarificationContext } from "../types/order";
import type { AskClarificationPlanAction } from "../action-planner/types";
import { findMenuItem } from "../cart-engine/validate";
import { findCategoryForItemId, resolveItemQueryAmongItems } from "../intent-parser/matching";
import { ORDER_VERB_PATTERN } from "../intent-parser/parser";

// ─── Clarification Queue ─────────────────────────────────────────────────────
//
// The FULL backlog of not-yet-resolved ambiguities. `clarificationQueue` is
// optional on OrderContext so every pre-existing consumer/fixture that only
// ever set `pendingClarification` keeps working unchanged — reading through
// these two helpers is the only correct way to touch either field, since
// they keep the invariant `pendingClarification === queue[0]` true always.

export function getClarificationQueue(context: OrderContext): PendingClarificationContext[] {
  if (context.clarificationQueue) return context.clarificationQueue;
  return context.pendingClarification ? [context.pendingClarification] : [];
}

export function withClarificationQueue(
  queue: PendingClarificationContext[]
): Pick<OrderContext, "clarificationQueue" | "pendingClarification"> {
  return { clarificationQueue: queue, pendingClarification: queue[0] };
}

// Converts one Action Planner ASK_CLARIFICATION entry into the stored
// PendingClarificationContext shape — used when appending a NEW ambiguity
// onto the queue (never overwriting whatever's already there).
export function pendingClarificationFromPlanAction(
  action: AskClarificationPlanAction,
  rawUserMessage: string
): PendingClarificationContext {
  return {
    category: action.category,
    quantity: action.quantity,
    question: `Which ${action.category} would you like?`,
    options: action.options,
    previousMessage: rawUserMessage,
  };
}

// Builds the pending-clarification record from a ParseResult the safety
// layer flagged as ASK_CLARIFICATION over an ambiguous item. Returns null if
// there's nothing ambiguous to clarify (caller shouldn't have called this).
export function buildPendingClarification(parseResult: ParseResult, menu: Menu): PendingClarificationContext | null {
  const ambiguous = parseResult.items.find((i) => (i.candidateItemIds?.length ?? 0) > 1);
  if (!ambiguous) return null;

  const anchorId = ambiguous.candidateItemIds![0];
  // Prefer the parser's own already-correctly-scoped family label (e.g.
  // "zinger" — narrowed to just the 3 zinger items, not the whole Burgers
  // category) over the broader category key, which findCategoryForItemId
  // would otherwise almost always resolve to (every item belongs to SOME
  // category, so it was silently winning this fallback chain every time).
  const category = parseResult.category ?? findCategoryForItemId(menu, anchorId)?.key ?? ambiguous.query;
  const options = (ambiguous.candidateItemIds ?? [])
    .map((id) => findMenuItem(menu, id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    category,
    quantity: ambiguous.quantity ?? 1,
    question: parseResult.clarificationQuestion ?? `Which ${ambiguous.query} would you like?`,
    options,
    previousMessage: parseResult.rawUserMessage,
  };
}

// Does the reply text itself state a quantity? Digits that are part of a
// menu item's own name ("Pizza Large 12 inch") don't count — only a
// standalone digit or a number word is an explicit customer quantity.
// ("do" is deliberately absent: it's usually the verb particle.)
// Unit words are matched typo-tolerantly (i+n+c+h+ covers "incch") so a
// typo inside an item's own "9 inch"/"8 pcs" never reads as an explicit
// customer quantity.
const EXPLICIT_QTY_PATTERN =
  /\b\d+\b(?!\s*(?:i+n+c+h+e*s*|p+i?e?c+e?s*)\b)|\b(?:ek|aik|one|two|teen|three|char|chaar|four|panch|paanch|five)\b/;

// The customer already told us HOW MANY when they said the ambiguous thing
// ("3 zinger" -> which zinger?). A bare follow-up naming just the variant
// ("Jumbo Zinger") answers WHICH, not HOW MANY — the pending quantity must
// carry over, not silently reset to 1. A reply that states its own
// quantity ("2 small 2 large 1 alfredo") keeps what it says.
function inheritPendingQuantity(
  items: ParseResult["items"],
  pending: PendingClarificationContext,
  normalizedMessage: string
): ParseResult["items"] {
  if (pending.quantity <= 1) return items;
  if (items.length !== 1) return items; // multi-variant breakdowns carry their own quantities
  if (EXPLICIT_QTY_PATTERN.test(normalizedMessage)) return items;
  return items.map((ref) => ({ ...ref, quantity: pending.quantity }));
}

// Only these intents can ever BE an answer to "which one did you mean?" —
// restricting this is what fixes a real bug: a REMOVE_ITEM/REPLACE_ITEM/
// CHANGE_QUANTITY message sent while a clarification was pending could
// previously fall through this function's generic item-shape checks (their
// ParseResult.items/actions can incidentally look "resolved") and get
// mis-converted into an ADD_ITEM action — e.g. "gyro remove karo" while
// "which pasta?" was pending got silently rewritten into adding a gyro
// instead of removing one, and dropped the pasta question in the process.
// Every OTHER intent must be handled as itself by the caller instead (see
// order-state-engine/index.ts#handleAwaitingClarification), preserving the
// queue rather than being funneled through here.
const CLARIFICATION_ANSWER_INTENTS = new Set(["ADD_ITEM", "ADD_MULTIPLE_ITEMS", "ASK_CLARIFICATION", "UNKNOWN"]);

// The outcome of trying to read a follow-up message as the answer to a
// pending clarification.
//   "resolved"            — every item matched exactly one pending option.
//   "unavailable"         — the reply named something that isn't ANY of the
//                           pending options (a different category entirely,
//                           e.g. "club" while "which pasta?" is pending) —
//                           gets the explicit "not available in this
//                           category" message (rule 5), queue preserved.
//   "ambiguous_in_category" — the reply matched 2+ pending options (e.g. a
//                           word shared by two variants) — re-ask the SAME
//                           question (rule 4), queue preserved.
//   "not_an_answer"       — this message isn't even attempting to answer
//                           (wrong intent, or nothing resolvable at all) —
//                           the caller falls back to its normal handling
//                           (a genuinely new/unrelated cart edit, etc).
export type ClarificationReplyOutcome =
  | { kind: "resolved"; result: ParseResult }
  | { kind: "unavailable" }
  | { kind: "ambiguous_in_category" }
  | { kind: "not_an_answer" };

// Attempts to resolve a follow-up message against a pending clarification.
// Every item query is matched STRICTLY against `pending.options` — the
// exact set of items the pending question itself offered — never against
// the whole menu and never against any other category. This is deliberate:
// the parser's own (menu-wide) resolution of the reply is never trusted
// here, even when it already looks confidently resolved, because a bare
// word can be a confident, unambiguous match somewhere else on the menu
// entirely (e.g. "club" alone resolves unambiguously to "Club Sandwich"
// menu-wide) while not being one of the options THIS question offered
// (e.g. a pending "which pasta?") — using that menu-wide match would wrongly
// add an item from a different category instead of recognizing the answer
// doesn't apply here.
export function resolveClarificationReply(
  pending: PendingClarificationContext,
  parseResult: ParseResult,
  menu: Menu
): ClarificationReplyOutcome {
  if (!CLARIFICATION_ANSWER_INTENTS.has(parseResult.intent)) return { kind: "not_an_answer" };
  if (parseResult.items.length === 0) return { kind: "not_an_answer" };

  // A typo-heavy/garbage reply the stateless parser rejected outright
  // (tokens not recognized ANYWHERE on the menu) must re-ask, never be
  // fuzzy-matched against the pending options — pending.options's own
  // loose token-overlap scoring (resolveItemQueryAmongItems's last-resort
  // tier) can otherwise "recognize" a shared word (e.g. "Special") inside
  // heavily garbled text and silently add the wrong confidence. This is
  // distinct from the cross-category case below: REJECT_UNAVAILABLE means
  // NOTHING on the whole menu was recognized, whereas a real word that
  // resolves confidently to a DIFFERENT category (e.g. "club") still
  // reaches the scoped check and is correctly reported as "unavailable"
  // here, not silently re-asked.
  if (parseResult.safetyDecision === "REJECT_UNAVAILABLE") return { kind: "not_an_answer" };

  const scopedResults = parseResult.items.map((ref) => resolveItemQueryAmongItems(ref.query, pending.options));

  // A full, explicit, unambiguous NEW order ("bhai 3 Zinger Burger W/C add
  // kar do", "i want 2 Mexican Pizza") must never be swallowed as a
  // rejected answer (or a spurious re-ask) to an unrelated pending question
  // just because it doesn't cleanly scope-match THIS category's options
  // (live QA bugs: both were correctly parsed as an exact, single, real
  // menu item, but got "not available in Pizza large" — or a silent re-ask
  // of the SAME pizza question — instead of landing). Distinguishing
  // signal: an explicit order verb (ORDER_VERB_PATTERN — the exact same
  // signal that already turns a bare category name from browsing into
  // ordering elsewhere in this parser) is present, AND every item the
  // customer named is ALREADY a confident, single, real menu match at the
  // menu-wide level (parseResult.items' own candidateItemIds, computed by
  // the stateless parser before this function ever narrowed anything to
  // `pending.options`). A bare, verb-less word like "club" that also
  // happens to resolve unambiguously elsewhere on the menu is deliberately
  // NOT covered by this check — the missing verb is what correctly keeps
  // it reading as a (rejected) attempt to answer THIS question, not a new
  // order (rule 5 still applies to that case).
  const isExplicitUnambiguousNewOrder =
    ORDER_VERB_PATTERN.test(parseResult.normalizedMessage) &&
    parseResult.items.every((ref) => (ref.candidateItemIds?.length ?? 0) === 1);

  // The explicit-new-order case wins over any scoped outcome that DISAGREES
  // with the item's own confident whole-menu match — not just a zero-match
  // ("outside the category entirely," e.g. "Zinger Burger W/C" vs a pending
  // Pizza question — no shared tokens at all) or a spurious 2+-match tie
  // (e.g. "Mexican Pizza" vs pending ["Pizza Large 12 inch", "Pizza Large
  // Cheese Topping"] — both score equally on the incidentally-shared word
  // "pizza"), but ALSO a spurious single-match tie that happens to point at
  // the WRONG pending option (live QA bug: "2 Pizza Regular 9 inch add
  // karo" while "which Pizza small?" was pending scored "Pizza Small 6
  // inch" as a confident single match purely because it shares the tokens
  // "pizza" AND "inch" with the query — and a length-1 scoped result looks
  // identical in shape to a genuine correct answer unless it's checked
  // against what the customer actually, confidently meant). Only a scoped
  // result that resolves to EXACTLY the same id the stateless parser
  // already confidently resolved menu-wide is trusted as a real answer to
  // THIS question; any disagreement — 0, 2+, or a different single id —
  // falls through as a genuinely new, independent cart edit instead of
  // being force-fit into this unrelated clarification.
  if (isExplicitUnambiguousNewOrder) {
    const agreesWithConfidentMatch = parseResult.items.every(
      (ref, i) => scopedResults[i].length === 1 && scopedResults[i][0] === ref.candidateItemIds![0]
    );
    if (!agreesWithConfidentMatch) return { kind: "not_an_answer" };
  }

  // Any item in the reply that doesn't match ANY option this question
  // offered means the customer named something from outside the pending
  // category entirely — never silently add it or fall back to a menu-wide
  // guess (rule 5: tell them plainly instead).
  if (scopedResults.some((ids) => ids.length === 0)) return { kind: "unavailable" };

  // Any item that matches 2+ options within the category is still
  // ambiguous within scope (e.g. a word shared by two variants) — ask
  // again rather than guess (rule 4).
  if (scopedResults.some((ids) => ids.length > 1)) return { kind: "ambiguous_in_category" };

  const resolvedItems = parseResult.items.map((ref, i) => ({ ...ref, candidateItemIds: scopedResults[i] }));
  const finalItems = inheritPendingQuantity(resolvedItems, pending, parseResult.normalizedMessage);
  const actionName = finalItems.length > 1 ? "ADD_MULTIPLE_ITEMS" : "ADD_ITEM";
  return {
    kind: "resolved",
    result: {
      ...parseResult,
      intent: actionName,
      items: finalItems,
      actions: [{ action: actionName, items: finalItems }],
      needsClarification: false,
      clarificationQuestion: undefined,
      safetyDecision: "SAFE_TO_EXECUTE",
    },
  };
}
