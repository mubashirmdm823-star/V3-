// AI Gateway — metrics tracking.
//
// Process-wide (module-level) counters, one bucket per provider plus a
// global fallback counter. Purely observational — nothing here influences
// failover decisions (that's cooldown.ts); this module only records what
// already happened.

import type { FailureKind, ProviderId } from "./types";

export interface ProviderMetrics {
  calls: number;
  success: number;
  rateLimited: number;
  timeouts: number;
  failures: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
}

function emptyMetrics(): ProviderMetrics {
  return { calls: 0, success: 0, rateLimited: 0, timeouts: 0, failures: 0, totalLatencyMs: 0, averageLatencyMs: 0 };
}

const providerMetrics: Record<ProviderId, ProviderMetrics> = {
  gemini: emptyMetrics(),
  groq: emptyMetrics(),
  openrouter: emptyMetrics(),
};

// Incremented once per gateway call that had to move past at least one
// failed/cooled-down provider to reach its final outcome (success on a
// non-first provider, or total failure).
let fallbackCount = 0;

export function recordAttempt(provider: ProviderId): void {
  providerMetrics[provider].calls += 1;
}

export function recordSuccess(provider: ProviderId, latencyMs: number): void {
  const m = providerMetrics[provider];
  m.success += 1;
  m.totalLatencyMs += latencyMs;
  m.averageLatencyMs = m.totalLatencyMs / m.calls;
}

export function recordFailure(provider: ProviderId, kind: FailureKind, latencyMs: number): void {
  const m = providerMetrics[provider];
  m.totalLatencyMs += latencyMs;
  m.averageLatencyMs = m.totalLatencyMs / m.calls;
  if (kind === "rate_limited") m.rateLimited += 1;
  else if (kind === "timeout") m.timeouts += 1;
  else m.failures += 1;
}

export function recordFallback(): void {
  fallbackCount += 1;
}

export function getMetrics(): { providers: Record<ProviderId, ProviderMetrics>; fallbackCount: number } {
  return {
    providers: {
      gemini: { ...providerMetrics.gemini },
      groq: { ...providerMetrics.groq },
      openrouter: { ...providerMetrics.openrouter },
    },
    fallbackCount,
  };
}

// Test-only reset.
export function resetMetrics(): void {
  (Object.keys(providerMetrics) as ProviderId[]).forEach((provider) => {
    providerMetrics[provider] = emptyMetrics();
  });
  fallbackCount = 0;
}
