// V3 one-call agent — session/context shape shared by prompt.ts and
// index.ts. AgentSession wraps a real v2/core/context-manager
// ConversationContext (so the agent's cart/state/clarification-queue IS
// the same tested V2 shape) plus a short conversation history for natural
// multi-turn tone. Nothing here calls an LLM or mutates state.

import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import { createConversationContext, type ConversationContext } from "../../v2/core/context-manager";
import { createEmptyMemory, type ConversationMemory } from "./conversation-memory";

export interface AgentTurn {
  role: "customer" | "agent";
  text: string;
}

export const MAX_HISTORY_TURNS = 12;

export interface AgentSession {
  conversation: ConversationContext;
  history: AgentTurn[];
  // Phase 2 — everything V3 remembers beyond OrderContext itself (topic,
  // last-mentioned item/category, preferences, the V3-only removal-
  // clarification lock). See conversation-memory.ts.
  memory: ConversationMemory;
}

export function appendTurn(session: AgentSession, turn: AgentTurn): AgentSession {
  const history = [...session.history, turn].slice(-MAX_HISTORY_TURNS);
  return { ...session, history };
}

export function createAgentSession(conversationId: string, sessionId: string): AgentSession {
  return { conversation: createConversationContext(conversationId, sessionId), history: [], memory: createEmptyMemory() };
}

export interface AgentContext {
  session: AgentSession;
  menu: Menu;
  restaurantConfig: RestaurantConfig;
  customerMessage: string;
}

export function renderHistory(history: AgentTurn[]): string {
  if (history.length === 0) return "(This is the first message.)";
  return history.map((t) => `${t.role === "customer" ? "Customer" : "You"}: ${t.text}`).join("\n");
}
