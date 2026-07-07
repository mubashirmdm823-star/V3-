// REPLACE_ITEM execution. Source must already be in the cart, target must
// exist on the menu. Replaces only the requested line, in place — every
// other line is left exactly as it was.

import type { CartState, CartLineItem } from "../types/cart";
import type { Menu } from "../types/menu";
import type { CartMutationResult } from "./add";
import { findMenuItem, validateCartItemExists } from "./validate";

export function replaceItem(
  cart: CartState,
  sourceItemId: string,
  targetItemId: string,
  menu: Menu
): CartMutationResult {
  if (!validateCartItemExists(cart, sourceItemId)) {
    return { ok: false, cart, reason: `"${sourceItemId}" is not in the current cart.` };
  }

  const targetMenuItem = findMenuItem(menu, targetItemId);
  if (!targetMenuItem) {
    return { ok: false, cart, reason: `"${targetItemId}" does not exist on the menu.` };
  }

  const sourceLine = cart.items.find((line) => line.itemId === sourceItemId)!;

  // If the target already has its own line elsewhere in the cart, merge
  // into it instead of creating a duplicate line for the same itemId.
  const targetHasOwnLine = cart.items.some(
    (line) => line.itemId === targetItemId && line.itemId !== sourceItemId
  );

  let items: CartLineItem[];
  if (targetHasOwnLine) {
    items = cart.items
      .filter((line) => line.itemId !== sourceItemId)
      .map((line) =>
        line.itemId === targetItemId ? { ...line, qty: line.qty + sourceLine.qty } : line
      );
  } else {
    // Replace in place so unrelated items keep their original order.
    items = cart.items.map((line) =>
      line.itemId === sourceItemId
        ? { itemId: targetItemId, name: targetMenuItem.name, price: targetMenuItem.price, qty: line.qty }
        : line
    );
  }

  return { ok: true, cart: { items } };
}
