// V3 Phase 3B — Checkout Name/Address Hardening.
//
// See v3/agent/rules.ts's CHECKOUT_WORDS/CHECKOUT_RULES ("delivery requires
// address and name") — AWAITING_NAME/AWAITING_ADDRESS below are that rule's
// enforcement point.
//
// AWAITING_NAME and AWAITING_ADDRESS are the two steps where a wrong model
// decision is most damaging: confirm_order in either state must NEVER
// execute (the Phase 3 bug this session fixes — the model occasionally
// picked confirm_order for a bare name reply; the existing guards in
// actions.ts safely rejected the MUTATION, but nothing corrected the
// REPLY, so it could still claim success). This module makes the capture
// itself deterministic: while in one of these two states, the customer's
// raw text — not the model's chosen action type — decides what happens.
// escalate_to_human/cancel_order are the only model-chosen actions still
// respected as-is here, since those are legitimate at any point in the
// flow. Everything else the model might have picked (confirm_order,
// start_checkout, select_delivery, ...) is replaced.

import type { Menu } from "../../v2/types/menu";
import type { OrderContext, OrderState } from "../../v2/types/order";
import { touch } from "../../v2/order-state-engine/context";
import { isValidAddressReply, extractCustomerName } from "../../v2/order-state-engine/customer-info";
import { renderOrderItemsBlock } from "./fact-verifier";
import type { CheckoutAction } from "./schema";

// Mirrors v2/intent-parser/parser.ts's WAIT_SET (not imported directly —
// V3 doesn't otherwise depend on the intent parser, and this is a small,
// stable, documented word list) so "wait" behaves identically here as it
// does in V2's own state-global WAIT handling: acknowledge, change
// nothing, never treat it as a failed answer.
const WAIT_WORDS = new Set([
  "wait", "ruko", "ruk jao", "rukho", "ruk", "hold on", "one minute",
  "ek minute", "1 minute", "ek min", "1 min", "ek second", "1 second",
  "baad mein", "baad me", "later", "thora ruko", "thoda ruko",
]);

function isWaitMessage(rawMessage: string): boolean {
  return WAIT_WORDS.has(rawMessage.trim().toLowerCase());
}

// Production Stabilization Mode, checkout mutation lock (rule #4): once the
// customer has moved past ORDER_REVIEW into an actual checkout capture/
// submission step, a cart add/remove/replace/quantity-change action must
// not execute at all — the customer must explicitly cancel/edit-order
// first. Deliberately does NOT include ORDER_REVIEW itself (V2's own
// design intentionally still allows cart edits there, bouncing back to
// ORDER_REVIEW for re-confirmation — see nextStateAfterCartMutation) or any
// earlier state — only the states where delivery/address/name/submission
// are actually in progress or already done. Consulted by actions.ts#
// applyAgentActions before executing any cartAction.
const CART_LOCKED_STATES: ReadonlySet<OrderState> = new Set([
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
  "PENDING_VERIFICATION",
]);

export function isCartMutationLocked(state: OrderState): boolean {
  return CART_LOCKED_STATES.has(state);
}

export const CART_LOCKED_DURING_CHECKOUT_REPLY =
  "Aap checkout stage par hain. Order mein change karni hai to pehle checkout cancel karke cart editing par wapas jaana hoga.";

// A message that's actually asking to browse/change the order (not
// answering "what's your name/address") must never be swallowed into a
// bogus name/address capture just because it happens to be 2+ words —
// V2's own isValidAddressReply is deliberately loose on word-count alone.
const BROWSE_OR_MENU_WORDS = /\b(dikhao|dikha\s*do|batao|bata\s*do|menu|show|list|options?|kya\s*kya|order|cart|add|remove|hata|karo|kar\s*do)\b/i;

// V3-local hardening on top of V2's own extractCustomerName (word-shape
// only) — token-level, so a multi-word phrase like "confirm order" is
// rejected even though V2's shape check alone would accept a 2-word
// letters-only reply as a plausible name.
const NAME_REJECT_TOKENS = new Set([
  "help", "confirm", "order", "cancel", "checkout", "menu", "cart",
  "delivery", "pickup", "address", "wait", "ruko", "yes", "no", "ok",
  "okay", "hello", "hi", "hey",
]);

