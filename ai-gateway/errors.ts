// AI Gateway — typed failure reasons.
//
// Every provider adapter throws one of these instead of a bare Error, so
// failover.ts can decide the right cooldown (429 vs timeout vs 5xx) and
// metrics.ts can bucket the failure without string-matching error messages.
// Never includes request headers/body (which could carry the API key) —
// only the provider name and, where relevant, the HTTP status.

import type { ProviderId } from "./types";
import type { ProviderDiagnostics } from "./diagnostics";

export class GatewayTimeoutError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly timeoutMs: number,
    // Never includes a response body (a genuine timeout means no response
    // ever arrived) — model/baseUrl/timeoutMs only, already safe.
    public readonly diagnostics?: ProviderDiagnostics
  ) {
    super(`${provider} request timed out after ${timeoutMs}ms`);
    this.name = "GatewayTimeoutError";
  }
}

export class GatewayHttpError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly status: number,
    public readonly diagnostics?: ProviderDiagnostics,
    cause?: unknown
  ) {
    super(`${provider} request failed (HTTP ${status})`);
    this.name = "GatewayHttpError";
    this.cause = cause;
  }
}

// Anything else: malformed response body, missing text field, thrown
// non-HTTP error from fetch itself, etc.
export class GatewayProviderError extends Error {
  constructor(public readonly provider: ProviderId, cause?: unknown, public readonly diagnostics?: ProviderDiagnostics) {
    super(`${provider} request failed`);
    this.name = "GatewayProviderError";
    this.cause = cause;
  }
}

// Thrown by a provider adapter's call() only if callAIGateway() calls it
// despite isConfigured() reporting false — should never happen in practice
// (failover.ts always checks isConfigured() first) but keeps the adapter
// contract honest rather than silently sending a request with an empty key.
export class GatewayNotConfiguredError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`${provider} has no API key configured`);
    this.name = "GatewayNotConfiguredError";
  }
}
