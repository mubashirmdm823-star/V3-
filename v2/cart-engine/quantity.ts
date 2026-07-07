// CHANGE_QUANTITY execution: set / increase / decrease. Zero and negative
// resulting quantities are always rejected — a customer who wants an item
// gone should get REMOVE_ITEM, not a silent decrease-to-zero.

import type { CartState } from "../types/cart";
import type { CartMutationResult } from "./add";
import { validateCartItemExists, isValidQuantity } from "./validate";

function applyQuantity(cart: CartState, itemId: string, newQty: number): CartMutationResult {
  if (!isValidQuantity(newQty)) {
    return { ok: false, cart, reason: `Invalid resulting quantity ${newQty} for "${itemId}".` };
  }
  return {
    ok: true,
    cart: { items: cart.items.map((line) => (line.itemId === itemId ? { ...line, qty: newQty } : line)) },
  };
}

export function setQuantity(cart: CartState, itemId: string, qty: number): CartMutationResult {
  if (!validateCartItemExists(cart, itemId)) {
    return { ok: false, cart, reason: `"${itemId}" is not in the current cart.` };
  }
  return applyQuantity(cart, itemId, qty);
}

export function increaseQuantity(cart: CartState, itemId: string, by: number = 1): CartMutationResult {
  if (!validateCartItemExists(cart, itemId)) {
    return { ok: false, cart, reason: `"${itemId}" is not in the current cart.` };
  }
  const line = cart.items.find((l) => l.itemId === itemId)!;
  return applyQuantity(cart, itemId, line.qty + by);
}

export function decreaseQuantity(cart: CartState, itemId: string, by: number = 1): CartMutationResult {
  if (!validateCartItemExists(cart, itemId)) {
    return { ok: false, cart, reason: `"${itemId}" is not in the current cart.` };
  }
  const line = cart.items.find((l) => l.itemId === itemId)!;
  const newQty = line.qty - by;
  if (newQty <= 0) {
    return {
      ok: false,
      cart,
      reason: `Decreasing "${itemId}" to ${newQty} is rejected — use REMOVE_ITEM to remove it instead.`,
    };
  }
  return applyQuantity(cart, itemId, newQty);
}
