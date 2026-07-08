// AI Gateway — the single entry point every AI-driven caller must use.
//
// V3 Agent -> AI Gateway -> Gemini -> (fail/429/timeout) -> Groq -> (fail)
// -> OpenRouter -> (fail) -> gateway returns ok:false, and the caller falls
// back to the deterministic V2 pipeline. Provider switching/cooldown/
// metrics all happen inside this folder — nothing outside it ever imports a
// provider adapter or calls a provider's HTTP API directly. Every provider
// normalizes to the exact same { ok, provider, text, latencyMs, tokens,
// fallbackChain } / { ok: false, provider: null, error, fallbackChain }
// shape, so the customer (and the caller) never knows which provider — or
// whether a provider at all — answered.

import type { GatewayCallOptions, GatewayRequest, GatewayResult, ProviderId, ProviderStatus } from "./types";
import { runFailover } from "./failover";
import { recordFallback } from "./metrics";
import { getApiKey, DEFAULT_PROVIDER_ORDER } from "./config";
import { getProviderStatus } from "./cooldown";
import { logger } from "../lib/logger";

export async function callAIGateway(request: GatewayRequest, options: GatewayCallOptions = {}): Promise<GatewayResult> {
  const outcome = await runFailover(request, options);

  // A "fallback" is any turn where the answer (or lack of one) didn't come
  // from the first-priority provider on the first try — covers both
  // "succeeded on Groq/OpenRouter after Gemini failed" and "everything
  // failed, caller must use the deterministic V2 fallback."
  if (outcome.fallbackChain.length > 0) recordFallback();

  if (outcome.ok) {
    logger.info(`[ai-gateway] result=success provider=${outcome.provider}`);
    return {
      ok: true,
      provider: outcome.provider,
      text: outcome.result.text,
      latencyMs: outcome.result.latencyMs,
      tokens: outcome.result.tokens,
      fallbackChain: outcome.fallbackChain,
    };
  }

  logger.warn(`[ai-gateway] result=all_failed fallback=v2`);
  return {
    ok: false,
    provider: null,
    error: "all_providers_failed",
    fallbackChain: outcome.fallbackChain,
  };
}

// Snapshot of every provider's current status — used by monitoring/debug
// surfaces, never by failover.ts itself (which checks isConfigured/cooldown
// directly, per-provider, at call time).
export function getGatewayStatus(env: Record<string, string | undefined> = process.env): Record<ProviderId, ProviderStatus> {
  const statuses = {} as Record<ProviderId, ProviderStatus>;
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    statuses[provider] = getProviderStatus(provider, Boolean(getApiKey(provider, env)));
  }
  return statuses;
}

export type {
  GatewayRequest,
  GatewayResult,
  GatewaySuccess,
  GatewayFailure,
  GatewayCallOptions,
  ProviderId,
  ProviderStatus,
  TokenUsage,
} from "./types";
export { getProviderOrder, DEFAULT_PROVIDER_ORDER } from "./config";
export { getMetrics, resetMetrics } from "./metrics";
export { getProviderStatus, resetAllCooldowns, isProviderInCooldown } from "./cooldown";
export { getApiKey } from "./config";