export function resolveNameCapture(rawMessage: string): string | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;
  const tokens = trimmed.toLowerCase().split(/\s+/);
  if (tokens.some((t) => NAME_REJECT_TOKENS.has(t))) return null;
  return extractCustomerName(rawMessage);
}

export function resolveAddressCapture(rawMessage: string): boolean {
  if (BROWSE_OR_MENU_WORDS.test(rawMessage)) return false;
  return isValidAddressReply(rawMessage);
}

// Checkout correction: the customer answered delivery/pickup one step ago
// and is now correcting THAT choice mid name/address capture ("sorry
// Delivery" while being asked for a name after picking pickup) — not
// answering the name/address question at all. Whitelisted to the exact
// correction phrasing (optionally prefixed with "sorry"/"actually"/"nahi"),
// same deliberately-narrow shape as WAIT_WORDS above, so an unrelated reply
// that merely contains "delivery"/"pickup" elsewhere in a longer sentence
// is never misread as a correction.
const FULFILLMENT_CORRECTION_PREFIX = /^(?:sorry|actually|nahi)\s+/i;

function isDeliveryCorrection(rawMessage: string): boolean {
  const stripped = rawMessage.trim().toLowerCase().replace(FULFILLMENT_CORRECTION_PREFIX, "");
  return stripped === "delivery" || stripped === "home delivery";
}

function isPickupCorrection(rawMessage: string): boolean {
  const stripped = rawMessage.trim().toLowerCase().replace(FULFILLMENT_CORRECTION_PREFIX, "");
  return stripped === "pickup" || stripped === "pick up";
}

export type CheckoutCaptureOutcome =
  // Not a capture state, or the model picked a globally-legitimate action
  // (escalate/cancel) — nothing here overrides it.
  | { kind: "pass_through" }
  | { kind: "save_name"; name: string }
  | { kind: "save_address"; address: string }
  | { kind: "wait" }
  | { kind: "invalid_name" }
  | { kind: "invalid_address" }
  // Customer is correcting the delivery/pickup choice made a step earlier —
  // see isDeliveryCorrection/isPickupCorrection above.
  | { kind: "switch_to_delivery" }
  | { kind: "switch_to_pickup" };

// The single decision point: given the state we were ALREADY in before
// this message, and the customer's raw text, what should actually happen —
// completely independent of whatever checkoutAction the model drafted
// (except the two explicitly-whitelisted global ones).
export function resolveCheckoutCapture(state: OrderState, rawMessage: string, modelAction: CheckoutAction | null): CheckoutCaptureOutcome {
  if (state !== "AWAITING_NAME" && state !== "AWAITING_ADDRESS") return { kind: "pass_through" };
  if (modelAction?.type === "escalate_to_human" || modelAction?.type === "cancel_order") return { kind: "pass_through" };
  if (isWaitMessage(rawMessage)) return { kind: "wait" };

  if (state === "AWAITING_NAME") {
    if (isDeliveryCorrection(rawMessage)) return { kind: "switch_to_delivery" };
    const name = resolveNameCapture(rawMessage);
    return name ? { kind: "save_name", name } : { kind: "invalid_name" };
  }

  if (isPickupCorrection(rawMessage)) return { kind: "switch_to_pickup" };
  return resolveAddressCapture(rawMessage) ? { kind: "save_address", address: rawMessage.trim() } : { kind: "invalid_address" };
}

