// REMOVE_ITEM execution. Removes only the exact requested itemId — never
// touches any other line in the cart.

import type { CartState } from "../types/cart";
import type { CartMutationResult } from "./add";
import { validateCartItemExists } from "./validate";

export function removeItem(cart: CartState, itemId: string): CartMutationResult {
  if (!validateCartItemExists(cart, itemId)) {
    return { ok: false, cart, reason: `"${itemId}" is not in the current cart.` };
  }
  return { ok: true, cart: { items: cart.items.filter((line) => line.itemId !== itemId) } };
}
