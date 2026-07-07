// V3 one-call agent — validate & apply cartActions/checkoutAction.
//
// This file never calls an LLM and never writes customer-facing text; it
// only mutates a real v2 OrderContext and returns FACTS (real menu names/
// prices/totals/state — never invented) for correct-reply.ts to check
// Gemini's reply against. Every item mention is raw customer text —
// resolution against the real menu happens here, via the exact same
// deterministic primitives V2's own pipeline uses
// (v2/intent-parser/matching.ts): 0 candidates -> unavailable, 1 ->
// unambiguous, 2+ -> ambiguous. "Never invent a menu item" is therefore
// structural, not a prompt instruction.

import type { Menu, MenuItem, RestaurantConfig } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { OrderContext, PendingClarificationContext } from "../../v2/types/order";
import type { ParseResult } from "../../v2/types/parser";
import { touch } from "../../v2/order-state-engine/context";
import { getClarificationQueue, withClarificationQueue, pendingClarificationFromPlanAction } from "../../v2/order-state-engine/clarification";
import {
  canStartCheckout,
  canConfirmOrder,
  canSelectDeliveryPickup,
  canAcceptAddress,
  canAcceptName,
  canSubmitOrder,
} from "../../v2/order-state-engine/guards";
import { nextStateAfterCartMutation } from "../../v2/order-state-engine/transitions";
import { isValidAddressReply, extractCustomerName } from "../../v2/order-state-engine/customer-info";
import { findCategoryForItemId, buildMenuVocabulary, resolveItemQuery, resolveItemQueryAmongItems } from "../../v2/intent-parser/matching";
import { buildActionPlan, isAskClarificationAction } from "../../v2/action-planner";
import { executeActionPlan } from "../../v2/cart-engine/action-plan";
import { addItem, removeItem, replaceItem, setQuantity, clearCart } from "../../v2/cart-engine";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { findMenuItem } from "../../v2/cart-engine/validate";
import type { CartAction, CheckoutAction, ItemMention } from "./schema";

export interface CartLineFact {
  name: string;
  quantity: number;
  price: number;
}

// Everything correct-reply.ts needs to check Gemini's draft reply against.
export interface TurnFacts {
  addedLines: CartLineFact[];
  removedNames: string[];
  replacedNames: { fromName: string; toName: string }[];
  changedQuantity: { name: string; quantity: number }[];
  clearedCart: boolean;
  unavailableQueries: string[];
  // A single-mention add matched against the pending clarification's
  // options, but the query names something for real elsewhere on the menu
  // — never silently added, never silently ignored either.
  clarificationRejected: { category: string; options: MenuItem[] } | null;
  clarificationStillAmbiguous: { category: string } | null;
  // The chosen item's name plus every OTHER candidate name that could have
  // been meant this turn — Gemini drafted its reply before this resolution
  // happened, so it may have named the wrong one (the "Mexican Sandwich vs
  // Mexican Pasta" bug class). correct-reply.ts substitutes any mention of
  // a rejected name with the chosen one.
  resolvedAmbiguities: { chosenName: string; rejectedNames: string[] }[];
  newlyQueued: { category: string; quantity: number; options: MenuItem[] }[];
  checkoutRejected: { action: CheckoutAction["type"]; reason: string } | null;
  checkoutApplied: CheckoutAction["type"] | null;
  cartBefore: CartState;
  cartAfter: CartState;
}

function emptyFacts(cart: CartState): TurnFacts {
  return {
    addedLines: [],
    removedNames: [],
    replacedNames: [],
    changedQuantity: [],
    clearedCart: false,
    unavailableQueries: [],
    clarificationRejected: null,
    clarificationStillAmbiguous: null,
    resolvedAmbiguities: [],
    newlyQueued: [],
    checkoutRejected: null,
    checkoutApplied: null,
    cartBefore: cart,
    cartAfter: cart,
  };
}

function isInCart(cart: CartState, itemId: string): boolean {
  return cart.items.some((line) => line.itemId === itemId);
}

function cartDiffLines(before: CartState, after: CartState): CartLineFact[] {
  const beforeQty = new Map(before.items.map((l) => [l.itemId, l.qty]));
  return after.items
    .map((l) => ({ name: l.name, price: l.price, quantity: l.qty - (beforeQty.get(l.itemId) ?? 0) }))
    .filter((l) => l.quantity > 0);
}

// Builds the minimal, structurally-valid ParseResult buildActionPlan()
// actually reads (items/category) — every other field is present only
// because the type requires it.
function fakeAddParseResult(items: ParseResult["items"], category: string | undefined): ParseResult {
  return {
    intent: items.length > 1 ? "ADD_MULTIPLE_ITEMS" : "ADD_ITEM",
    confidence: 1,
    items,
    actions: [],
    category,
    needsClarification: false,
    safetyDecision: "SAFE_TO_EXECUTE",
    rawUserMessage: "",
    normalizedMessage: "",
  };
}

