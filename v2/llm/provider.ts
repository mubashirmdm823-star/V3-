// V2 phase 10 — provider factory, generic HTTP timeout/retry wrapper, and
// environment-based configuration loading.
//
// Every concrete provider (openai.ts/claude.ts/gemini.ts/google-ai.ts/
// openrouter.ts) implements the same LLMProvider interface from types.ts
// and is built by createProvider() below purely from a ProviderConfig —
// switching providers is a configuration change
// (LLM_PROVIDER=openai/claude/gemini/google-ai/openrouter), never a code
// change, per this phase's explicit requirement.

import type { FetchLike, LLMProvider, ProviderConfig, ProviderName } from "./types";
import { createOpenAIProvider } from "./openai";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";
import { createGoogleAIProvider } from "./google-ai";
import { createOpenRouterProvider } from "./openrouter";

export class LLMTimeoutError extends Error {
  constructor(provider: ProviderName, timeoutMs: number) {
    super(`${provider} request timed out after ${timeoutMs}ms`);
    this.name = "LLMTimeoutError";
  }
}

// Deliberately never includes the request body/headers (which could carry
// the API key) in the message — only the provider name and HTTP status.
export class LLMProviderError extends Error {
  constructor(public readonly provider: ProviderName, public readonly status?: number, cause?: unknown) {
    super(`${provider} request failed${status ? ` (HTTP ${status})` : ""}`);
    this.name = "LLMProviderError";
    this.cause = cause;
  }
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_RETRIES = 1;

// Every concrete provider file calls this instead of `fetch` directly, so
// timeout + retry behavior (and the "never leak the API key in an error"
// rule) is implemented exactly once.
export async function callWithTimeoutAndRetry(
  provider: ProviderName,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        // Only retry on transient (5xx) failures — a 4xx (bad request, bad
        // key, etc.) will never succeed on retry.
        if (response.status >= 500 && attempt < maxRetries) {
          lastError = new LLMProviderError(provider, response.status);
          continue;
        }
        throw new LLMProviderError(provider, response.status);
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new LLMTimeoutError(provider, timeoutMs);
        if (attempt < maxRetries) continue;
        throw lastError;
      }
      if (error instanceof LLMProviderError) throw error;
      lastError = new LLMProviderError(provider, undefined, error);
      if (attempt < maxRetries) continue;
      throw lastError;
    }
  }

  throw lastError ?? new LLMProviderError(provider);
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return createOpenAIProvider(config);
    case "claude":
      return createClaudeProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    case "google-ai":
      return createGoogleAIProvider(config);
    case "openrouter":
      return createOpenRouterProvider(config);
  }
}

const PROVIDER_NAMES: ReadonlySet<string> = new Set(["openai", "claude", "gemini", "google-ai", "openrouter"]);

export function isProviderName(value: string): value is ProviderName {
  return PROVIDER_NAMES.has(value);
}

// Every supported provider's env-var identity. Deliberately an explicit
// table rather than a naive `${NAME.toUpperCase()}_API_KEY` derivation,
// because real-world provider SDK conventions don't follow that pattern
// uniformly: Claude's key is ANTHROPIC_API_KEY (not CLAUDE_API_KEY), and
// Google AI Studio's is GOOGLE_API_KEY (not GOOGLE-AI_API_KEY) — both
// per this phase's explicit environment variable list.
const PROVIDER_ENV_PREFIX: Record<ProviderName, string> = {
  openai: "OPENAI",
  claude: "ANTHROPIC",
  gemini: "GEMINI",
  "google-ai": "GOOGLE",
  openrouter: "OPENROUTER",
};

// Reads LLM_PROVIDER + that provider's <PREFIX>_API_KEY (+ optional
// <PREFIX>_MODEL / <PREFIX>_BASE_URL) from the environment. API keys only
// ever come from here — never hardcoded, never logged (the returned config
// is not console-loggable-safe by convention; callers must not print it).
export function loadProviderConfigFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const providerRaw = (env.LLM_PROVIDER ?? "").toLowerCase();
  if (!isProviderName(providerRaw)) {
    throw new Error(`Unknown or missing LLM_PROVIDER environment variable: "${env.LLM_PROVIDER ?? ""}"`);
  }

  const prefix = PROVIDER_ENV_PREFIX[providerRaw];
  const apiKey = env[`${prefix}_API_KEY`];
  if (!apiKey) {
    throw new Error(`Missing ${prefix}_API_KEY environment variable.`);
  }

  return {
    provider: providerRaw,
    apiKey,
    model: env[`${prefix}_MODEL`],
    baseUrl: env[`${prefix}_BASE_URL`],
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined,
    maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : undefined,
  };
}

// A non-throwing variant for callers that need to gracefully degrade (e.g.
// fallback.ts#completeWithFallbackFromEnv) rather than treat "no provider
// configured yet" as an application error — this is what lets a missing
// LLM_PROVIDER/API key fall back to the deterministic parser instead of
// crashing.
export function safeLoadProviderConfigFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig | undefined {
  try {
    return loadProviderConfigFromEnv(env);
  } catch {
    return undefined;
  }
}
