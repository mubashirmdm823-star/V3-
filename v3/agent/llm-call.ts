// V3 one-call agent — the ONE Gemini call.
//
// Reuses V2's LLM provider plumbing (timeout/retry/config loading) as pure
// transport — the prompt and the decision are entirely this agent's own.
// Never throws: returns `plan: null` on ANY failure (no provider
// configured, network error, timeout, invalid JSON, or a malformed plan),
// which is index.ts's signal to fall back to the full V2 pipeline for this
// turn. There is exactly one call site for this function per customer
// message — no second pass, no retry-with-a-different-prompt.

import { safeLoadProviderConfigFromEnv, createProvider, LLMProviderError, LLMTimeoutError } from "../../v2/llm/provider";
import type { FetchLike } from "../../v2/llm/types";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { AgentContext } from "./context";
import { validateAgentTurnPlan, type AgentTurnPlan } from "./schema";

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return match ? match[1].trim() : trimmed;
}

export interface AgentCallOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export interface AgentCallOutcome {
  plan: AgentTurnPlan | null;
  // Whether a call was actually attempted (false only when no provider/API
  // key is configured — the one case that costs nothing and isn't worth
  // counting).
  attempted: boolean;
  latencyMs: number;
  errorStatus?: number;
  timedOut?: boolean;
}

export async function callAgent(context: AgentContext, options: AgentCallOptions = {}): Promise<AgentCallOutcome> {
  const config = safeLoadProviderConfigFromEnv(options.env ?? process.env);
  if (!config) return { plan: null, attempted: false, latencyMs: 0 };

  const provider = createProvider(options.fetchImpl ? { ...config, fetchImpl: options.fetchImpl } : config);

  const start = Date.now();
  let raw: string;
  try {
    const result = await provider.complete({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(context),
      temperature: 0.3,
      maxTokens: 700,
    });
    raw = result.raw;
  } catch (error) {
    const latencyMs = Date.now() - start;
    if (error instanceof LLMProviderError) return { plan: null, attempted: true, latencyMs, errorStatus: error.status };
    if (error instanceof LLMTimeoutError) return { plan: null, attempted: true, latencyMs, timedOut: true };
    return { plan: null, attempted: true, latencyMs };
  }
  const latencyMs = Date.now() - start;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownCodeFence(raw));
  } catch {
    return { plan: null, attempted: true, latencyMs };
  }

  return { plan: validateAgentTurnPlan(parsed), attempted: true, latencyMs };
}
