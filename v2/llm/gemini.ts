// V2 phase 10 — Gemini provider adapter.
//
// Implements the shared LLMProvider interface (types.ts) — request/response
// shaping only. Never called with a real network request in this repo's
// tests (a fake `fetchImpl` is always injected).
//
// Gemini's REST API takes the API key as a query parameter rather than a
// header — still never logged, and still only ever read from
// ProviderConfig.apiKey (itself sourced from an environment variable by
// provider.ts#loadProviderConfigFromEnv).
//
// createGeminiStyleProvider() is exported so google-ai.ts (Google AI
// Studio — the same underlying REST API, but a distinct, independently
// selectable provider identity/env-var pair) can reuse this exact
// request/response logic instead of duplicating it. The only things that
// ever differ between "gemini" and "google-ai" are the provider name
// passed through and the default model/base URL — never the request
// shaping or response parsing.

import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider, ProviderConfig, ProviderName } from "./types";
import { callWithTimeoutAndRetry, LLMProviderError } from "./provider";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export function createGeminiStyleProvider(
  name: ProviderName,
  config: ProviderConfig,
  defaultModel: string = DEFAULT_MODEL,
  defaultBaseUrl: string = DEFAULT_BASE_URL
): LLMProvider {
  const model = config.model ?? defaultModel;
  const baseUrl = config.baseUrl ?? defaultBaseUrl;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name,
    model,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
      const start = Date.now();
      const url = `${baseUrl}/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const response = await callWithTimeoutAndRetry(
        name,
        fetchImpl,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
            generationConfig: {
              temperature: request.temperature ?? 0,
              maxOutputTokens: request.maxTokens ?? 500,
              responseMimeType: "application/json",
            },
          }),
        },
        config.timeoutMs,
        config.maxRetries
      );

      const body = await response.json();
      const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof raw !== "string") {
        throw new LLMProviderError(name, response.status, "Response missing candidates[0].content.parts[0].text");
      }

      return { raw, provider: name, model, latencyMs: Date.now() - start };
    },
  };
}

export function createGeminiProvider(config: ProviderConfig): LLMProvider {
  return createGeminiStyleProvider("gemini", config, DEFAULT_MODEL, DEFAULT_BASE_URL);
}
