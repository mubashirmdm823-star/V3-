// CALCULATE_TOTAL execution. Totals are always recomputed from menu
// prices — CartLineItem.price is only a display cache and is never trusted
// here, since neither the parser nor the AI is allowed to set it.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import { findMenuItem } from "./validate";

export interface CartTotals {
  subtotal: number;
  itemCount: number; // sum of quantities across all lines
  lineCount: number; // number of distinct line items
}

export function calculateTotal(cart: CartState, menu: Menu): CartTotals {
  let subtotal = 0;
  let itemCount = 0;

  for (const line of cart.items) {
    const menuItem = findMenuItem(menu, line.itemId);
    const price = menuItem ? menuItem.price : 0;
    subtotal += price * line.qty;
    itemCount += line.qty;
  }

  return { subtotal, itemCount, lineCount: cart.items.length };
}
