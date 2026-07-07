// V2 phase 10 — OpenAI provider adapter.
//
// Implements the shared LLMProvider interface (types.ts) — request/response
// shaping only. Never called with a real network request in this repo's
// tests (a fake `fetchImpl` is always injected); real calls only happen
// once this phase is wired into the live pipeline in a future session.

import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider, ProviderConfig } from "./types";
import { callWithTimeoutAndRetry, LLMProviderError } from "./provider";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1/chat/completions";

export function createOpenAIProvider(config: ProviderConfig): LLMProvider {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: "openai",
    model,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
      const start = Date.now();
      const response = await callWithTimeoutAndRetry(
        "openai",
        fetchImpl,
        baseUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: request.temperature ?? 0,
            max_tokens: request.maxTokens ?? 500,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt },
            ],
          }),
        },
        config.timeoutMs,
        config.maxRetries
      );

      const body = await response.json();
      const raw = body?.choices?.[0]?.message?.content;
      if (typeof raw !== "string") {
        throw new LLMProviderError("openai", response.status, "Response missing choices[0].message.content");
      }

      return { raw, provider: "openai", model, latencyMs: Date.now() - start };
    },
  };
}
