// V3 one-call agent — validate & apply cartActions/checkoutAction.
//
// See v3/agent/rules.ts's CART_MUTATION_RULES — this file is that rule
// set's actual enforcement point (only explicit add/remove/replace/
// quantity messages mutate cart; acknowledgements and post-order
// acknowledgements cannot; committed mutations cannot replay).
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
import { cancelOrder } from "../../v2/order-state-engine";
import { findCategoryForItemId, buildMenuVocabulary, resolveItemQuery, resolveItemQueryAmongItems, significantTokens } from "../../v2/intent-parser/matching";
import { buildActionPlan, isAskClarificationAction } from "../../v2/action-planner";
import { executeActionPlan } from "../../v2/cart-engine/action-plan";
import { removeItem, replaceItem, setQuantity, clearCart } from "../../v2/cart-engine";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { findMenuItem } from "../../v2/cart-engine/validate";
import type { CartAction, CheckoutAction, ItemMention } from "./schema";
import type { ConversationMemory, PendingRemovalContext } from "./conversation-memory";
import { isBareAcknowledgment } from "./conversation-memory";
import { resolveReference, resolveWithReferenceFallback, normalizeQueryText } from "./reference-resolver";
import { resolvePendingAdd, resolvePendingAddMulti, buildPendingRemoval, resolvePendingRemoval, isInCart } from "./clarification-engine";
import { isCartMutationLocked } from "./checkout-guard";

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
  clarificationStillAmbiguous: { category: string; options: MenuItem[] } | null;
  // The chosen item's name plus every OTHER candidate name that could have
  // been meant this turn — Gemini drafted its reply before this resolution
  // happened, so it may have named the wrong one (the "Mexican Sandwich vs
  // Mexican Pasta" bug class). correct-reply.ts substitutes any mention of
  // a rejected name with the chosen one.
  resolvedAmbiguities: { chosenName: string; rejectedNames: string[] }[];
  newlyQueued: { category: string; quantity: number; options: MenuItem[] }[];
  checkoutRejected: { action: CheckoutAction["type"]; reason: string } | null;
  checkoutApplied: CheckoutAction["type"] | null;
  // V3-only ambiguous-removal clarification (requirement #8) —
  // `undefined` means "unchanged this turn", `null` means "resolved/cleared
  // this turn", an object means "newly queued this turn". See
  // conversation-memory.ts#PendingRemovalContext.
  pendingRemoval?: PendingRemovalContext | null;
  cartBefore: CartState;
  cartAfter: CartState;
  // Production Stabilization Mode, checkout mutation lock: true when the
  // model drafted a cart-mutating action (add/remove/replace/quantity)
  // while context.state was AWAITING_DELIVERY_PICKUP/AWAITING_ADDRESS/
  // AWAITING_NAME/READY_TO_SUBMIT/PENDING_VERIFICATION — that action was
  // never executed (see checkout-guard.ts#isCartMutationLocked), and
  // correct-reply.ts replaces the reply with the deterministic "checkout
  // stage" message rather than trusting whatever the model drafted for an
  // action that never actually ran.
  cartMutationBlocked: boolean;
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
    cartMutationBlocked: false,
  };
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