// The concrete CheckoutAction to actually apply this turn — null means
// "apply nothing through the normal checkout dispatch" (wait/invalid, or a
// fulfillment-method switch, which applyFulfillmentCorrection below applies
// directly instead — canSelectDeliveryPickup only permits select_delivery/
// select_pickup from AWAITING_DELIVERY_PICKUP, not from mid name/address
// capture, so this correction is never a legitimate select_delivery/
// select_pickup CheckoutAction).
export function checkoutActionForCapture(capture: CheckoutCaptureOutcome, modelAction: CheckoutAction | null): CheckoutAction | null {
  switch (capture.kind) {
    case "pass_through":
      return modelAction;
    case "save_name":
      return { type: "save_customer_name", name: capture.name };
    case "save_address":
      return { type: "save_address", address: capture.address };
    case "wait":
    case "invalid_name":
    case "invalid_address":
    case "switch_to_delivery":
    case "switch_to_pickup":
      return null;
  }
}

// Applies a fulfillment-method correction directly to the OrderContext —
// bounces AWAITING_NAME (pickup) back to AWAITING_ADDRESS (delivery) or
// AWAITING_ADDRESS (delivery) back to AWAITING_NAME (pickup). Cart is never
// touched (these two states are already cart-mutation-locked — see
// isCartMutationLocked above), and this never restarts checkout: only
// deliveryType/state (and the now-irrelevant address, cleared when
// switching to pickup) change.
export function applyFulfillmentCorrection(context: OrderContext, capture: CheckoutCaptureOutcome): OrderContext {
  if (capture.kind === "switch_to_delivery") {
    return touch(context, { state: "AWAITING_ADDRESS", deliveryType: "delivery" });
  }
  if (capture.kind === "switch_to_pickup") {
    return touch(context, { state: "AWAITING_NAME", deliveryType: "pickup", address: undefined });
  }
  return context;
}

// Phase 3C, requirement #4: after the name is saved, the customer must see
// a FULL final review (items, delivery/pickup + address, name) — not just
// a short "naam save ho gaya" line — before the final "confirm" submits
// the order. `context` is the ALREADY-MUTATED OrderContext (post save_name),
// so cart/deliveryType/address here are the real, current values.
function renderFinalReview(name: string, context: OrderContext, menu: Menu): string {
  const deliveryLine = context.deliveryType === "delivery" ? `Delivery address: ${context.address}` : "Pickup se collect karenge";
  return [
    `Shukriya, ${name}! Yeh raha aapka final order:`,
    renderOrderItemsBlock(context.cart, menu),
    deliveryLine,
    `Naam: ${name}`,
    `Order confirm karne ke liye "confirm" likhein.`,
  ].join("\n\n");
}

// Deterministic, guaranteed-correct reply for every outcome this module
// decided — always wins over the model's draft (which may have been
// written for a completely different, now-discarded action), same
// "backend facts override the reply" posture as fact-verifier.ts.
// `applied` reflects what actually happened after applyAgentActions ran
// (canAcceptName/canAcceptAddress can still reject a well-formed name/
// address, e.g. no delivery type chosen yet) — never claims success from
// intent alone. `context`/`menu` are only read for the save_name final
// review (every other outcome needs no cart data).
export function buildCheckoutCaptureReply(capture: CheckoutCaptureOutcome, applied: boolean, context: OrderContext, menu: Menu): string | null {
  switch (capture.kind) {
    case "pass_through":
      return null;
    case "wait":
      return "Koi baat nahi, main intezar karta hoon. Jab ready hon tou bata dein.";
    case "invalid_name":
      return "Meherbani karke apna poora naam batayein taake order finalize ho sake.";
    case "invalid_address":
      return "Meherbani karke apna delivery address batayein (ghar number, gali, area, shehar).";
    case "save_name":
      return applied ? renderFinalReview(capture.name, context, menu) : "Naam save nahi ho saka — pehle delivery ya pickup select karein.";
    case "save_address":
      return applied ? "Shukriya! Aapka address save ho gaya hai. Ab meherbani karke apna naam batayein." : "Address save nahi ho saka, meherbani karke dobara koshish karein.";
    case "switch_to_delivery":
      return "Theek hai, delivery. Meherbani karke apna complete delivery address bhej dein.";
    case "switch_to_pickup":
      return "Theek hai, pickup. Meherbani karke apna naam batayein.";
  }
}
