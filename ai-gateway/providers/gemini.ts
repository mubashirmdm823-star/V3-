// AI Gateway — Gemini / Google AI provider adapter.
//
// Priority-1 provider. Accepts either GEMINI_API_KEY or GOOGLE_API_KEY (see
// config.ts#getApiKey) since both name the same underlying Google AI Studio
// account in this codebase's existing convention (v2/llm/google-ai.ts).

import type { GatewayProvider } from "../provider-interface";
import type { GatewayRequest, ProviderCallResult, TokenUsage } from "../types";
import { GatewayHttpError, GatewayProviderError, GatewayTimeoutError, GatewayNotConfiguredError } from "../errors";
import { getApiKey, getBaseUrl, getModel, getTimeoutMs } from "../config";
import { maskUrlKey, safeErrorMessage, type ProviderDiagnostics } from "../diagnostics";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function tokensFromUsage(usage: unknown): TokenUsage {
  const u = usage as Record<string, unknown> | undefined;
  const input = typeof u?.promptTokenCount === "number" ? u.promptTokenCount : 0;
  const output = typeof u?.candidatesTokenCount === "number" ? u.candidatesTokenCount : 0;
  const total = typeof u?.totalTokenCount === "number" ? u.totalTokenCount : input + output;
  return { input, output, total };
}

export const geminiProvider: GatewayProvider = {
  id: "gemini",

  isConfigured(env) {
    return Boolean(getApiKey("gemini", env));
  },

  async call(request: GatewayRequest, env, fetchImpl): Promise<ProviderCallResult> {
    const apiKey = getApiKey("gemini", env);
    if (!apiKey) throw new GatewayNotConfiguredError("gemini");

    const model = getModel("gemini", env) ?? DEFAULT_MODEL;
    const baseUrl = getBaseUrl("gemini", env) ?? DEFAULT_BASE_URL;
    const timeoutMs = getTimeoutMs(env);
    const url = `${baseUrl}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const safeUrl = maskUrlKey(url);
    const diagnostics = (bodySummary?: string): ProviderDiagnostics => ({ provider: "gemini", model, baseUrl: safeUrl, timeoutMs, bodySummary });

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0,
            maxOutputTokens: request.maxTokens ?? 500,
            responseMimeType: "application/json",
          },
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new GatewayTimeoutError("gemini", timeoutMs, diagnostics());
      throw new GatewayProviderError("gemini", error, diagnostics());
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      throw new GatewayHttpError("gemini", response.status, diagnostics(safeErrorMessage(rawBody, apiKey)));
    }

    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new GatewayProviderError("gemini", "Response missing candidates[0].content.parts[0].text", diagnostics());
    }

    return { text, latencyMs: Date.now() - start, tokens: tokensFromUsage(body?.usageMetadata) };
  },
};
