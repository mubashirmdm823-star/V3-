// V2 phase 9 — memory session persistence.
//
// Bundles a ConversationMemory with its turn history into one serializable
// unit, mirroring v2/core/context-manager.ts's save/restore/reset/clone
// pattern (that module persists the order-state-engine's OrderContext; this
// one persists the context-builder's own memory/history on top of it).
// Plain data + immutable updates throughout, so this is trivially JSON-safe.

import type { CartState } from "../types/cart";
import type { ConversationMemory } from "./memory";
import { createInitialMemory } from "./memory";
import type { ConversationTurn } from "./conversation";
import { isValidConversationMemory, isValidConversationTurn } from "./context-validator";
import { PipelineError } from "../core/errors";

export interface MemorySession {
  memory: ConversationMemory;
  history: ConversationTurn[];
}

export function createMemorySession(
  conversationId: string,
  sessionId: string,
  cart: CartState = { items: [] },
  now: () => Date = () => new Date()
): MemorySession {
  return { memory: createInitialMemory(conversationId, sessionId, cart, now), history: [] };
}

export function saveMemorySession(session: MemorySession): string {
  return JSON.stringify(session);
}

export function restoreMemorySession(serialized: string): MemorySession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new PipelineError("CONTEXT", "Stored memory session is not valid JSON.", error);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !isValidConversationMemory((parsed as Record<string, unknown>).memory) ||
    !Array.isArray((parsed as Record<string, unknown>).history) ||
    !((parsed as { history: unknown[] }).history.every(isValidConversationTurn))
  ) {
    throw new PipelineError("CONTEXT", "Stored memory session has an invalid shape.");
  }

  return parsed as MemorySession;
}

// Starts a brand-new memory/history over the same conversation/session
// identity — e.g. the customer beginning a new order after
// PENDING_VERIFICATION.
export function resetMemorySession(session: MemorySession, now: () => Date = () => new Date()): MemorySession {
  return createMemorySession(session.memory.conversationId, session.memory.sessionId, { items: [] }, now);
}

export function cloneMemorySession(session: MemorySession): MemorySession {
  return JSON.parse(JSON.stringify(session)) as MemorySession;
}
