// V2 phase 9 — Context Window Optimizer.
//
// Decides which prior turns are still worth including in context for the
// (future) LLM prompt. Never mutates cart/state — purely a filter over
// already-recorded ConversationTurn history.
//
// Kept unconditionally: the most recent turns (a fixed recency window),
// anything referencing the current topic, and anything from the still-open
// checkout (a cart-mutating or checkout-flow turn whose state hasn't since
// been finalized). Dropped: old finished orders (a turn whose stateAfter is
// PENDING_VERIFICATION/CANCELLED, once the conversation has moved past it),
// old menu-browsing/price/restaurant-info turns unrelated to the current
// topic, and greeting/thank-you small talk — all only once they fall
// outside the recency window, so nothing very recent is ever dropped.

import type { ConversationTurn } from "./conversation";
import { isGreetingOrThanksTurn, isLowSignalTurn, isCompletedCheckoutTurn } from "./conversation";

export const DEFAULT_RECENCY_WINDOW = 8;

export interface PruneOptions {
  recencyWindow?: number;
  currentTopic?: string;
}

function matchesCurrentTopic(turn: ConversationTurn, currentTopic?: string): boolean {
  if (!currentTopic) return false;
  return turn.category?.trim().toLowerCase() === currentTopic.trim().toLowerCase();
}

export function pruneHistory(history: ConversationTurn[], options: PruneOptions = {}): ConversationTurn[] {
  const recencyWindow = options.recencyWindow ?? DEFAULT_RECENCY_WINDOW;
  if (history.length <= recencyWindow) return history;

  const cutoffIndex = history.length - recencyWindow;
  const recent = history.slice(cutoffIndex);
  const older = history.slice(0, cutoffIndex);

  // Every turn up to and including the LAST terminal (finished/cancelled)
  // turn that's already outside the recency window belongs to a finished
  // order — the whole sequence (add/checkout/confirm/delivery/name/submit)
  // is prunable in bulk, not just whichever individual turn happens to
  // carry the terminal stateAfter itself. A still-open order (no terminal
  // turn yet, or one that's still within the recency window) is untouched.
  let lastTerminalIndex = -1;
  for (let i = older.length - 1; i >= 0; i--) {
    if (isCompletedCheckoutTurn(older[i])) {
      lastTerminalIndex = i;
      break;
    }
  }

  const keptOlder = older.filter((turn, index) => {
    if (matchesCurrentTopic(turn, options.currentTopic)) return true;
    if (lastTerminalIndex !== -1 && index <= lastTerminalIndex) return false;
    if (isGreetingOrThanksTurn(turn)) return false;
    if (isLowSignalTurn(turn)) return false;
    return true;
  });

  return [...keptOlder, ...recent];
}
