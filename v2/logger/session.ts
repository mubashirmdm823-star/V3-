// Per-session (per-conversation) analytics. Pure, immutable updates —
// matches the rest of this codebase's convention (context.ts#touch,
// cart-engine mutations, etc): recordMessageInSession never mutates the
// state passed in, it returns a new one.

import type { MessageLogEntry } from "./events";

export interface SessionAnalyticsState {
  sessionId: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  clarificationCount: number;
  successfulOrders: number;
  cancelledOrders: number;
  cartEditCount: number;

  // Internal running trackers used to compute the per-order averages below.
  currentOrderStartedAt?: string;
  currentOrderCartEdits: number;
  completedCheckoutDurationsMs: number[];
  itemsPerCompletedOrder: number[];
  cartEditsPerCompletedOrder: number[];
}

export function createSessionAnalyticsState(sessionId: string, startedAt: string): SessionAnalyticsState {
  return {
    sessionId,
    startedAt,
    lastMessageAt: startedAt,
    messageCount: 0,
    clarificationCount: 0,
    successfulOrders: 0,
    cancelledOrders: 0,
    cartEditCount: 0,
    currentOrderCartEdits: 0,
    completedCheckoutDurationsMs: [],
    itemsPerCompletedOrder: [],
    cartEditsPerCompletedOrder: [],
  };
}

function isCartEditEntry(entry: MessageLogEntry): boolean {
  return (
    entry.itemsAdded.length > 0 ||
    entry.itemsRemoved.length > 0 ||
    entry.itemsReplaced.length > 0 ||
    entry.quantityChanges.length > 0
  );
}

function cartItemCount(entry: MessageLogEntry): number {
  return entry.cartAfter.items.reduce((sum, line) => sum + line.qty, 0);
}

export function recordMessageInSession(
  state: SessionAnalyticsState,
  entry: MessageLogEntry
): SessionAnalyticsState {
  let next: SessionAnalyticsState = {
    ...state,
    lastMessageAt: entry.timestamp,
    messageCount: state.messageCount + 1,
    clarificationCount: state.clarificationCount + (entry.clarificationTriggered ? 1 : 0),
  };

  if (isCartEditEntry(entry)) {
    next = {
      ...next,
      cartEditCount: next.cartEditCount + 1,
      currentOrderCartEdits: next.currentOrderCartEdits + 1,
    };
  }

  if (entry.previousState !== "ORDER_REVIEW" && entry.nextState === "ORDER_REVIEW" && !next.currentOrderStartedAt) {
    next = { ...next, currentOrderStartedAt: entry.timestamp };
  }

  if (entry.nextState === "PENDING_VERIFICATION") {
    const durationMs = next.currentOrderStartedAt
      ? new Date(entry.timestamp).getTime() - new Date(next.currentOrderStartedAt).getTime()
      : 0;
    next = {
      ...next,
      successfulOrders: next.successfulOrders + 1,
      completedCheckoutDurationsMs: [...next.completedCheckoutDurationsMs, durationMs],
      itemsPerCompletedOrder: [...next.itemsPerCompletedOrder, cartItemCount(entry)],
      cartEditsPerCompletedOrder: [...next.cartEditsPerCompletedOrder, next.currentOrderCartEdits],
      currentOrderStartedAt: undefined,
      currentOrderCartEdits: 0,
    };
  }

  if (entry.nextState === "CANCELLED") {
    next = {
      ...next,
      cancelledOrders: next.cancelledOrders + 1,
      currentOrderStartedAt: undefined,
      currentOrderCartEdits: 0,
    };
  }

  return next;
}

export interface SessionAnalyticsSummary {
  sessionId: string;
  conversationLengthMs: number;
  messageCount: number;
  clarificationCount: number;
  successfulOrders: number;
  cancelledOrders: number;
  averageCartEditsPerMessage: number;
  averageCheckoutDurationMs: number;
  averageCartEditsPerOrder: number;
  averageItemsPerOrder: number;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function getSessionAnalytics(state: SessionAnalyticsState): SessionAnalyticsSummary {
  return {
    sessionId: state.sessionId,
    conversationLengthMs: new Date(state.lastMessageAt).getTime() - new Date(state.startedAt).getTime(),
    messageCount: state.messageCount,
    clarificationCount: state.clarificationCount,
    successfulOrders: state.successfulOrders,
    cancelledOrders: state.cancelledOrders,
    averageCartEditsPerMessage: state.messageCount > 0 ? state.cartEditCount / state.messageCount : 0,
    averageCheckoutDurationMs: average(state.completedCheckoutDurationsMs),
    averageCartEditsPerOrder: average(state.cartEditsPerCompletedOrder),
    averageItemsPerOrder: average(state.itemsPerCompletedOrder),
  };
}
