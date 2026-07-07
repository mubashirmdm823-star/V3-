// Reusable order summary block: items, quantity, line totals, grand total.
// No duplicated items (CartState never holds two lines for the same item —
// the cart engine's own duplicate prevention guarantees that), no extra
// blank lines.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import { calculateTotal } from "../cart-engine/totals";
import { formatCurrency, bulletList, joinParagraphs } from "./formatter";

export const EMPTY_CART_MESSAGE = "Aapki cart is waqt khaali hai.";

export function buildOrderSummary(cart: CartState, menu: Menu, heading = "Current Order"): string {
  if (cart.items.length === 0) return EMPTY_CART_MESSAGE;

  const lines = cart.items.map(
    (line) => `${line.name} ×${line.qty} — ${formatCurrency(line.price * line.qty)}`
  );
  const totals = calculateTotal(cart, menu);

  return joinParagraphs(`${heading}\n${bulletList(lines)}`, `Total: ${formatCurrency(totals.subtotal)}`);
}
