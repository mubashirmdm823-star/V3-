// V3 one-call agent — the ONE model call, routed entirely through the AI
// Gateway (ai-gateway/index.ts).
//
// V3 never talks to Gemini, Groq, or OpenRouter directly — it hands the
// gateway a prompt and gets back either normalized text (from whichever
// provider actually answered) or a total failure, never which provider
// answered or why a given one failed. Never throws: returns `plan: null` on
// ANY failure (gateway reports all providers failed, invalid JSON, or a
// malformed plan), which is index.ts's signal to fall back to the full V2
// pipeline for this turn. There is exactly one call site for this function
// per customer message — no second pass, no retry-with-a-different-prompt
// (cross-provider retry is the gateway's job, not this file's).

import { callAIGateway } from "../../ai-gateway";
import type { GatewayCallOptions } from "../../ai-gateway";
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
  fetchImpl?: GatewayCallOptions["fetchImpl"];
}

export interface AgentCallOutcome {
  plan: AgentTurnPlan | null;
  // Whether the gateway actually attempted at least one provider — false
  // only when every provider is unconfigured (no keys anywhere), the one
  // case that costs nothing and isn't worth counting.
  attempted: boolean;
  latencyMs: number;
  errorStatus?: number;
  timedOut?: boolean;
}

// Gemini is the sole provider behind V3's own process-wide 429 cooldown
// (v3/agent/cooldown.ts — "one shared Google API key"), so only ITS
// fallbackChain entry (not Groq's/OpenRouter's) surfaces here as
// errorStatus/timedOut for index.ts to act on.
function geminiOutcomeFlags(fallbackChain: string[]): { errorStatus?: number; timedOut?: boolean } {
  if (fallbackChain.includes("gemini:429")) return { errorStatus: 429 };
  if (fallbackChain.includes("gemini:timeout")) return { timedOut: true };
  return {};
}

export async function callAgent(context: AgentContext, options: AgentCallOptions = {}): Promise<AgentCallOutcome> {
  const start = Date.now();
  const result = await callAIGateway(
    {
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(context),
      temperature: 0.3,
      maxTokens: 700,
    },
    { env: options.env, fetchImpl: options.fetchImpl }
  );
  const latencyMs = Date.now() - start;

  if (!result.ok) {
    const attempted = result.fallbackChain.length > 0;
    return { plan: null, attempted, latencyMs, ...geminiOutcomeFlags(result.fallbackChain) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownCodeFence(result.text));
  } catch {
    return { plan: null, attempted: true, latencyMs };
  }

  return { plan: validateAgentTurnPlan(parsed), attempted: true, latencyMs };
}
