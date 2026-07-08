// AI Gateway — failover orchestration.
//
// Walks the configured provider order (config.ts#getProviderOrder), skipping
// any provider that's DISABLED (no key) or currently in cooldown, and
// returns on the first success. Every attempted provider updates its own
// cooldown (cooldown.ts) and metrics (metrics.ts) as it fails, so the next
// customer message already sees the updated state — this is the ONE place
// that decides provider switching; nothing above it (index.ts) or below it
// (the provider adapters) makes that decision.

import type { GatewayCallOptions, GatewayRequest, FailureKind, ProviderId, ProviderCallResult } from "./types";
import type { GatewayProvider } from "./provider-interface";
import { GatewayHttpError, GatewayTimeoutError, GatewayProviderError } from "./errors";
import type { ProviderDiagnostics } from "./diagnostics";
import { redactSecret } from "./diagnostics";
import { geminiProvider } from "./providers/gemini";
import { groqProvider } from "./providers/groq";
import { openrouterProvider } from "./providers/openrouter";
import { getProviderOrder, getApiKey } from "./config";
import { getProviderStatus, isProviderInCooldown, recordProviderFailure, recordProviderSuccess } from "./cooldown";
import { recordAttempt, recordFailure, recordSuccess, getMetrics } from "./metrics";
import { logger } from "../lib/logger";

const PROVIDERS: Record<ProviderId, GatewayProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
};

function classifyFailure(error: unknown): { kind: FailureKind; httpStatus?: number } {
  if (error instanceof GatewayTimeoutError) return { kind: "timeout" };
  if (error instanceof GatewayHttpError) {
    if (error.status === 429) return { kind: "rate_limited", httpStatus: error.status };
    if (error.status >= 500) return { kind: "server_error", httpStatus: error.status };
    return { kind: "error", httpStatus: error.status };
  }
  return { kind: "error" };
}

function chainLabel(provider: ProviderId, kind: FailureKind, httpStatus?: number): string {
  if (kind === "rate_limited") return `${provider}:429`;
  if (kind === "timeout") return `${provider}:timeout`;
  if (kind === "server_error") return `${provider}:${httpStatus ?? 500}`;
  return `${provider}:${httpStatus ?? "error"}`;
}

function diagnosticsOf(error: unknown): ProviderDiagnostics | undefined {
  if (error instanceof GatewayHttpError || error instanceof GatewayTimeoutError || error instanceof GatewayProviderError) {
    return error.diagnostics;
  }
  return undefined;
}

// The one full, safe diagnostic record printed for every provider failure
// (never for DISABLED/cooldown skips, which carry no request to diagnose).
// Every field the audit asked for, and nothing that could leak a secret:
// diagnostics.baseUrl arrives from the provider adapter ALREADY redacted
// (Gemini's key lives in the URL query string), and this function
// redacts the real configured key a second time, defensively, against the
// whole serialized record before it's ever printed.
function logProviderFailure(params: {
  providerId: ProviderId;
  env: Record<string, string | undefined>;
  isConfigured: boolean;
  cooldownBefore: string;
  cooldownAfter: string;
  httpStatus?: number;
  attemptCount: number;
  error: unknown;
}): void {
  const { providerId, env, isConfigured, cooldownBefore, cooldownAfter, httpStatus, attemptCount, error } = params;
  const diagnostics = diagnosticsOf(error);
  const record = {
    provider: providerId,
    model: diagnostics?.model ?? null,
    httpStatus: httpStatus ?? null,
    errorMessage: diagnostics?.bodySummary ?? (error instanceof Error ? error.message : String(error)),
    timeoutMs: diagnostics?.timeoutMs ?? null,
    attemptCount,
    cooldownBefore,
    cooldownAfter,
    apiKeyPresent: isConfigured,
    baseUrl: diagnostics?.baseUrl ?? null,
  };
  const apiKey = getApiKey(providerId, env);
  const serialized = redactSecret(JSON.stringify(record), apiKey);
  logger.debug(`[ai-gateway:diagnostic] ${serialized}`);
}

export interface FailoverSuccess {
  ok: true;
  provider: ProviderId;
  result: ProviderCallResult;
  fallbackChain: string[];
}

export interface FailoverFailure {
  ok: false;
  fallbackChain: string[];
}

export async function runFailover(request: GatewayRequest, options: GatewayCallOptions = {}): Promise<FailoverSuccess | FailoverFailure> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const order = getProviderOrder(env);
  const fallbackChain: string[] = [];

  logger.debug(`[ai-gateway] order=${order.join(",")}`);

  for (const providerId of order) {
    const provider = PROVIDERS[providerId];
    const isConfigured = provider.isConfigured(env);
    const status = getProviderStatus(providerId, isConfigured);
    logger.debug(`[ai-gateway] trying=${providerId} status=${status}`);

    if (!isConfigured) continue; // DISABLED — never counted as an attempt
    if (isProviderInCooldown(providerId)) {
      fallbackChain.push(`${providerId}:cooldown`);
      continue;
    }

    recordAttempt(providerId);
    const attemptStart = Date.now();
    try {
      const result = await provider.call(request, env, fetchImpl);
      recordProviderSuccess(providerId);
      recordSuccess(providerId, result.latencyMs);
      return { ok: true, provider: providerId, result, fallbackChain };
    } catch (error) {
      const { kind, httpStatus } = classifyFailure(error);
      const latencyMs = Date.now() - attemptStart;
      const cooldownBefore = status;
      recordProviderFailure(providerId, kind);
      recordFailure(providerId, kind, latencyMs);
      const cooldownAfter = getProviderStatus(providerId, isConfigured);
      const label = chainLabel(providerId, kind, httpStatus);
      fallbackChain.push(label);
      logger.warn(`[ai-gateway] failed=${providerId} reason=${label.split(":")[1]}`);
      logProviderFailure({
        providerId,
        env,
        isConfigured,
        cooldownBefore,
        cooldownAfter,
        httpStatus,
        attemptCount: getMetrics().providers[providerId].calls,
        error,
      });
    }
  }

  return { ok: false, fallbackChain };
}
