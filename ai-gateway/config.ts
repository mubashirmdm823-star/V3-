// AI Gateway — environment-based configuration.
//
// The ONLY place that reads AI_PROVIDER_ORDER / *_API_KEY. Provider order is
// a config change, never a code change: set AI_PROVIDER_ORDER=groq,gemini to
// re-prioritize without touching failover.ts.

import type { ProviderId } from "./types";

export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = ["gemini", "groq", "openrouter"];

const VALID_PROVIDER_IDS: ReadonlySet<string> = new Set(["gemini", "groq", "openrouter"]);

function isProviderId(value: string): value is ProviderId {
  return VALID_PROVIDER_IDS.has(value);
}

// Malformed/unknown entries in AI_PROVIDER_ORDER are dropped rather than
// thrown — a typo in an env var must never crash the gateway. Falls back to
// the full default order if nothing valid remains.
export function getProviderOrder(env: Record<string, string | undefined> = process.env): ProviderId[] {
  const raw = env.AI_PROVIDER_ORDER;
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];

  const seen = new Set<ProviderId>();
  const order: ProviderId[] = [];
  for (const entry of raw.split(",")) {
    const id = entry.trim().toLowerCase();
    if (isProviderId(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order.length > 0 ? order : [...DEFAULT_PROVIDER_ORDER];
}

// Gemini uniquely accepts either of two env var names (GEMINI_API_KEY or
// GOOGLE_API_KEY) per this phase's explicit requirement — every other
// provider has exactly one.
export function getApiKey(provider: ProviderId, env: Record<string, string | undefined> = process.env): string | undefined {
  switch (provider) {
    case "gemini":
      return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
    case "groq":
      return env.GROQ_API_KEY || undefined;
    case "openrouter":
      return env.OPENROUTER_API_KEY || undefined;
  }
}

export function getModel(provider: ProviderId, env: Record<string, string | undefined> = process.env): string | undefined {
  switch (provider) {
    case "gemini":
      return env.GEMINI_MODEL || env.GOOGLE_MODEL || undefined;
    case "groq":
      return env.GROQ_MODEL || undefined;
    case "openrouter":
      return env.OPENROUTER_MODEL || undefined;
  }
}

export function getBaseUrl(provider: ProviderId, env: Record<string, string | undefined> = process.env): string | undefined {
  switch (provider) {
    case "gemini":
      return env.GEMINI_BASE_URL || env.GOOGLE_BASE_URL || undefined;
    case "groq":
      return env.GROQ_BASE_URL || undefined;
    case "openrouter":
      return env.OPENROUTER_BASE_URL || undefined;
  }
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_RETRIES = 0; // failover.ts handles cross-provider retry; a single provider never retries itself

export function getTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AI_GATEWAY_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
