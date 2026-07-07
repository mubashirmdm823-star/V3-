// REMOVE_ALL / CLEAR_CART execution. Phrase recognition ("remove
// everything", "sab hata do", etc) already happened upstream in the intent
// parser — this is just the deterministic "empty the cart" operation.

import type { CartState } from "../types/cart";
import type { CartMutationResult } from "./add";

export function clearCart(cart: CartState): CartMutationResult {
  if (cart.items.length === 0) {
    return { ok: true, cart, reason: "Cart is already empty." };
  }
  return { ok: true, cart: { items: [] } };
}
