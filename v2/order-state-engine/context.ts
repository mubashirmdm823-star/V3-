// OrderContext factory + immutable update helper.

import type { CartState } from "../types/cart";
import type { OrderContext } from "../types/order";

export function createInitialContext(cart: CartState = { items: [] }, now: () => Date = () => new Date()): OrderContext {
  const timestamp = now().toISOString();
  return {
    state: "BROWSING",
    cart,
    orderReviewShown: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// Immutable patch — never mutates the context passed in, always bumps
// updatedAt. This is the only way order-state-engine code should produce a
// new OrderContext.
export function touch(
  context: OrderContext,
  patch: Partial<Omit<OrderContext, "createdAt">>,
  now: () => Date = () => new Date()
): OrderContext {
  return { ...context, ...patch, updatedAt: now().toISOString() };
}
