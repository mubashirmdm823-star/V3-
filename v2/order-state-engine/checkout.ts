// Checkout-flow-specific helpers: the ORDER_REVIEW summary, and detecting
// the final "submit" trigger at READY_TO_SUBMIT.
//
// Known gap (see README): the intent parser has no dedicated SUBMIT_ORDER
// intent — "submit"/"final submit"/"yes submit"/"done" don't map to any
// IntentName today, so this is a narrow, explicitly-scoped keyword check
// used ONLY while OrderState === READY_TO_SUBMIT (i.e. only after the
// state machine already knows, from state alone, that the next message is
// a submit/no reply). It is not general intent classification.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import { calculateTotal, type CartTotals } from "../cart-engine/totals";

export interface OrderReviewSummary {
  items: CartState["items"];
  totals: CartTotals;
}

export function buildOrderReviewSummary(cart: CartState, menu: Menu): OrderReviewSummary {
  return { items: cart.items, totals: calculateTotal(cart, menu) };
}

const SUBMIT_TRIGGER_PHRASES = ["final submit", "yes submit", "submit", "done"];

export function isFinalSubmitTrigger(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return SUBMIT_TRIGGER_PHRASES.some((p) => normalized.includes(p));
}

export const PENDING_VERIFICATION_MESSAGE =
  "Order received successfully.\n\n" +
  "Status: Pending Verification.\n\n" +
  "Our team will call you shortly to confirm your order.";
