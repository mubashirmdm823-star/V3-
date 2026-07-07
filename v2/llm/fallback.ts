// V2 phase 10 — automatic fallback to the deterministic V2 intent parser.
//
// The customer must never notice a bad LLM response: a timeout, invalid
// JSON, a hallucinated menu item, an invalid schema, or low confidence all
// fall back to calling the already-shipped, fully-tested `parseMessage()`
// (v2/intent-parser/parser.ts) instead. This file does not decide cart/
// safety/state logic itself — falling back just means "use the
// deterministic parser's ParseResult instead of the LLM's", nothing more.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import type { ParseResult } from "../types/parser";
import { parseMessage } from "../intent-parser/parser";
import { LLMTimeoutError, createProvider, safeLoadProviderConfigFromEnv } from "./provider";
import { validateLLMResponse, type LLMValidationFailureReason } from "./json-validator";
import { LLMCache, buildCacheKey, isCacheableIntent } from "./cache";
import type { FetchLike, LLMCompletionRequest, LLMProvider, LLMStructuredResponse } from "./types";

export type LLMFailureReason = LLMValidationFailureReason | "timeout" | "provider_error" | "missing_config";

export type LLMCallOutcome =
  | { ok: true; response: LLMStructuredResponse; latencyMs: number }
  | { ok: false; reason: LLMFailureReason; details?: string };

export type ResolvedIntent =
  | { source: "llm"; response: LLMStructuredResponse }
  | { source: "fallback"; parseResult: ParseResult; reason: LLMFailureReason };

export function shouldFallback(outcome: LLMCallOutcome): boolean {
  return !outcome.ok;
}

export function resolveIntent(params: {
  rawMessage: string;
  cart: CartState;
  menu: Menu;
  outcome: LLMCallOutcome;
}): ResolvedIntent {
  if (params.outcome.ok) {
    return { source: "llm", response: params.outcome.response };
  }
  const parseResult = parseMessage(params.rawMessage, params.cart, params.menu);
  return { source: "fallback", parseResult, reason: params.outcome.reason };
}

export interface CompleteWithFallbackParams {
  provider: LLMProvider;
  request: LLMCompletionRequest;
  rawMessage: string;
  cart: CartState;
  menu: Menu;
  cache?: LLMCache;
}

// The single end-to-end entry point this phase provides: call the
// provider, validate its JSON, and resolve to either the validated LLM
// response or a deterministic fallback — never both, never neither.
export async function completeWithFallback(params: CompleteWithFallbackParams): Promise<ResolvedIntent> {
  const { provider, request, rawMessage, cart, menu, cache } = params;
  const cacheKey = buildCacheKey(rawMessage);

  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) return { source: "llm", response: cached };
  }

  let outcome: LLMCallOutcome;
  try {
    const result = await provider.complete(request);
    const validation = validateLLMResponse(result.raw, menu);
    outcome = validation.ok
      ? { ok: true, response: validation.response, latencyMs: result.latencyMs }
      : { ok: false, reason: validation.reason, details: validation.details };
    // TEMPORARY [llm-debug] — remove once the Google AI routing issue is solved.
    if (!validation.ok) {
      console.log(
        `[llm-debug] LLM responded but validation REJECTED it: reason=${validation.reason} details=${validation.details ?? "(none)"} rawPreview=${JSON.stringify(String(result.raw).slice(0, 120))}`
      );
    }
  } catch (error) {
    const reason: LLMFailureReason = error instanceof LLMTimeoutError ? "timeout" : "provider_error";
    outcome = { ok: false, reason, details: error instanceof Error ? error.message : String(error) };
    // TEMPORARY [llm-debug] — LLMProviderError's message only ever contains
    // provider name + HTTP status (never the key/body, by design).
    console.log(
      `[llm-debug] provider call THREW: reason=${reason} (timeout=${error instanceof LLMTimeoutError}) message=${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (outcome.ok && cache && isCacheableIntent(outcome.response.intent)) {
    cache.set(cacheKey, outcome.response);
  }

  return resolveIntent({ rawMessage, cart, menu, outcome });
}

export interface CompleteWithFallbackFromEnvParams {
  env?: Record<string, string | undefined>;
  request: LLMCompletionRequest;
  rawMessage: string;
  cart: CartState;
  menu: Menu;
  cache?: LLMCache;
  // Only ever used when a provider IS configured — lets tests inject a
  // fake fetch without a real network call; production code leaves this
  // undefined and each provider defaults to the real global `fetch`.
  fetchImpl?: FetchLike;
}

// The graceful-degradation entry point: if LLM_PROVIDER/its API key isn't
// configured at all, this never attempts a network call — it goes
// straight to the deterministic parser, the same as any other fallback
// reason. When a provider IS configured, this is exactly
// completeWithFallback() with the provider built from the environment.
export async function completeWithFallbackFromEnv(params: CompleteWithFallbackFromEnvParams): Promise<ResolvedIntent> {
  const config = safeLoadProviderConfigFromEnv(params.env ?? process.env);

  if (!config) {
    const parseResult = parseMessage(params.rawMessage, params.cart, params.menu);
    return { source: "fallback", parseResult, reason: "missing_config" };
  }

  const provider = createProvider(params.fetchImpl ? { ...config, fetchImpl: params.fetchImpl } : config);

  return completeWithFallback({
    provider,
    request: params.request,
    rawMessage: params.rawMessage,
    cart: params.cart,
    menu: params.menu,
    cache: params.cache,
  });
}
