// V2 phase 13 — feature flag configuration.
//
// The ONLY place that reads the AI_ENGINE environment variable. Both the
// WhatsApp simulator (via lib/engine) and /api/chat (also via lib/engine)
// go through this — switching engines is a config change only, never a
// code change: set AI_ENGINE=v1 or AI_ENGINE=v2 and nothing else.

import type { AIEngineName } from "@/lib/engine/types";

const VALID_ENGINES: ReadonlySet<string> = new Set(["v1", "v2", "v3"]);

// V1 is the safe default: a missing or unrecognized AI_ENGINE value must
// never crash or silently pick an unproven engine — it falls back to the
// engine that's been running the live demo all along.
export const DEFAULT_ENGINE: AIEngineName = "v1";

export function isAIEngineName(value: string): value is AIEngineName {
  return VALID_ENGINES.has(value);
}

export function getConfiguredEngineName(env: Record<string, string | undefined> = process.env): AIEngineName {
  const raw = (env.AI_ENGINE ?? "").trim().toLowerCase();
  return isAIEngineName(raw) ? raw : DEFAULT_ENGINE;
}
