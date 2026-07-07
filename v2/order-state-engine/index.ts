// V2 phase 5 — order state engine.
//
// Decides what stage the customer is in and what should happen next. It
// never parses raw language itself (see customer-info.ts's header for the
// one narrow, deliberate exception) — it only consumes a structured
// ParseResult (v2/types/parser.ts) from the intent parser and CartState
// results produced by the cart engine (v2/cart-engine), which this module
// calls directly when a state permits editing.
//
// Pipeline: Intent Parser -> Safety Layer -> Cart Engine -> Updated Cart ->
// Order State Engine (this) -> Response Builder.

import type { Menu } from "../types/menu";
import type { OrderContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import { executeParseResult, executeActionPlan } from "../cart-engine";
import { buildActionPlan, isAskClarificationAction } from "../action-planner";
import { touch, createInitialContext } from "./context";
import {
  isCartEditIntent,
  isConversationalIntent,
  isFinalState,
  canEditCart,
  canStartCheckout,
  canConfirmOrder,
  canSelectDeliveryPickup,
  canAcceptAddress,
  canAcceptName,
  canSubmitOrder,
} from "./guards";
import { nextStateAfterCartMutation } from "./transitions";
import {
  buildPendingClarification,
  resolveClarificationReply,
  getClarificationQueue,
  withClarificationQueue,
  pendingClarificationFromPlanAction,
} from "./clarification";
import { isValidAddressReply, extractCustomerName } from "./customer-info";
import { isFinalSubmitTrigger } from "./checkout";

// A set of intents that clearly mean "the customer moved on to something
// else" while a clarification is pending — dropping the stale question
// rather than re-asking it forever. Deliberately excludes item-edit intents
// and UNKNOWN/ASK_CLARIFICATION, since those could still be an attempt to
// answer the pending question. Only SHOW_MENU still gets this treatment
// (see handleAwaitingClarification) — every other formerly-abandoning
// intent now PRESERVES the clarification queue instead (see the Customer
// Conversation Layer / Clarification Queue rework's README notes).
const ABANDON_CLARIFICATION_INTENTS = new Set(["SHOW_MENU"]);

function applyCartEdit(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (!canEditCart(context.state)) {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CART_EDIT_BLOCKED" });
  }

  const existingQueue = getClarificationQueue(context);

  // ADD_ITEM/ADD_MULTIPLE_ITEMS go through the Action Planner: every item is
  // classified INDEPENDENTLY (never aggregated into one worst-case verdict
  // for the whole message) — an exact item is added immediately even when
  // another item in the SAME message is ambiguous or unavailable, and every
  // ambiguous item is APPENDED to the clarification queue rather than
  // overwriting whatever's already pending.
  if (parseResult.intent === "ADD_ITEM" || parseResult.intent === "ADD_MULTIPLE_ITEMS") {
    const plan = buildActionPlan(parseResult, menu);
    const { cart: nextCart } = executeActionPlan(plan, context.cart, menu);
    const newlyQueued = plan.actions
      .filter(isAskClarificationAction)
      .map((a) => pendingClarificationFromPlanAction(a, parseResult.rawUserMessage));
    const queue = [...existingQueue, ...newlyQueued];
    const addedAnything = plan.actions.some((a) => a.type === "ADD_ITEM");

    if (queue.length > 0) {
      return touch(context, {
        state: "AWAITING_CLARIFICATION",
        cart: nextCart,
        ...withClarificationQueue(queue),
        lastIntent: parseResult.intent,
        lastAction: addedAnything ? "PARTIAL_ADD_AWAITING_CLARIFICATION" : "AWAITING_CLARIFICATION",
      });
    }

    if (!addedAnything) {
      // Nothing resolved and nothing to clarify (e.g. every item was
      // unavailable) — same messaging path as the historical REJECT_UNAVAILABLE case.
      return touch(context, { lastIntent: parseResult.intent, lastAction: "CART_EDIT_REJECTED" });
    }

    const nextState = nextStateAfterCartMutation(context.state);
    return touch(context, {
      state: nextState,
      cart: nextCart,
      orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown,
      lastIntent: parseResult.intent,
      lastAction: parseResult.intent,
    });
  }

  // Every other cart-edit intent (REMOVE_ITEM/REMOVE_ALL/REPLACE_ITEM/
  // CHANGE_QUANTITY) keeps its original all-or-nothing behavior — these
  // never carry the same "multiple independent items" ambiguity shape ADD
  // does, so the whole-result safetyDecision gate is still the right rule.
  if (parseResult.needsClarification && parseResult.safetyDecision === "ASK_CLARIFICATION") {
    const pending = buildPendingClarification(parseResult, menu);
    if (pending) {
      const queue = [...existingQueue, pending];
      return touch(context, {
        state: "AWAITING_CLARIFICATION",
        ...withClarificationQueue(queue),
        lastIntent: parseResult.intent,
        lastAction: "AWAITING_CLARIFICATION",
      });
    }
  }

  if (parseResult.safetyDecision !== "SAFE_TO_EXECUTE") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CART_EDIT_REJECTED" });
  }

  const cartResult = executeParseResult(parseResult, context.cart, menu);
  if (!cartResult.ok) {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CART_EDIT_FAILED" });
  }

  // Clearing the cart also clears the entire clarification queue (rule:
  // "never overwrite pending clarification... unless the user cancels or
  // clears the cart") — every other edit here preserves whatever's already
  // queued (rule: "preserve queue unless user cancels or clears cart").
  const queueAfter = parseResult.intent === "REMOVE_ALL" ? [] : existingQueue;
  const queuePatch = queueAfter.length > 0 || existingQueue.length > 0 ? withClarificationQueue(queueAfter) : {};
  const nextState =
    queueAfter.length > 0
      ? "AWAITING_CLARIFICATION"
      : context.state === "AWAITING_CLARIFICATION"
        ? "CART_EDITING"
        : nextStateAfterCartMutation(context.state);
  return touch(context, {
    state: nextState,
    cart: cartResult.cart,
    ...queuePatch,
    // Regenerated synchronously with the transition in this phase — there's
    // no response-builder round-trip yet to defer this until the updated
    // review is actually shown (see README known-limitations note).
    orderReviewShown: nextState === "ORDER_REVIEW" ? true : context.orderReviewShown,
    lastIntent: parseResult.intent,
    lastAction: parseResult.intent,
  });
}

