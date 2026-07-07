// Pure state-transition rules. Given the current OrderState and a category
// of event (never raw text), what's the next OrderState.

import type { OrderState } from "../types/order";

// Every cart-mutating action has the same consequence on state regardless
// of WHICH mutation ran (add/remove/replace/quantity all behave the same
// way here): the first successful edit moves BROWSING -> CART_EDITING, and
// any edit happening later in the checkout flow (delivery/pickup, address,
// name) bounces back to ORDER_REVIEW so the customer re-confirms against
// the updated cart before anything is finalized. CART_EDITING/ORDER_REVIEW
// themselves are unaffected — an edit there just stays put.
export function nextStateAfterCartMutation(currentState: OrderState): OrderState {
  switch (currentState) {
    case "BROWSING":
      return "CART_EDITING";
    case "AWAITING_DELIVERY_PICKUP":
    case "AWAITING_ADDRESS":
    case "AWAITING_NAME":
    case "READY_TO_SUBMIT":
      return "ORDER_REVIEW";
    default:
      return currentState;
  }
}
