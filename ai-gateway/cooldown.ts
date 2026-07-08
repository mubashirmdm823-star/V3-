// AI Gateway — per-provider cooldown tracking.
//
// Process-wide (module-level) state, same reasoning as v3/agent/cooldown.ts:
// one shared provider API key means one rate-limit hit affects every other
// customer's next request too. Each of the 3 providers gets its own
// independent cooldown clock so a Gemini 429 never blocks Groq/OpenRouter.

import type { FailureKind, ProviderId } from "./types";

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const TIMEOUT_COOLDOWN_MS = 30_000;
const SERVER_ERROR_COOLDOWN_MS = 30_000;

const cooldownUntilMs: Record<ProviderId, number> = {
  gemini: 0,
  groq: 0,
  openrouter: 0,
};

// The failure kind that put a provider in cooldown, kept only for
// getProviderStatus()'s ONLINE/RATE_LIMITED/DOWN reporting — cleared once
// the cooldown window actually expires.
const lastFailureKind: Record<ProviderId, FailureKind | undefined> = {
  gemini: undefined,
  groq: undefined,
  openrouter: undefined,
};

function cooldownMsFor(kind: FailureKind): number {
  switch (kind) {
    case "rate_limited":
      return RATE_LIMIT_COOLDOWN_MS;
    case "timeout":
      return TIMEOUT_COOLDOWN_MS;
    case "server_error":
      return SERVER_ERROR_COOLDOWN_MS;
    case "error":
      return 0; // a generic/4xx failure never blocks the next attempt
  }
}

export function recordProviderFailure(provider: ProviderId, kind: FailureKind, nowMs: number = Date.now()): void {
  lastFailureKind[provider] = kind;
  const durationMs = cooldownMsFor(kind);
  if (durationMs > 0) cooldownUntilMs[provider] = nowMs + durationMs;
}

export function recordProviderSuccess(provider: ProviderId): void {
  lastFailureKind[provider] = undefined;
  cooldownUntilMs[provider] = 0;
}

export function isProviderInCooldown(provider: ProviderId, nowMs: number = Date.now()): boolean {
  return nowMs < cooldownUntilMs[provider];
}

export function cooldownRemainingMs(provider: ProviderId, nowMs: number = Date.now()): number {
  return Math.max(0, cooldownUntilMs[provider] - nowMs);
}

// ONLINE/RATE_LIMITED/DOWN/COOLDOWN/DISABLED — DISABLED (no key) is decided
// by the caller (config.ts knows about env, this module doesn't), so it's
// passed in rather than re-derived here.
//
// RATE_LIMITED and COOLDOWN are both "actively cooling down" but for a
// different reason (429 vs timeout/5xx) — DOWN means the last attempt
// failed with a non-cooldown error (e.g. bad key/4xx) and hasn't succeeded
// since, even though no cooldown timer is blocking the next try.
export function getProviderStatus(provider: ProviderId, isConfigured: boolean, nowMs: number = Date.now()): import("./types").ProviderStatus {
  if (!isConfigured) return "DISABLED";
  if (isProviderInCooldown(provider, nowMs)) {
    return lastFailureKind[provider] === "rate_limited" ? "RATE_LIMITED" : "COOLDOWN";
  }
  if (lastFailureKind[provider] === "error") return "DOWN";
  return "ONLINE";
}

// Test-only reset — cooldown is module-level state, so tests that want a
// clean slate call this first (mirrors v3/agent/cooldown.ts#resetCooldown).
export function resetAllCooldowns(): void {
  (Object.keys(cooldownUntilMs) as ProviderId[]).forEach((provider) => {
    cooldownUntilMs[provider] = 0;
    lastFailureKind[provider] = undefined;
  });
}