function categoryKeyForCandidates(candidateItemIds: string[] | undefined, menu: Menu): string | undefined {
  if (!candidateItemIds || candidateItemIds.length === 0) return undefined;
  const keys = new Set(candidateItemIds.map((id) => findCategoryForItemId(menu, id)?.key).filter((k): k is string => Boolean(k)));
  return keys.size === 1 ? [...keys][0] : undefined;
}

// A single item mention while a clarification is pending is almost always
// the customer answering it — resolved STRICTLY against pending.options
// (never the whole menu, never any other category), mirroring the fixed
// v2/order-state-engine/clarification.ts#resolveClarificationReply logic.
function resolveAgainstPending(
  context: OrderContext,
  pending: PendingClarificationContext,
  mention: ItemMention,
  menu: Menu
): { context: OrderContext; facts: Partial<TurnFacts> } | null {
  const scoped = resolveItemQueryAmongItems(mention.query, pending.options);
  const queue = getClarificationQueue(context);
  const remaining = queue.slice(1);

  if (scoped.length === 0) {
    return {
      context,
      facts: { clarificationRejected: { category: pending.category, options: pending.options } },
    };
  }
  if (scoped.length > 1) {
    return { context, facts: { clarificationStillAmbiguous: { category: pending.category } } };
  }

  const chosenId = scoped[0];
  const chosen = findMenuItem(menu, chosenId);
  const quantity = mention.quantity ?? pending.quantity;
  const result = addItem(context.cart, chosenId, menu, quantity);
  if (!result.ok) return { context, facts: {} };

  const nextState = remaining.length > 0 ? "AWAITING_CLARIFICATION" : nextStateAfterCartMutation(context.state);
  const patched = touch(context, {
    state: nextState,
    cart: result.cart,
    ...withClarificationQueue(remaining),
    orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown,
  });

  // Gemini drafted its reply BEFORE this category-scoped resolution ran, so
  // it may have named any of the query's OTHER menu-wide candidates (e.g.
  // "mexican" also matches Mexican Sandwich/Mexican Pizza, not just the
  // Pasta sibling actually chosen) — not just the other options THIS
  // question happened to list. Compute rejects from the query's real
  // menu-wide resolution, never from the pending category's siblings.
  const vocabulary = buildMenuVocabulary(menu);
  const globalCandidates = resolveItemQuery(mention.query, menu, vocabulary);
  const rejectedIds = new Set([...globalCandidates, ...pending.options.map((o) => o.id)].filter((id) => id !== chosenId));
  const rejectedNames = [...rejectedIds].map((id) => findMenuItem(menu, id)?.name).filter((n): n is string => Boolean(n));
  return {
    context: patched,
    facts: {
      resolvedAmbiguities: chosen ? [{ chosenName: chosen.name, rejectedNames }] : [],
    },
  };
}

// Fresh add(s) — no pending clarification answers this, or more than one
// item was mentioned. Reuses V2's own Action Planner + Cart Engine
// verbatim: every item is classified INDEPENDENTLY (exact -> add,
// ambiguous -> queue a clarification, unavailable -> reject) rather than
// one all-or-nothing verdict, and any NEW ambiguity is appended onto
// whatever clarification queue already exists.
function runFreshAdd(context: OrderContext, mentions: ItemMention[], menu: Menu): { context: OrderContext; facts: Partial<TurnFacts> } {
  const vocabulary = buildMenuVocabulary(menu);
  const items: ParseResult["items"] = mentions.map((m) => ({
    query: m.query,
    quantity: m.quantity ?? 1,
    candidateItemIds: resolveItemQuery(m.query, menu, vocabulary),
  }));
  const ambiguousItem = items.find((i) => (i.candidateItemIds?.length ?? 0) > 1);
  const category = ambiguousItem && (categoryKeyForCandidates(ambiguousItem.candidateItemIds, menu) ?? ambiguousItem.query);
  const parseResult = fakeAddParseResult(items, category);
  const plan = buildActionPlan(parseResult, menu);
  const { cart: nextCart } = executeActionPlan(plan, context.cart, menu);

  const addedLines: CartLineFact[] = plan.actions
    .filter((a) => a.type === "ADD_ITEM")
    .map((a) => {
      const item = findMenuItem(menu, a.itemId);
      return { name: item?.name ?? a.itemId, price: item?.price ?? 0, quantity: a.quantity };
    });
  const unavailableQueries = plan.actions.filter((a) => a.type === "REJECT_UNAVAILABLE").map((a) => a.query);
  const newlyQueuedActions = plan.actions.filter(isAskClarificationAction);

  const existingQueue = getClarificationQueue(context);
  const queue = [
    ...existingQueue,
    ...newlyQueuedActions.map((a) => pendingClarificationFromPlanAction(a, mentions.map((m) => m.query).join(", "))),
  ];

  const cartChanged = addedLines.length > 0;
  const nextState = queue.length > 0 ? "AWAITING_CLARIFICATION" : cartChanged ? nextStateAfterCartMutation(context.state) : context.state;

  const patched = touch(context, {
    state: nextState,
    cart: nextCart,
    ...withClarificationQueue(queue),
    orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown,
  });

  return {
    context: patched,
    facts: {
      addedLines,
      unavailableQueries,
      newlyQueued: newlyQueuedActions.map((a) => ({ category: a.category, quantity: a.quantity, options: a.options })),
    },
  };
}

