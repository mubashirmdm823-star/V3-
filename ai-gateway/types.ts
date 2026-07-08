// AI Gateway — shared types.
//
// One central gateway sits between every AI-driven caller (V3 today) and
// the actual providers, so nothing outside this folder ever imports a
// provider adapter or calls `fetch` for an LLM directly. Every provider
// normalizes to the same success/failure shape here — the caller never
// needs to know which provider actually answered.

export type ProviderId = "gemini" | "groq" | "openrouter";

export type ProviderStatus = "ONLINE" | "RATE_LIMITED" | "DOWN" | "COOLDOWN" | "DISABLED";

// The reason a single provider attempt failed — drives both the cooldown
// duration (cooldown.ts) and the metrics bucket (metrics.ts).
export type FailureKind = "rate_limited" | "timeout" | "server_error" | "error";

export interface GatewayRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

// Injectable environment/fetch, same pattern as v2/llm — every test in
// tests/ai-gateway/ai-gateway.test.ts injects a fake env + fetchImpl, never
// a real network call.
export interface GatewayCallOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface GatewaySuccess {
  ok: true;
  provider: ProviderId;
  text: string;
  latencyMs: number;
  tokens: TokenUsage;
  fallbackChain: string[];
}

export interface GatewayFailure {
  ok: false;
  provider: null;
  error: "all_providers_failed";
  fallbackChain: string[];
}

export type GatewayResult = GatewaySuccess | GatewayFailure;

// One provider's outcome inside failover.ts's loop — "attempted" entries
// (any provider whose isConfigured() was true) are what feed metrics and
// the fallbackChain; a DISABLED provider contributes neither.
export interface ProviderAttempt {
  provider: ProviderId;
  ok: boolean;
  latencyMs: number;
  failureKind?: FailureKind;
  httpStatus?: number;
}

export interface ProviderCallResult {
  text: string;
  latencyMs: number;
  tokens: TokenUsage;
}
