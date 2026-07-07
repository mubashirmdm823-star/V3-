// Validation primitives shared by every cart-engine operation. Nothing here
// interprets customer language — it only checks that an already-resolved
// itemId/quantity is structurally sound against the menu and current cart.

import type { CartState } from "../types/cart";
import type { Menu, MenuItem } from "../types/menu";

export type ValidationIssue =
  | "ITEM_NOT_FOUND"
  | "PRICE_NOT_FOUND"
  | "INVALID_QUANTITY"
  | "CART_ITEM_NOT_FOUND"
  | "DUPLICATE_ITEM_IDS";

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function findMenuItem(menu: Menu, itemId: string): MenuItem | undefined {
  for (const cat of menu.categories) {
    const found = cat.items.find((i) => i.id === itemId);
    if (found) return found;
  }
  return undefined;
}

export function isValidQuantity(qty: number): boolean {
  return Number.isInteger(qty) && qty > 0;
}

export function hasValidPrice(item: MenuItem): boolean {
  return typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0;
}

export function validateItemExists(menu: Menu, itemId: string): boolean {
  return findMenuItem(menu, itemId) !== undefined;
}

export function validateCartItemExists(cart: CartState, itemId: string): boolean {
  return cart.items.some((line) => line.itemId === itemId);
}

export function findDuplicateItemIds(cart: CartState): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const line of cart.items) {
    if (seen.has(line.itemId)) dupes.add(line.itemId);
    seen.add(line.itemId);
  }
  return Array.from(dupes);
}

// Full-cart audit: every line item resolves to a real, priced menu item,
// has a valid quantity, and no itemId appears on more than one line. Used
// both for the standalone VALIDATE_CART operation and defensively before
// any mutation the cart engine performs.
export function validateCart(cart: CartState, menu: Menu): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (findDuplicateItemIds(cart).length > 0) {
    issues.push("DUPLICATE_ITEM_IDS");
  }

  for (const line of cart.items) {
    const menuItem = findMenuItem(menu, line.itemId);
    if (!menuItem) {
      issues.push("ITEM_NOT_FOUND");
      continue;
    }
    if (!hasValidPrice(menuItem)) {
      issues.push("PRICE_NOT_FOUND");
    }
    if (!isValidQuantity(line.qty)) {
      issues.push("INVALID_QUANTITY");
    }
  }

  return { valid: issues.length === 0, issues };
}
