// AI Gateway — OpenRouter provider adapter.
//
// Priority-3 (last real-provider) fallback, tried only when both Gemini and
// Groq are unconfigured/cooling down/failing. OpenAI-compatible envelope,
// same shape as groq.ts but a distinct base URL/model catalog/auth.

import type { GatewayProvider } from "../provider-interface";
import type { GatewayRequest, ProviderCallResult, TokenUsage } from "../types";
import { GatewayHttpError, GatewayProviderError, GatewayTimeoutError, GatewayNotConfiguredError } from "../errors";
import { getApiKey, getBaseUrl, getModel, getTimeoutMs } from "../config";
import { safeErrorMessage, type ProviderDiagnostics } from "../diagnostics";

// OpenRouter documents these as recommended (not strictly required for
// auth) so requests are attributed on their dashboard/leaderboard instead
// of appearing as an anonymous app — configurable, with safe defaults, so
// this never needs a code change to point at the real deployed app.
const DEFAULT_APP_REFERER = "https://think-food.local";
const DEFAULT_APP_TITLE = "Think Food WhatsApp Assistant";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

function tokensFromUsage(usage: unknown): TokenUsage {
  const u = usage as Record<string, unknown> | undefined;
  const input = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const output = typeof u?.completion_tokens === "number" ? u.completion_tokens : 0;
  const total = typeof u?.total_tokens === "number" ? u.total_tokens : input + output;
  return { input, output, total };
}

export const openrouterProvider: GatewayProvider = {
  id: "openrouter",

  isConfigured(env) {
    return Boolean(getApiKey("openrouter", env));
  },

  async call(request: GatewayRequest, env, fetchImpl): Promise<ProviderCallResult> {
    const apiKey = getApiKey("openrouter", env);
    if (!apiKey) throw new GatewayNotConfiguredError("openrouter");

    const model = getModel("openrouter", env) ?? DEFAULT_MODEL;
    const baseUrl = getBaseUrl("openrouter", env) ?? DEFAULT_BASE_URL;
    const timeoutMs = getTimeoutMs(env);
    // OpenRouter's key rides only in the Authorization header (never the
    // URL), so baseUrl is already inherently safe to log as-is.
    const diagnostics = (bodySummary?: string): ProviderDiagnostics => ({ provider: "openrouter", model, baseUrl, timeoutMs, bodySummary });

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": env.OPENROUTER_APP_URL || DEFAULT_APP_REFERER,
          "X-Title": env.OPENROUTER_APP_TITLE || DEFAULT_APP_TITLE,
        },
        signal: controller.signal,
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
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new GatewayTimeoutError("openrouter", timeoutMs, diagnostics());
      throw new GatewayProviderError("openrouter", error, diagnostics());
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      throw new GatewayHttpError("openrouter", response.status, diagnostics(safeErrorMessage(rawBody, apiKey)));
    }

    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new GatewayProviderError("openrouter", "Response missing choices[0].message.content", diagnostics());
    }

    return { text, latencyMs: Date.now() - start, tokens: tokensFromUsage(body?.usage) };
  },
};