// Production Stabilization Mode, ambiguous-item lock: root cause of the
// "Chowmein silently becomes Chicken Chowmein" bug. V2's own resolution
// primitives already return every candidate for a bare, genuinely
// ambiguous query ("chowmein" -> [chicken-chowmein, vegetable-chowmein]),
// and buildActionPlan already asks for 2+ candidates — but nothing
// verified that the MODEL'S OWN query text (which it is free to write
// however it wants, not necessarily the customer's literal words) was
// actually something the CUSTOMER said. When the model itself guesses a
// fully-specific variant name ("chicken chowmein") instead of passing the
// ambiguous word through, that guess resolves to exactly ONE candidate on
// its own merits, completely bypassing the 0/1/2+ ambiguity design — the
// backend never even sees the ambiguity. This is the backend-side guard
// for it: a single-candidate resolution is only trusted when the token(s)
// that actually distinguish it from its same-category "family" siblings
// (e.g. "chicken" vs "vegetable" — both share "chowmein") are themselves
// present in the customer's raw message; otherwise the resolution widens
// back to the full family so the customer is asked, exactly as if the
// model had passed the bare word through. Never applied to reference-
// phrase resolutions ("wo wala", "spicy wala", size-replace) — those are
// legitimately resolved from conversation memory, not the model guessing,
// and callers only reach this guard on the DIRECT match path (see below).
// Production Stabilization Mode fix: grounding was checked ONLY against the
// current turn's raw message — but a short confirmation ("g"/"haan") that
// answers an item the ASSISTANT ITSELF just named a turn earlier (e.g.
// "alfredo hota hai aapke pass" -> "Ji haan, Alfredo Pasta white sauce
// hai..." -> "g") never repeats that name in the customer's own words, so
// it was wrongly treated as an ungrounded guess and re-asked "kaunsa Pasta
// chahenge?" — discarding real conversational context. `memory.
// lastMentionedItemName` (set whenever a real add/replace/quantity-change
// already established this exact item — see conversation-memory.ts) is an
// equally legitimate grounding source: the customer doesn't need to
// re-state a name the conversation has already settled on.
function widenUngroundedFamilyGuess(itemId: string, customerMessage: string, menu: Menu, memory: ConversationMemory): string[] {
  const category = findCategoryForItemId(menu, itemId);
  const item = category?.items.find((i) => i.id === itemId);
  if (!category || !item) return [itemId];

  const itemTokens = significantTokens(item.name);
  const family = category.items.filter(
    (sibling) => sibling.id !== item.id && significantTokens(sibling.name).some((t) => itemTokens.includes(t))
  );
  if (family.length === 0) return [itemId];

  const sharedTokens = family.reduce(
    (shared, sibling) => shared.filter((t) => significantTokens(sibling.name).includes(t)),
    itemTokens
  );
  const distinguishing = itemTokens.filter((t) => !sharedTokens.includes(t));
  if (distinguishing.length === 0) return [itemId];

  const messageTokens = significantTokens(customerMessage);
  const groundedInMessage = distinguishing.some((t) =>
    messageTokens.some((mt) => mt === t || (t.length >= 3 && (mt.startsWith(t) || t.startsWith(mt))))
  );
  const groundedInMemory = memory.lastMentionedItemName?.toLowerCase() === item.name.toLowerCase();
  return groundedInMessage || groundedInMemory ? [itemId] : [itemId, ...family.map((f) => f.id)];
}

