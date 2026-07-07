// V2 phase 13 — the one shared interface both engines implement.
//
// This is the ONLY contract the UI (WhatsAppSimulator.tsx) and the API
// route (app/api/chat/route.ts) are allowed to depend on. Neither engine's
// own native types (V1's Phase/Draft/CartAction, V2's OrderContext/
// ParseResult) ever cross this boundary — `context` is deliberately opaque
// (`unknown`) precisely so a caller can thread it from one turn to the
// next without ever needing to know which engine produced it.

export type AIEngineName = "v1" | "v2" | "v3";

// A uniform cart line item both engines map their own cart shape into.
// `itemId` is optional because V1 has no stable item ids — it only ever
// identifies items by name.
export interface EngineCartItem {
  name: string;
  price: number;
  qty: number;
  itemId?: string;
}

export interface EngineDebugInfo {
  activeEngine: AIEngineName;
  // Only ever set by the V2 engine (mirrors ProcessMessageResult.parserSource
  // from v2/core/result.ts) — absent for V1, which has no LLM/parser split.
  parserSource?: "llm" | "deterministic";
  pipelineTiming?: unknown;
  // True only when the engine router had to fall back to a different
  // engine than the one requested (see lib/engine/index.ts's safe-rollback
  // rule) — never true for an ordinary successful call.
  fallbackUsed: boolean;
  // The engine's own native state string (V1: Phase, V2: OrderState),
  // exposed for debugging only — never used by any UI branching logic.
  rawState?: string;
}

export interface EngineRequest {
  message: string;
  // Opaque — whatever the previous EngineResponse.context was, or
  // undefined/empty to start a new conversation.
  context?: unknown;
  debug?: boolean;
}

export interface EngineResponse {
  reply: string;
  context: unknown;
  cart: EngineCartItem[];
  state: string;
  // Normalized "is this conversation over" signal — the one thing any
  // generic caller (the UI) actually needs to branch on, without having to
  // know either engine's own state vocabulary.
  isFinished: boolean;
  debug?: EngineDebugInfo;
}

export interface AIEngine {
  readonly name: AIEngineName;
  processMessage(request: EngineRequest): Promise<EngineResponse>;
}
