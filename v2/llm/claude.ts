// V2 phase 10 — Claude (Anthropic) provider adapter.
//
// Implements the shared LLMProvider interface (types.ts) — request/response
// shaping only. Never called with a real network request in this repo's
// tests (a fake `fetchImpl` is always injected).

import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider, ProviderConfig } from "./types";
import { callWithTimeoutAndRetry, LLMProviderError } from "./provider";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export function createClaudeProvider(config: ProviderConfig): LLMProvider {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: "claude",
    model,
    async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
      const start = Date.now();
      const response = await callWithTimeoutAndRetry(
        "claude",
        fetchImpl,
        baseUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxTokens ?? 500,
            temperature: request.temperature ?? 0,
            system: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt }],
          }),
        },
        config.timeoutMs,
        config.maxRetries
      );

      const body = await response.json();
      const raw = body?.content?.[0]?.text;
      if (typeof raw !== "string") {
        throw new LLMProviderError("claude", response.status, "Response missing content[0].text");
      }

      return { raw, provider: "claude", model, latencyMs: Date.now() - start };
    },
  };
}