// Fresh add(s) — no pending clarification answers this, or more than one
// item was mentioned. Reuses V2's own Action Planner + Cart Engine
// verbatim: every item is classified INDEPENDENTLY (exact -> add,
// ambiguous -> queue a clarification, unavailable -> reject) rather than
// one all-or-nothing verdict, and any NEW ambiguity is appended onto
// whatever clarification queue already exists.
function runFreshAdd(
  context: OrderContext,
  mentions: ItemMention[],
  menu: Menu,
  memory: ConversationMemory,
  customerMessage: string
): { context: OrderContext; facts: Partial<TurnFacts> } {
  const vocabulary = buildMenuVocabulary(menu);
  const items: ParseResult["items"] = mentions.map((m) => {
    const normalized = normalizeQueryText(m.query);
    const direct = resolveItemQuery(normalized, menu, vocabulary);
    const candidateItemIds =
      direct.length === 1
        ? widenUngroundedFamilyGuess(direct[0], customerMessage, menu, memory)
        : direct.length > 0
          ? direct
          : resolveWithReferenceFallback(m.query, menu, vocabulary, memory);
    return { query: m.query, quantity: m.quantity ?? 1, candidateItemIds };
  });
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

function runAdd(
  context: OrderContext,
  mentions: ItemMention[],
  menu: Menu,
  memory: ConversationMemory,
  customerMessage: string
): { context: OrderContext; facts: Partial<TurnFacts> } {
  const queue = getClarificationQueue(context);
  if (queue.length > 0) {
    if (mentions.length === 1) {
      const result = resolvePendingAdd(context, queue[0], mentions[0], menu);
      if (result) return result;
    } else if (mentions.length > 1) {
      // Queue-lifecycle bug fix: a multi-item answer to a multi-question
      // queue (e.g. "do small ek mexican ek macaroni ek vegetable"
      // answering a pending pasta AND chowmein ambiguity together) used to
      // skip queue resolution entirely here (only the single-mention case
      // was ever attempted) and fall straight to runFreshAdd below —
      // leaving the ENTIRE original queue untouched even though the
      // customer had just answered it. See
      // clarification-engine.ts#resolvePendingAddMulti's header for the
      // full root-cause explanation.
      const result = resolvePendingAddMulti(context, queue, mentions, menu);
      if (result) return result;
    }
  }
  return runFreshAdd(context, mentions, menu, memory, customerMessage);
}

// "large kar do" / "medium kar do" / etc: regardless of which action shape
// the model chose (add_item/replace_item/change_quantity), if its query
// text is a recognized size-reference, normalize it into a proper
// replace_item BEFORE the switch below runs — one rule, applied once,
// rather than duplicating size-detection into every case.
function normalizeSizeReference(action: CartAction, memory: ConversationMemory, menu: Menu): CartAction {
  const query = action.type === "replace_item" ? action.toQuery : action.type === "add_item" ? action.query : action.type === "change_quantity" ? action.query : undefined;
  if (!query) return action;
  const ref = resolveReference(query, memory, menu);
  return ref.kind === "size_replace" ? { type: "replace_item", fromQuery: ref.fromName, toQuery: ref.toName } : action;
}

function applyCartAction(
  context: OrderContext,
  rawAction: CartAction,
  menu: Menu,
  memory: ConversationMemory,
  customerMessage: string
): { context: OrderContext; facts: Partial<TurnFacts> } {
  const action = normalizeSizeReference(rawAction, memory, menu);

  switch (action.type) {
    case "add_item":
      return runAdd(context, [{ query: action.query, quantity: action.quantity }], menu, memory, customerMessage);

    case "add_multiple_items":
      return runAdd(context, action.items, menu, memory, customerMessage);

    case "remove_item": {
      // V3-only ambiguous-removal lock (requirement #8): if a removal
      // question is already pending, this reply is checked STRICTLY
      // against those exact options first — never the whole cart/menu.
      if (memory.pendingRemoval) {
        const outcome = resolvePendingRemoval(memory.pendingRemoval, action.query);
        if ("itemId" in outcome) {
          const item = findMenuItem(menu, outcome.itemId);
          const result = removeItem(context.cart, outcome.itemId);
          if (result.ok) {
            const nextState = nextStateAfterCartMutation(context.state);
            const patched = touch(context, { state: nextState, cart: result.cart, orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown });
            return { context: patched, facts: { removedNames: [item?.name ?? action.query], pendingRemoval: null } };
          }
        }
        if ("ambiguous" in outcome) return { context, facts: {} };
        // "notFound" — not an answer to the pending removal question; fall
        // through and try resolving it as a brand-new request instead.
      }

      const vocabulary = buildMenuVocabulary(menu);
      const candidateIds = resolveWithReferenceFallback(action.query, menu, vocabulary, memory).filter((id) => isInCart(context.cart, id));
      if (candidateIds.length > 1) {
        // NEW (requirement #8): never silently no-op on an ambiguous
        // removal — lock a real, cart-scoped option set and ask.
        return { context, facts: { pendingRemoval: buildPendingRemoval(candidateIds, menu, action.query) } };
      }
      if (candidateIds.length !== 1) return { context, facts: {} };
      const item = findMenuItem(menu, candidateIds[0]);
      const result = removeItem(context.cart, candidateIds[0]);
      if (!result.ok) return { context, facts: {} };
      const nextState = nextStateAfterCartMutation(context.state);
      const patched = touch(context, { state: nextState, cart: result.cart, orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown });
      return { context: patched, facts: { removedNames: [item?.name ?? action.query], pendingRemoval: memory.pendingRemoval ? null : undefined } };
    }

    case "replace_item": {
      const vocabulary = buildMenuVocabulary(menu);
      const sourceIds = resolveWithReferenceFallback(action.fromQuery, menu, vocabulary, memory).filter((id) => isInCart(context.cart, id));
      const targetIds = resolveWithReferenceFallback(action.toQuery, menu, vocabulary, memory);
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
      const candidateIds = resolveWithReferenceFallback(action.query, menu, vocabulary, memory).filter((id) => isInCart(context.cart, id));
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
      return { context: patched, facts: { clearedCart: true, pendingRemoval: null } };
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

    case "cancel_order": {
      // Mirrors V2's own CANCEL_ORDER rule (v2/order-state-engine/index.ts):
      // a bare cancel with nothing going on is a polite no-op, never a
      // CANCELLED dead-end.
      const somethingToCancel = context.cart.items.length > 0 || context.state !== "BROWSING";
      if (!somethingToCancel) return { context, facts: { checkoutRejected: { action: action.type, reason: "nothing_to_cancel" } } };
      return { context: cancelOrder(context), facts: { checkoutApplied: action.type } };
    }
  }
}

// Production Stabilization Mode fix (queue-lifecycle, multi-variant answer
// class): root cause of "dono flavour 3 kardo" (both flavors, 3 each)
// re-asking "Aap kaunsa Noodles chahenge?" after already correctly adding
// both Chicken and Vegetable Chowmein. The model sometimes represents "add
// both variants" as TWO SEPARATE add_item actions (one per variant)
// instead of one add_multiple_items action — applyAgentActions used to
// apply each action to `applyCartAction` one at a time, so the FIRST
// action (e.g. "chicken chowmein") correctly resolved via
// resolvePendingAdd and cleared the pending chowmein queue entry, but the
// SECOND action (e.g. "vegetable chowmein") then ran against the
// ALREADY-EMPTY queue, falling through to runFreshAdd — where
// widenUngroundedFamilyGuess correctly-by-its-own-rule widened it back to
// the whole family (since the raw turn message "dono flavour 3 kardo"
// never literally says "vegetable"), producing a brand-new, spurious
// clarification. Combining every mention from a RUN of consecutive
// add-shaped actions into ONE resolvePendingAddMulti call (via runAdd)
// fixes this at the root: both mentions are resolved against the SAME
// pending queue entry together, exactly as they already would be had the
// model emitted one add_multiple_items action instead of two.
//
// Only combines when it's PROVABLY safe: every mention in the run must
// individually resolve against the CURRENT queue's own option sets first
// (a "dry run", never executed) — a run that mixes a genuine
// clarification-answer with an unrelated, already-unambiguous NEW item
// (e.g. "chicken chowmein" + "ek zinger burger" with only a chowmein
// clarification pending) is deliberately NOT combined, since
// resolvePendingAddMulti drops any mention that doesn't match the queue —
// combining that case would silently lose the zinger burger. That mixed
// case keeps using the original one-action-at-a-time path below, exactly
// as before this fix.
function addMentionsFromAction(action: CartAction): ItemMention[] | null {
  if (action.type === "add_item") return [{ query: action.query, quantity: action.quantity }];
  if (action.type === "add_multiple_items") return action.items;
  return null;
}

function allMentionsAnswerQueue(mentions: ItemMention[], queue: PendingClarificationContext[]): boolean {
  if (queue.length === 0) return false;
  return mentions.every((m) =>
    queue.some((entry) => resolveItemQueryAmongItems(normalizeQueryText(m.query), entry.options).length === 1)
  );
}

// Applies every cartAction (in order) then the checkoutAction, threading
// the updated context through so a compound plan (e.g. add then checkout)
// sees its own prior effects within the same turn.
//
// `customerMessage` is used for two things: rules 3/4's bare-acknowledgment
// guard (see conversation-memory.ts#isBareAcknowledgment) — "ok"/"thanks"/
// "theek hai"/etc. must NEVER mutate the cart or replay a prior mutation,
// even if the model drafts a cartAction for one; and the ambiguous-item
// grounding guard (see widenUngroundedFamilyGuess above), threaded down
// through runAdd/runFreshAdd. Checkout actions are untouched by the
// acknowledgment guard (checkout wording/flow is explicitly out of scope
// for that fix and already works correctly).
//
// Production Stabilization Mode, checkout mutation lock: while
// context.state is one of the 5 post-order-review checkout states
// (AWAITING_DELIVERY_PICKUP/AWAITING_ADDRESS/AWAITING_NAME/
// READY_TO_SUBMIT/PENDING_VERIFICATION — see checkout-guard.ts#
// isCartMutationLocked), a cart-mutating action must not execute at all,
// regardless of what the model drafted — the customer must explicitly
// cancel/edit-order first (existing cancel_order handling already returns
// to CART_EDITING). Checkout actions themselves are NOT gated by this —
// a legitimate delivery/pickup/address/name answer in the SAME turn a
// cart edit was also (wrongly) attempted must still go through normally.
export function applyAgentActions(
  context: OrderContext,
  cartActions: CartAction[],
  checkoutAction: CheckoutAction | null,
  menu: Menu,
  _restaurantConfig: RestaurantConfig,
  memory: ConversationMemory,
  customerMessage: string
): { context: OrderContext; facts: TurnFacts } {
  const cartBefore = context.cart;
  let current = context;
  const facts = emptyFacts(cartBefore);
  const effectiveCartActions = isBareAcknowledgment(customerMessage) ? [] : cartActions;
  const cartMutationBlocked = effectiveCartActions.length > 0 && isCartMutationLocked(current.state);
  facts.cartMutationBlocked = cartMutationBlocked;
  const actionsToApply = cartMutationBlocked ? [] : effectiveCartActions;

  for (let i = 0; i < actionsToApply.length; ) {
    const mentions = addMentionsFromAction(actionsToApply[i]);
    // Look ahead for a run of consecutive add-shaped actions and combine
    // them into ONE runAdd call ONLY when every mention in the run is
    // provably an answer to the queue as it stands right now — see
    // allMentionsAnswerQueue's header above for why this safety check
    // exists (never silently drops an unrelated new item).
    let group: ItemMention[] | null = null;
    let consumed = 1;
    if (mentions) {
      const combined = [...mentions];
      let j = i + 1;
      while (j < actionsToApply.length) {
        const nextMentions = addMentionsFromAction(actionsToApply[j]);
        if (!nextMentions) break;
        combined.push(...nextMentions);
        j++;
      }
      if (combined.length > 1 && allMentionsAnswerQueue(combined, getClarificationQueue(current))) {
        group = combined;
        consumed = j - i;
      }
    }

    const { context: next, facts: partial } = group
      ? runAdd(current, group, menu, memory, customerMessage)
      : applyCartAction(current, actionsToApply[i], menu, memory, customerMessage);
    current = next;
    i += consumed;
    // addedLines is recomputed from the real before/after cart diff below —
    // robust to multiple add/remove actions netting out in one turn.
    if (partial.removedNames) facts.removedNames.push(...partial.removedNames);
    if (partial.replacedNames) facts.replacedNames.push(...partial.replacedNames);
    if (partial.changedQuantity) facts.changedQuantity.push(...partial.changedQuantity);
    if (partial.clearedCart) facts.clearedCart = true;
    if (partial.unavailableQueries) facts.unavailableQueries.push(...partial.unavailableQueries);
    if (partial.pendingRemoval !== undefined) facts.pendingRemoval = partial.pendingRemoval;
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
