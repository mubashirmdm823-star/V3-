// AI Gateway — the interface every concrete provider adapter implements.
//
// Deliberately narrower than v2/llm's LLMProvider: a gateway provider is
// stateless per call (isConfigured/call both take env explicitly) so
// failover.ts can check configuration and invoke providers in a loop
// without constructing long-lived provider objects.

import type { GatewayRequest, ProviderCallResult, ProviderId } from "./types";

export interface GatewayProvider {
  readonly id: ProviderId;

  // True only when this provider has everything it needs (API key) to
  // attempt a real call. Never throws. A missing key must never crash the
  // gateway — the provider is simply skipped (status DISABLED).
  isConfigured(env: Record<string, string | undefined>): boolean;

  // Performs the actual request. Resolves with normalized text/latency/
  // tokens on success; throws GatewayHttpError/GatewayTimeoutError/
  // GatewayProviderError (errors.ts) on any failure. Never called unless
  // isConfigured(env) was already true.
  call(request: GatewayRequest, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<ProviderCallResult>;
}