function handleBrowsing(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }
  return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
}

function handleCartEditing(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }
  if (parseResult.intent === "CHECKOUT_START" && canStartCheckout(context.state, context.cart)) {
    return touch(context, { state: "ORDER_REVIEW", orderReviewShown: true, lastIntent: parseResult.intent, lastAction: "CHECKOUT_STARTED" });
  }
  return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
}

function handleAwaitingClarification(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  const queue = getClarificationQueue(context);
  if (queue.length === 0) {
    return touch(context, {
      state: "CART_EDITING",
      ...withClarificationQueue([]),
      lastIntent: parseResult.intent,
      lastAction: "NO_PENDING_CLARIFICATION",
    });
  }
  const pending = queue[0];

  // A bare "nahi"/"no" to a "which one?" question means "none of these" —
  // decline just the CURRENT question and advance to the next one in the
  // queue, if any (rule: "ask only the first question" / "resolve first,
  // then ask next" applies to declines exactly as it does to answers).
  if (parseResult.intent === "NO") {
    const remaining = queue.slice(1);
    return touch(context, {
      state: remaining.length > 0 ? "AWAITING_CLARIFICATION" : "CART_EDITING",
      ...withClarificationQueue(remaining),
      lastIntent: parseResult.intent,
      lastAction: "CLARIFICATION_DECLINED",
    });
  }

  // "menu dikhao" means the customer has moved on to browsing entirely —
  // the one case that still drops the WHOLE queue rather than preserving
  // it (checked before any attempt to read the message as an answer, since
  // it's clearly not one).
  if (ABANDON_CLARIFICATION_INTENTS.has(parseResult.intent)) {
    const withoutQueue = touch(context, {
      state: "CART_EDITING",
      ...withClarificationQueue([]),
      lastIntent: parseResult.intent,
    });
    return handleCartEditing(withoutQueue, parseResult, menu);
  }

  // Try to resolve the CURRENT (first) pending question with this reply.
  const outcome = resolveClarificationReply(pending, parseResult, menu);
  if (outcome.kind === "resolved") {
    const cartResult = executeParseResult(outcome.result, context.cart, menu);
    if (cartResult.ok) {
      const remaining = queue.slice(1);
      return touch(context, {
        state: remaining.length > 0 ? "AWAITING_CLARIFICATION" : "CART_EDITING",
        cart: cartResult.cart,
        ...withClarificationQueue(remaining),
        lastIntent: parseResult.intent,
        lastAction: "CLARIFICATION_RESOLVED",
      });
    }
  }

  // The reply named something real but outside the pending category
  // entirely (e.g. "club" while "which pasta?" is pending) — never add it
  // and never fall through to the "genuinely new add" branch below, which
  // would otherwise treat it as an unrelated edit. State/queue stay
  // untouched; the response builder shows the explicit "not available in
  // this category" message (rule 5).
  if (outcome.kind === "unavailable") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CLARIFICATION_UNAVAILABLE_IN_CATEGORY" });
  }

  // The reply matched 2+ options still within the pending category — ask
  // the same question again rather than guess (rule 4). Queue untouched.
  if (outcome.kind === "ambiguous_in_category") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CLARIFICATION_STILL_AMBIGUOUS" });
  }

  // Any other cart edit — a genuinely NEW add unrelated to the pending
  // question, or an edit to something already in the cart (REMOVE_ITEM/
  // REPLACE_ITEM/CHANGE_QUANTITY, or REMOVE_ALL clearing everything) —
  // executes normally through applyCartEdit, which preserves the existing
  // queue automatically (appending any new ambiguity onto the end) except
  // for REMOVE_ALL, which explicitly clears it (rule: "preserve queue
  // unless user cancels or clears cart").
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }

  // Everything else — checkout-flow intents (blocked while unresolved),
  // informational questions, conversational messages, and unresolved/
  // typo'd replies — leaves state and the ENTIRE queue untouched. The
  // response builder decides how to phrase the reply (an informational/
  // conversational answer, a "please resolve this first" nudge for
  // checkout-flow intents, or simply repeating the pending question).
  return touch(context, { lastIntent: parseResult.intent, lastAction: "CLARIFICATION_PRESERVED" });
}

