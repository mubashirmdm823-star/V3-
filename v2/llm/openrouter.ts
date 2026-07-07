// V2 phase 10 — OpenRouter provider adapter.
//
// OpenRouter's API is OpenAI-compatible (same request/response envelope as
// openai.ts), but is kept as its own file since it's a distinct provider
// with its own base URL/model catalog/auth — matching "every provider must
// implement exactly the same interface" without conflating two different
// account/config sources into one file.

import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider, ProviderConfig } from "./types";
import { callWithTimeoutAndRetry, LLMProviderError } from "./provider";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

export function createOpenRouterProvider(config: ProviderConfig): LLMProvider {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: "openrouter",
    model,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
      const start = Date.now();
      const response = await callWithTimeoutAndRetry(
        "openrouter",
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
        throw new LLMProviderError("openrouter", response.status, "Response missing choices[0].message.content");
      }

      return { raw, provider: "openrouter", model, latencyMs: Date.now() - start };
    },
  };
}
