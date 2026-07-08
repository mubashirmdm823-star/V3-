// V2 phase 11 — LLM Router.
//
// Sits between the Prompt Builder and the rest of the LLM layer in this
// phase's required flow: Context Builder -> Prompt Builder -> LLM Router ->
// Selected Provider -> Validated JSON -> ParseResult Mapper. routeMessage()
// is the single function the orchestrator (v2/core/process-message.ts)
// calls to get a ParseResult — it never knows or cares whether that
// ParseResult came from an LLM or the deterministic parser.
//
// It builds its own lightweight AIContext directly from what the
// orchestrator already has (cart/state/pending clarification), rather than
// requiring a full, persisted MemorySession (v2/context-builder/session.ts)
// — wiring the orchestrator's own multi-turn memory into
// v2/context-builder's session/history machinery is out of this phase's
// scope (context-builder.ts isn't one of this phase's files to change).
// This still reuses context-builder's own relevant-menu/summary builders
// rather than duplicating that logic.

import type { CartState } from "../types/cart";
import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderState, PendingClarificationContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import {
  createInitialMemory,
  buildRelevantMenu,
  buildContextSummary,
  type AIContext,
  type ConversationMemory,
} from "../context-builder";
import { buildPrompt } from "./prompt-builder";
import { parseMessage } from "../intent-parser/parser";
import { safeLoadProviderConfigFromEnv, createProvider } from "./provider";
import { completeWithFallback } from "./fallback";
import type { LLMFailureReason } from "./fallback";
import { mapLLMResponseToParseResult } from "./parse-result-mapper";
import type { FetchLike } from "./types";
import type { LLMCache } from "./cache";

export interface RouteMessageParams {
  rawMessage: string;
  cart: CartState;
  state: OrderState;
  pendingClarification?: PendingClarificationContext;
  menu: Menu;
  restaurantConfig: RestaurantConfig;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  cache?: LLMCache;
}

export interface RouteMessageResult {
  parseResult: ParseResult;
  // "deterministic" covers every reason completeWithFallbackFromEnv falls
  // back (no config, invalid JSON, hallucinated item, low confidence,
  // timeout, provider error, ...) — from the router's own contract, all of
  // those are simply "the LLM path wasn't used this turn."
  source: "llm" | "deterministic";
  reason?: LLMFailureReason;
}

function buildLightweightAIContext(params: RouteMessageParams): AIContext {
  const baseMemory: ConversationMemory = createInitialMemory("router", "router", params.cart);
  const memory: ConversationMemory = {
    ...baseMemory,
    currentCart: params.cart,
    currentOrderState: params.state,
    currentCheckoutStage: params.state,
    ...(params.pendingClarification ? { pendingClarification: params.pendingClarification } : {}),
  };

  const menuContext = buildRelevantMenu(params.menu, params.rawMessage, {
    currentTopic: memory.currentTopic,
    lastMentionedCategory: memory.lastMentionedCategory,
  });

  const context: AIContext = {
    conversationId: "router",
    sessionId: "router",
    timestamp: new Date().toISOString(),
    customerMessage: params.rawMessage,
    memory,
    history: [],
    relevantMenu: { categories: menuContext.categories },
    menuContext,
    restaurantConfig: params.restaurantConfig,
    currentCart: params.cart,
    currentState: params.state,
    summary: buildContextSummary(memory),
  };
  if (params.pendingClarification) context.pendingClarification = params.pendingClarification;
  return context;
}

export async function routeMessage(params: RouteMessageParams): Promise<RouteMessageResult> {
  // Nothing configured -> skip straight to the deterministic parser without
  // ever building an AIContext/prompt at all. Building those is real work
  // (and, per this phase's design, touches restaurantConfig) that would
  // otherwise run on every single message even when there's no LLM to send
  // it to — the overwhelmingly common case in this repo today, where no
  // LLM_PROVIDER is configured anywhere.
  const config = safeLoadProviderConfigFromEnv(params.env ?? process.env);
  if (!config) {
    const parseResult = parseMessage(params.rawMessage, params.cart, params.menu);
    return { parseResult, source: "deterministic", reason: "missing_config" };
  }

  const aiContext = buildLightweightAIContext(params);
  const request = buildPrompt(aiContext);
  const provider = createProvider(params.fetchImpl ? { ...config, fetchImpl: params.fetchImpl } : config);

  const resolved = await completeWithFallback({
    provider,
    request,
    rawMessage: params.rawMessage,
    cart: params.cart,
    menu: params.menu,
    cache: params.cache,
  });

  if (resolved.source === "llm") {
    const parseResult = mapLLMResponseToParseResult(resolved.response, params.rawMessage, params.cart, params.menu);
    return { parseResult, source: "llm" };
  }

  return { parseResult: resolved.parseResult, source: "deterministic", reason: resolved.reason };
}
