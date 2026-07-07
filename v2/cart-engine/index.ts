// V2 phase 4 — cart engine.
//
// The only code allowed to produce a new CartState. Executes structured,
// already-safety-cleared V2 intents — it never interprets customer
// language, never does string matching, and never re-runs any parser
// logic. Every itemId it touches must already be a single resolved
// candidateItemIds[0] the intent parser produced.
//
// Pipeline: Intent Parser -> Safety Layer -> Cart Engine (this) -> Updated
// Cart -> Order State Engine -> Response Builder.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import type { ParseResult, ParsedAction } from "../types/parser";
import { addItem, addMultipleItems, type AddEntry, type CartMutationResult } from "./add";
import { removeItem } from "./remove";
import { replaceItem } from "./replace";
import { setQuantity, increaseQuantity, decreaseQuantity } from "./quantity";
import { clearCart } from "./clear";
import { calculateTotal, type CartTotals } from "./totals";
import { validateCart, type ValidationResult, type ValidationIssue } from "./validate";
import { recordHistory, appendHistory, type CartHistoryEntry } from "./history";

export interface CartEngineResult {
  ok: boolean;
  cart: CartState;
  totals: CartTotals;
  history: CartHistoryEntry[];
  reason?: string;
}

function singleCandidate(ids: string[] | undefined): string | undefined {
  return ids && ids.length === 1 ? ids[0] : undefined;
}

function mutationResultToEngineResult(
  before: CartState,
  result: CartMutationResult,
  action: ParsedAction["action"],
  menu: Menu
): CartEngineResult {
  const totals = calculateTotal(result.cart, menu);
  const history = result.ok ? [recordHistory(before, result.cart, action)] : [];
  return { ok: result.ok, cart: result.cart, totals, history, reason: result.reason };
}

// Executes ONE already-safety-cleared ParsedAction. If the action's items
// don't carry exactly one resolved candidate id each, that means something
// upstream (safety layer) should have blocked this before it ever reached
// here — this rejects rather than guessing which candidate to use.
export function executeAction(action: ParsedAction, cart: CartState, menu: Menu): CartEngineResult {
  switch (action.action) {
    case "ADD_ITEM": {
      const ref = action.items?.[0];
      const itemId = singleCandidate(ref?.candidateItemIds);
      if (!itemId) {
        return { ok: false, cart, totals: calculateTotal(cart, menu), history: [], reason: "ADD_ITEM requires exactly one resolved candidate item id." };
      }
      return mutationResultToEngineResult(cart, addItem(cart, itemId, menu, ref?.quantity ?? 1), action.action, menu);
    }

    case "ADD_MULTIPLE_ITEMS": {
      const refs = action.items ?? [];
      const entries: AddEntry[] = [];
      for (const ref of refs) {
        const itemId = singleCandidate(ref.candidateItemIds);
        if (!itemId) {
          return { ok: false, cart, totals: calculateTotal(cart, menu), history: [], reason: "ADD_MULTIPLE_ITEMS requires every item to have exactly one resolved candidate id." };
        }
        entries.push({ itemId, qty: ref.quantity ?? 1 });
      }
      return mutationResultToEngineResult(cart, addMultipleItems(cart, entries, menu), action.action, menu);
    }

    case "REMOVE_ITEM": {
      const ref = action.items?.[0];
      const itemId = singleCandidate(ref?.candidateItemIds);
      if (!itemId) {
        return { ok: false, cart, totals: calculateTotal(cart, menu), history: [], reason: "REMOVE_ITEM requires exactly one resolved candidate item id." };
      }
      return mutationResultToEngineResult(cart, removeItem(cart, itemId), action.action, menu);
    }

    case "REMOVE_ALL": {
      return mutationResultToEngineResult(cart, clearCart(cart), action.action, menu);
    }

    case "REPLACE_ITEM": {
      // The safety layer already narrowed sourceCandidateItemIds down to
      // "which of these are actually in the cart" when it approved this as
      // SAFE_TO_EXECUTE — mirror that same filtering here rather than
      // requiring the raw (menu-wide, possibly multi-candidate) list to
      // already be a single id.
      const sourceIdsInCart = (action.replace?.sourceCandidateItemIds ?? []).filter((id) =>
        cart.items.some((line) => line.itemId === id)
      );
      const sourceId = singleCandidate(sourceIdsInCart);
      const targetId = singleCandidate(action.replace?.targetCandidateItemIds);
      if (!sourceId || !targetId) {
        return { ok: false, cart, totals: calculateTotal(cart, menu), history: [], reason: "REPLACE_ITEM requires exactly one resolved source (in the cart) and target candidate id." };
      }
      return mutationResultToEngineResult(cart, replaceItem(cart, sourceId, targetId, menu), action.action, menu);
    }

    case "CHANGE_QUANTITY": {
      const ref = action.items?.[0];
      const itemId = singleCandidate(ref?.candidateItemIds);
      if (!itemId || ref?.quantity === undefined) {
        return { ok: false, cart, totals: calculateTotal(cart, menu), history: [], reason: "CHANGE_QUANTITY requires a resolved item id and a target quantity." };
      }
      return mutationResultToEngineResult(cart, setQuantity(cart, itemId, ref.quantity), action.action, menu);
    }
  }
}

// Pipeline entry point: only mutates when the safety layer cleared the
// whole message (SAFE_TO_EXECUTE). Threads the cart through every action in
// order, so compound messages ("remove everything and add 1 large pizza")
// apply sequentially against the result of the previous step.
export function executeParseResult(result: ParseResult, cart: CartState, menu: Menu): CartEngineResult {
  if (result.actions.length === 0) {
    return { ok: true, cart, totals: calculateTotal(cart, menu), history: [] };
  }

  if (result.safetyDecision !== "SAFE_TO_EXECUTE") {
    return {
      ok: false,
      cart,
      totals: calculateTotal(cart, menu),
      history: [],
      reason: `Refusing to mutate cart: safety decision was ${result.safetyDecision}, not SAFE_TO_EXECUTE.`,
    };
  }

  let current = cart;
  let history: CartHistoryEntry[] = [];
  for (const action of result.actions) {
    const step = executeAction(action, current, menu);
    history = [...history, ...step.history];
    if (!step.ok) {
      return { ok: false, cart, totals: calculateTotal(cart, menu), history, reason: step.reason };
    }
    current = step.cart;
  }

  return { ok: true, cart: current, totals: calculateTotal(current, menu), history };
}

// SHOW_CART: read-only, never mutates, never gated by a safety decision.
export function showCart(cart: CartState): CartState {
  return cart;
}

export { calculateTotal };
export type { CartTotals };
export { validateCart };
export type { ValidationResult, ValidationIssue };
export { appendHistory };
export type { CartHistoryEntry };

export { addItem, addMultipleItems };
export type { AddEntry, CartMutationResult };
export { executeActionPlan } from "./action-plan";
export type { ActionPlanExecutionResult } from "./action-plan";
export { removeItem };
export { replaceItem };
export { setQuantity, increaseQuantity, decreaseQuantity };
export { clearCart };