function handleOrderReview(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }
  // A bare "haan"/"yes" while the review is on screen IS the confirmation —
  // that's what the review asked for.
  if ((parseResult.intent === "CONFIRM_ORDER" || parseResult.intent === "YES") && canConfirmOrder(context)) {
    return touch(context, { state: "AWAITING_DELIVERY_PICKUP", lastIntent: parseResult.intent, lastAction: "ORDER_CONFIRMED" });
  }
  // A bare "nahi"/"no" declines the confirmation without destroying
  // anything — the customer can keep editing.
  if (parseResult.intent === "NO") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "CONFIRMATION_DECLINED" });
  }
  return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
}

function handleAwaitingDeliveryPickup(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }
  if (parseResult.intent === "SELECT_DELIVERY" && canSelectDeliveryPickup(context.state)) {
    return touch(context, { state: "AWAITING_ADDRESS", deliveryType: "delivery", lastIntent: parseResult.intent, lastAction: "DELIVERY_SELECTED" });
  }
  if (parseResult.intent === "SELECT_PICKUP" && canSelectDeliveryPickup(context.state)) {
    return touch(context, { state: "AWAITING_NAME", deliveryType: "pickup", lastIntent: parseResult.intent, lastAction: "PICKUP_SELECTED" });
  }
  return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
}

function handleAwaitingAddress(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  // Customer changes their mind on delivery type mid-flow.
  if (parseResult.intent === "SELECT_PICKUP") {
    return touch(context, {
      state: "AWAITING_NAME",
      deliveryType: "pickup",
      address: undefined,
      lastIntent: parseResult.intent,
      lastAction: "SWITCHED_TO_PICKUP",
    });
  }

  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }

  // A conversational message ("manager se baat karni hai", "shukriya") is
  // never the customer's address — without this guard, any multi-word
  // support request sent at this stage was being STORED as the delivery
  // address (found by this layer's own tests).
  if (isConversationalIntent(parseResult.intent)) {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
  }

  if (canAcceptAddress(context) && isValidAddressReply(parseResult.rawUserMessage)) {
    return touch(context, {
      state: "AWAITING_NAME",
      address: parseResult.rawUserMessage.trim(),
      lastIntent: parseResult.intent,
      lastAction: "ADDRESS_ACCEPTED",
    });
  }

  return touch(context, { lastIntent: parseResult.intent, lastAction: "ADDRESS_REJECTED" });
}

