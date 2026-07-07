// V2 phase 9 — append-only conversation turn history.
//
// Plain, immutable list operations only — pruning.ts decides what's worth
// keeping long-term; this file just appends and reads.

import type { ConversationTurn } from "./conversation";

// A hard ceiling independent of pruning, so a runaway conversation can never
// make the in-memory history grow without bound even if pruning is skipped.
export const MAX_HISTORY_LENGTH = 500;

export function appendTurn(history: ConversationTurn[], turn: ConversationTurn): ConversationTurn[] {
  const next = [...history, turn];
  return next.length > MAX_HISTORY_LENGTH ? next.slice(next.length - MAX_HISTORY_LENGTH) : next;
}

export function getRecentTurns(history: ConversationTurn[], count: number): ConversationTurn[] {
  if (count <= 0) return [];
  return history.slice(Math.max(0, history.length - count));
}

export function getTurnsByCategory(history: ConversationTurn[], category: string): ConversationTurn[] {
  const normalized = category.trim().toLowerCase();
  return history.filter((t) => t.category?.trim().toLowerCase() === normalized);
}

export function clearHistory(): ConversationTurn[] {
  return [];
}
