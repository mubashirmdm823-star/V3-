// ADD_ITEM / ADD_MULTIPLE_ITEMS execution. Exact menu ids only — no string
// matching, no parser logic, no intent detection. Whatever calls this must
// have already resolved a query to a single real MenuItem id.

import type { CartState, CartLineItem } from "../types/cart";
import type { Menu } from "../types/menu";
import { findMenuItem, isValidQuantity } from "./validate";

export interface CartMutationResult {
  ok: boolean;
  cart: CartState;
  reason?: string;
}

// qty defaults to 1 when omitted, per the Add Rules.
export function addItem(cart: CartState, itemId: string, menu: Menu, qty: number = 1): CartMutationResult {
  if (!isValidQuantity(qty)) {
    return { ok: false, cart, reason: `Invalid quantity ${qty} for "${itemId}".` };
  }

  const menuItem = findMenuItem(menu, itemId);
  if (!menuItem) {
    return { ok: false, cart, reason: `"${itemId}" does not exist on the menu.` };
  }

  const existing = cart.items.find((line) => line.itemId === itemId);
  let items: CartLineItem[];
  if (existing) {
    // Duplicate prevention: merge into the existing line instead of adding a
    // second line for the same itemId.
    items = cart.items.map((line) =>
      line.itemId === itemId ? { ...line, qty: line.qty + qty } : line
    );
  } else {
    items = [...cart.items, { itemId, name: menuItem.name, price: menuItem.price, qty }];
  }

  return { ok: true, cart: { items } };
}

export interface AddEntry {
  itemId: string;
  qty?: number;
}

// All-or-nothing: if any entry fails validation, the ORIGINAL cart is
// returned unchanged rather than a partially-applied one.
export function addMultipleItems(cart: CartState, entries: AddEntry[], menu: Menu): CartMutationResult {
  let current = cart;
  for (const entry of entries) {
    const result = addItem(current, entry.itemId, menu, entry.qty ?? 1);
    if (!result.ok) {
      return { ok: false, cart, reason: result.reason };
    }
    current = result.cart;
  }
  return { ok: true, cart: current };
}
