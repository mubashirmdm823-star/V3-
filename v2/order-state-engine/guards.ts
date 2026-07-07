// Permission checks the order state engine consults before acting. Every
// guard is a pure function of already-structured state — none of them touch
// raw customer text.

import type { CartState } from "../types/cart";
import type { OrderContext, OrderState } from "../types/order";
import type { IntentName } from "../types/parser";

export const CART_EDIT_INTENTS: ReadonlySet<IntentName> = new Set([
  "ADD_ITEM",
  "ADD_MULTIPLE_ITEMS",
  "REMOVE_ITEM",
  "REMOVE_ALL",
  "REPLACE_ITEM",
  "CHANGE_QUANTITY",
]);

export function isCartEditIntent(intent: IntentName): boolean {
  return CART_EDIT_INTENTS.has(intent);
}

// The V2 Customer Conversation Layer's intents. A message classified as one
// of these is never raw DATA — the address/name capture steps must skip it
// ("manager se baat karni hai" is a support request, not a delivery
// address; "help" is not the customer's name).
export const CONVERSATIONAL_INTENTS: ReadonlySet<IntentName> = new Set([
  "GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT",
  "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK",
  "IRRELEVANT_QUERY", "HELP", "GOODBYE",
]);

export function isConversationalIntent(intent: IntentName): boolean {
  return CONVERSATIONAL_INTENTS.has(intent);
}

export function isFinalState(state: OrderState): boolean {
  return state === "PENDING_VERIFICATION" || state === "CANCELLED";
}

// Cart edits are allowed everywhere except the two terminal states — see
// "Never further cart edits after PENDING_VERIFICATION" / CANCELLED is
// obviously terminal too.
export function canEditCart(state: OrderState): boolean {
  return !isFinalState(state);
}

export function hasCartItems(cart: CartState): boolean {
  return cart.items.length > 0;
}

export function hasPendingClarification(context: OrderContext): boolean {
  return Boolean(context.pendingClarification);
}

// Checkout can only be *started* from CART_EDITING (never skipped straight
// from BROWSING or re-triggered once already past it), and never with an
// empty cart.
export function canStartCheckout(state: OrderState, cart: CartState): boolean {
  return state === "CART_EDITING" && hasCartItems(cart);
}

// Confirming requires being in ORDER_REVIEW, with the (possibly updated)
// review actually presented, and a non-empty cart — guards against
// "confirm order" before checkout, and against confirming an emptied cart.
export function canConfirmOrder(context: OrderContext): boolean {
  return context.state === "ORDER_REVIEW" && context.orderReviewShown && hasCartItems(context.cart);
}

export function canSelectDeliveryPickup(state: OrderState): boolean {
  return state === "AWAITING_DELIVERY_PICKUP";
}

// Never accept an address before delivery has actually been selected.
export function canAcceptAddress(context: OrderContext): boolean {
  return context.state === "AWAITING_ADDRESS" && context.deliveryType === "delivery";
}

// Never accept a name before delivery/pickup is chosen, and never before an
// address if delivery was chosen.
export function canAcceptName(context: OrderContext): boolean {
  if (context.state !== "AWAITING_NAME") return false;
  if (context.deliveryType === "delivery") return Boolean(context.address);
  if (context.deliveryType === "pickup") return true;
  return false;
}

export function canSubmitOrder(context: OrderContext): boolean {
  return context.state === "READY_TO_SUBMIT" && Boolean(context.customerName);
}