function handleAwaitingName(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  // Customer changes their mind on delivery type mid-flow.
  if (parseResult.intent === "SELECT_DELIVERY") {
    return touch(context, {
      state: "AWAITING_ADDRESS",
      deliveryType: "delivery",
      address: undefined,
      lastIntent: parseResult.intent,
      lastAction: "SWITCHED_TO_DELIVERY",
    });
  }

  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }

  // A conversational message is never the customer's name — without this
  // guard, a bare "help" or "salam" sent at this stage would be stored as
  // the customer name ("Help", "Salam").
  if (isConversationalIntent(parseResult.intent)) {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
  }

  if (canAcceptName(context)) {
    const name = extractCustomerName(parseResult.rawUserMessage);
    if (name) {
      return touch(context, { state: "READY_TO_SUBMIT", customerName: name, lastIntent: parseResult.intent, lastAction: "NAME_ACCEPTED" });
    }
  }

  return touch(context, { lastIntent: parseResult.intent, lastAction: "NAME_REJECTED" });
}

function handleReadyToSubmit(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isCartEditIntent(parseResult.intent)) {
    return applyCartEdit(context, parseResult, menu);
  }
  // The final review asked for a submit — a bare "haan"/"yes" means submit,
  // exactly like the explicit submit trigger words.
  if (canSubmitOrder(context) && (isFinalSubmitTrigger(parseResult.rawUserMessage) || parseResult.intent === "YES")) {
    return touch(context, { state: "PENDING_VERIFICATION", lastIntent: parseResult.intent, lastAction: "ORDER_SUBMITTED" });
  }
  // A bare "nahi"/"no" declines the submit without destroying anything.
  if (parseResult.intent === "NO") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "SUBMIT_DECLINED" });
  }
  return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
}

export function processMessage(context: OrderContext, parseResult: ParseResult, menu: Menu): OrderContext {
  if (isFinalState(context.state)) {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "IGNORED_FINAL_STATE" });
  }

  // Conversation layer — state-global intents, handled before per-state
  // dispatch so they behave identically at every stage of the flow:
  //
  // CANCEL_ORDER ends the order (the long-documented missing trigger for
  // cancelOrder() below) — but only when there is actually something to
  // cancel; a bare "cancel" with no cart and no checkout in progress is a
  // polite no-op, never a CANCELLED dead-end.
  if (parseResult.intent === "CANCEL_ORDER") {
    const somethingToCancel = context.cart.items.length > 0 || context.state !== "BROWSING";
    if (somethingToCancel) {
      return touch(cancelOrder(context), { lastIntent: parseResult.intent });
    }
    return touch(context, { lastIntent: parseResult.intent, lastAction: "NOTHING_TO_CANCEL" });
  }

  // WAIT pauses safely: no transition, no cart change, nothing forgotten —
  // the next message resumes exactly where the customer left off.
  if (parseResult.intent === "WAIT") {
    return touch(context, { lastIntent: parseResult.intent, lastAction: "PAUSED" });
  }

  switch (context.state) {
    case "BROWSING":
      return handleBrowsing(context, parseResult, menu);
    case "CART_EDITING":
      return handleCartEditing(context, parseResult, menu);
    case "AWAITING_CLARIFICATION":
      return handleAwaitingClarification(context, parseResult, menu);
    case "ORDER_REVIEW":
      return handleOrderReview(context, parseResult, menu);
    case "AWAITING_DELIVERY_PICKUP":
      return handleAwaitingDeliveryPickup(context, parseResult, menu);
    case "AWAITING_ADDRESS":
      return handleAwaitingAddress(context, parseResult, menu);
    case "AWAITING_NAME":
      return handleAwaitingName(context, parseResult, menu);
    case "READY_TO_SUBMIT":
      return handleReadyToSubmit(context, parseResult, menu);
    default:
      return touch(context, { lastIntent: parseResult.intent, lastAction: "NO_OP" });
  }
}

// Explicit-only: no customer message currently triggers this automatically
// (the intent parser has no distinct CANCEL_ORDER intent yet — see README).
export function cancelOrder(context: OrderContext): OrderContext {
  if (isFinalState(context.state)) return context;
  return touch(context, { state: "CANCELLED", lastAction: "CANCELLED" });
}

export { createInitialContext, touch } from "./context";
export * from "./guards";
export { nextStateAfterCartMutation } from "./transitions";
export { buildPendingClarification, resolveClarificationReply } from "./clarification";
export { isValidAddressReply, extractCustomerName } from "./customer-info";
export { buildOrderReviewSummary, isFinalSubmitTrigger, PENDING_VERIFICATION_MESSAGE } from "./checkout";
export type { OrderReviewSummary } from "./checkout";
