// Internal-only mutation history — never shown to the customer. Every
// successful cart-engine mutation records what the cart looked like before
// and after, which action performed it, and when.

import type { CartState } from "../types/cart";
import type { CartActionName } from "../types/parser";

export interface CartHistoryEntry {
  before: CartState;
  after: CartState;
  action: CartActionName;
  timestamp: string; // ISO 8601
}

export function recordHistory(
  before: CartState,
  after: CartState,
  action: CartActionName,
  now: () => Date = () => new Date()
): CartHistoryEntry {
  return { before, after, action, timestamp: now().toISOString() };
}

// Immutable append — never mutates the log array passed in.
export function appendHistory(log: CartHistoryEntry[], entry: CartHistoryEntry): CartHistoryEntry[] {
  return [...log, entry];
}
