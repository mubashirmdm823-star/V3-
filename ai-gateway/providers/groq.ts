// AI Gateway — Groq provider adapter.
//
// Priority-2 provider, tried only when Gemini is unconfigured, in cooldown,
// or fails. Groq's API is OpenAI-compatible (chat/completions envelope).

import type { GatewayProvider } from "../provider-interface";
import type { GatewayRequest, ProviderCallResult, TokenUsage } from "../types";
import { GatewayHttpError, GatewayProviderError, GatewayTimeoutError, GatewayNotConfiguredError } from "../errors";
import { getApiKey, getBaseUrl, getModel, getTimeoutMs } from "../config";
import { safeErrorMessage, type ProviderDiagnostics } from "../diagnostics";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

function tokensFromUsage(usage: unknown): TokenUsage {
  const u = usage as Record<string, unknown> | undefined;
  const input = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const output = typeof u?.completion_tokens === "number" ? u.completion_tokens : 0;
  const total = typeof u?.total_tokens === "number" ? u.total_tokens : input + output;
  return { input, output, total };
}

export const groqProvider: GatewayProvider = {
  id: "groq",

  isConfigured(env) {
    return Boolean(getApiKey("groq", env));
  },

  async call(request: GatewayRequest, env, fetchImpl): Promise<ProviderCallResult> {
    const apiKey = getApiKey("groq", env);
    if (!apiKey) throw new GatewayNotConfiguredError("groq");

    const model = getModel("groq", env) ?? DEFAULT_MODEL;
    const baseUrl = getBaseUrl("groq", env) ?? DEFAULT_BASE_URL;
    const timeoutMs = getTimeoutMs(env);
    // Groq's key rides only in the Authorization header (never the URL),
    // so baseUrl is already inherently safe to log as-is.
    const diagnostics = (bodySummary?: string): ProviderDiagnostics => ({ provider: "groq", model, baseUrl, timeoutMs, bodySummary });

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
      if (error instanceof Error && error.name === "AbortError") throw new GatewayTimeoutError("groq", timeoutMs, diagnostics());
      throw new GatewayProviderError("groq", error, diagnostics());
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      throw new GatewayHttpError("groq", response.status, diagnostics(safeErrorMessage(rawBody, apiKey)));
    }

    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new GatewayProviderError("groq", "Response missing choices[0].message.content", diagnostics());
    }

    return { text, latencyMs: Date.now() - start, tokens: tokensFromUsage(body?.usage) };
  },
};