function runAdd(context: OrderContext, mentions: ItemMention[], menu: Menu): { context: OrderContext; facts: Partial<TurnFacts> } {
  const queue = getClarificationQueue(context);
  if (queue.length > 0 && mentions.length === 1) {
    const result = resolveAgainstPending(context, queue[0], mentions[0], menu);
    if (result) return result;
  }
  return runFreshAdd(context, mentions, menu);
}

function applyCartAction(context: OrderContext, action: CartAction, menu: Menu): { context: OrderContext; facts: Partial<TurnFacts> } {
  switch (action.type) {
    case "add_item":
      return runAdd(context, [{ query: action.query, quantity: action.quantity }], menu);

    case "add_multiple_items":
      return runAdd(context, action.items, menu);

    case "remove_item": {
      const vocabulary = buildMenuVocabulary(menu);
      const candidateIds = resolveItemQuery(action.query, menu, vocabulary).filter((id) => isInCart(context.cart, id));
      if (candidateIds.length !== 1) return { context, facts: {} };
      const item = findMenuItem(menu, candidateIds[0]);
      const result = removeItem(context.cart, candidateIds[0]);
      if (!result.ok) return { context, facts: {} };
      const nextState = nextStateAfterCartMutation(context.state);
      const patched = touch(context, { state: nextState, cart: result.cart, orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown });
      return { context: patched, facts: { removedNames: [item?.name ?? action.query] } };
    }

    case "replace_item": {
      const vocabulary = buildMenuVocabulary(menu);
      const sourceIds = resolveItemQuery(action.fromQuery, menu, vocabulary).filter((id) => isInCart(context.cart, id));
      const targetIds = resolveItemQuery(action.toQuery, menu, vocabulary);
      if (sourceIds.length !== 1 || targetIds.length !== 1) return { context, facts: {} };
      const fromItem = findMenuItem(menu, sourceIds[0]);
      const toItem = findMenuItem(menu, targetIds[0]);
      const result = replaceItem(context.cart, sourceIds[0], targetIds[0], menu);
      if (!result.ok) return { context, facts: {} };
      const nextState = nextStateAfterCartMutation(context.state);
      const patched = touch(context, { state: nextState, cart: result.cart, orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown });
      return {
        context: patched,
        facts: { replacedNames: [{ fromName: fromItem?.name ?? action.fromQuery, toName: toItem?.name ?? action.toQuery }] },
      };
    }

    case "change_quantity": {
      const vocabulary = buildMenuVocabulary(menu);
      const candidateIds = resolveItemQuery(action.query, menu, vocabulary).filter((id) => isInCart(context.cart, id));
      if (candidateIds.length !== 1) return { context, facts: {} };
      const item = findMenuItem(menu, candidateIds[0]);
      const result = setQuantity(context.cart, candidateIds[0], action.quantity);
      if (!result.ok) return { context, facts: {} };
      const patched = touch(context, { cart: result.cart });
      return { context: patched, facts: { changedQuantity: [{ name: item?.name ?? action.query, quantity: action.quantity }] } };
    }

    case "clear_cart": {
      const result = clearCart(context.cart);
      const patched = touch(context, { state: "CART_EDITING", cart: result.cart, ...withClarificationQueue([]) });
      return { context: patched, facts: { clearedCart: true } };
    }
  }
}

