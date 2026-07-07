// V2 phase 10 — shared types for the LLM Integration Layer.
//
// This layer's only job is Natural Language Understanding: turning a raw
// customer message (plus already-built context) into the SAME structured
// shape the deterministic intent parser already produces confidence/items
// for. It never calculates totals, never touches the cart, never changes
// order state, never writes a customer-facing reply, and never invents
// menu items/prices/restaurant facts — those rules are enforced by
// json-validator.ts, not just documented here.

import type { IntentName } from "../types/parser";

// "gemini" and "google-ai" are deliberately distinct providers even though
// both currently talk to the same underlying Google AI Studio Gemini REST
// API — they have separate env-var identities (GEMINI_API_KEY vs
// GOOGLE_API_KEY) and separate LLM_PROVIDER selector values, per this
// phase's explicit requirement to add Google AI Studio as a first-class,
// independently-selectable provider without removing the existing one.
export type ProviderName = "openai" | "claude" | "gemini" | "google-ai" | "openrouter";

// A single structured NLU item — deliberately narrower than the
// deterministic parser's IntentItemRef (no candidateItemIds ambiguity
// list): the LLM is expected to name exactly one real menu item id per
// item, and json-validator.ts is what checks that id actually exists.
export interface LLMResponseItem {
  id: string;
  quantity: number;
}

export interface LLMReplaceDetail {
  fromId: string;
  toId: string;
}

// The exact JSON shape the model is instructed to return — see
// system-prompt.ts / json-schema.ts for the authoritative field list.
export interface LLMStructuredResponse {
  intent: IntentName;
  confidence: number;
  items: LLMResponseItem[];
  category?: string;
  replace?: LLMReplaceDetail;
  needsClarification?: boolean;
}

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompletionResult {
  raw: string;
  provider: ProviderName;
  model: string;
  latencyMs: number;
}

// Injectable so tests never perform a real network call — the same
// pattern as this codebase's `now: () => Date` injection points
// (order-state-engine/context.ts, response-builder/variation.ts, etc.).
export type FetchLike = typeof fetch;

export interface ProviderConfig {
  provider: ProviderName;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