function applyCheckoutAction(context: OrderContext, action: CheckoutAction): { context: OrderContext; facts: Partial<TurnFacts> } {
  switch (action.type) {
    case "start_checkout": {
      if (!canStartCheckout(context.state, context.cart)) {
        return { context, facts: { checkoutRejected: { action: action.type, reason: context.cart.items.length === 0 ? "empty_cart" : "wrong_state" } } };
      }
      return { context: touch(context, { state: "ORDER_REVIEW", orderReviewShown: true }), facts: { checkoutApplied: action.type } };
    }
    case "confirm_order": {
      if (context.state === "ORDER_REVIEW" && canConfirmOrder(context)) {
        return { context: touch(context, { state: "AWAITING_DELIVERY_PICKUP" }), facts: { checkoutApplied: action.type } };
      }
      if (context.state === "READY_TO_SUBMIT" && canSubmitOrder(context)) {
        return { context: touch(context, { state: "PENDING_VERIFICATION" }), facts: { checkoutApplied: action.type } };
      }
      return { context, facts: { checkoutRejected: { action: action.type, reason: "wrong_state" } } };
    }
    case "select_delivery": {
      if (!canSelectDeliveryPickup(context.state)) return { context, facts: { checkoutRejected: { action: action.type, reason: "wrong_state" } } };
      return { context: touch(context, { state: "AWAITING_ADDRESS", deliveryType: "delivery" }), facts: { checkoutApplied: action.type } };
    }
    case "select_pickup": {
      if (!canSelectDeliveryPickup(context.state)) return { context, facts: { checkoutRejected: { action: action.type, reason: "wrong_state" } } };
      return { context: touch(context, { state: "AWAITING_NAME", deliveryType: "pickup" }), facts: { checkoutApplied: action.type } };
    }
    case "save_address": {
      if (!canAcceptAddress(context) || !isValidAddressReply(action.address)) {
        return { context, facts: { checkoutRejected: { action: action.type, reason: "invalid" } } };
      }
      return { context: touch(context, { state: "AWAITING_NAME", address: action.address }), facts: { checkoutApplied: action.type } };
    }
    case "save_customer_name": {
      const name = extractCustomerName(action.name) ?? action.name;
      if (!canAcceptName(context) || !name) {
        return { context, facts: { checkoutRejected: { action: action.type, reason: "invalid" } } };
      }
      return { context: touch(context, { state: "READY_TO_SUBMIT", customerName: name }), facts: { checkoutApplied: action.type } };
    }
    case "escalate_to_human":
      return { context, facts: { checkoutApplied: action.type } };
  }
}

// Applies every cartAction (in order) then the checkoutAction, threading
// the updated context through so a compound plan (e.g. add then checkout)
// sees its own prior effects within the same turn.
export function applyAgentActions(
  context: OrderContext,
  cartActions: CartAction[],
  checkoutAction: CheckoutAction | null,
  menu: Menu,
  _restaurantConfig: RestaurantConfig
): { context: OrderContext; facts: TurnFacts } {
  const cartBefore = context.cart;
  let current = context;
  const facts = emptyFacts(cartBefore);

  for (const action of cartActions) {
    const { context: next, facts: partial } = applyCartAction(current, action, menu);
    current = next;
    // addedLines is recomputed from the real before/after cart diff below —
    // robust to multiple add/remove actions netting out in one turn.
    if (partial.removedNames) facts.removedNames.push(...partial.removedNames);
    if (partial.replacedNames) facts.replacedNames.push(...partial.replacedNames);
    if (partial.changedQuantity) facts.changedQuantity.push(...partial.changedQuantity);
    if (partial.clearedCart) facts.clearedCart = true;
    if (partial.unavailableQueries) facts.unavailableQueries.push(...partial.unavailableQueries);
    if (partial.clarificationRejected) facts.clarificationRejected = partial.clarificationRejected;
    if (partial.clarificationStillAmbiguous) facts.clarificationStillAmbiguous = partial.clarificationStillAmbiguous;
    if (partial.resolvedAmbiguities) facts.resolvedAmbiguities.push(...partial.resolvedAmbiguities);
    if (partial.newlyQueued) facts.newlyQueued.push(...partial.newlyQueued);
  }

  if (checkoutAction) {
    const { context: next, facts: partial } = applyCheckoutAction(current, checkoutAction);
    current = next;
    if (partial.checkoutApplied) facts.checkoutApplied = partial.checkoutApplied;
    if (partial.checkoutRejected) facts.checkoutRejected = partial.checkoutRejected;
  }

  facts.cartBefore = cartBefore;
  facts.cartAfter = current.cart;
  // Prefer the real cart diff over the action-planner's own bookkeeping —
  // robust regardless of how many items were requested vs actually landed.
  facts.addedLines = cartDiffLines(cartBefore, current.cart);

  return { context: current, facts };
}

export function realSubtotal(cart: CartState, menu: Menu): number {
  return calculateTotal(cart, menu).subtotal;
}
