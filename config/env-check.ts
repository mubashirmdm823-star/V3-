// Production environment validation — startup-only diagnostics.
//
// Logs a safe, human-readable summary of how AI_ENGINE / AI_PROVIDER_ORDER /
// provider keys resolved, using the exact same defaulting logic
// config/ai-engine.ts and ai-gateway/config.ts already apply at request
// time — this module doesn't change any behavior, it only makes the
// resulting configuration visible in the terminal. Never crashes the app
// and never prints an actual key value, only presence booleans.

import { isAIEngineName, getConfiguredEngineName, DEFAULT_ENGINE } from "./ai-engine";
import { getProviderOrder, getApiKey, DEFAULT_PROVIDER_ORDER } from "../ai-gateway/config";
import type { ProviderId } from "../ai-gateway/types";
import { logger } from "../lib/logger";

const PROVIDER_IDS: readonly ProviderId[] = ["gemini", "groq", "openrouter"];

export function validateEnv(env: Record<string, string | undefined> = process.env): void {
  const rawEngine = (env.AI_ENGINE ?? "").trim().toLowerCase();
  if (!rawEngine) {
    logger.info(`[env-check] AI_ENGINE not set — defaulting to "${DEFAULT_ENGINE}".`);
  } else if (!isAIEngineName(rawEngine)) {
    logger.warn(`[env-check] AI_ENGINE="${rawEngine}" is not a recognized engine (expected v1/v2/v3) — defaulting to "${DEFAULT_ENGINE}".`);
  } else {
    logger.info(`[env-check] AI_ENGINE=${rawEngine}`);
  }

  if (!env.AI_PROVIDER_ORDER) {
    logger.info(`[env-check] AI_PROVIDER_ORDER not set — using default order: ${DEFAULT_PROVIDER_ORDER.join(",")}.`);
  } else {
    logger.info(`[env-check] AI_PROVIDER_ORDER=${getProviderOrder(env).join(",")}`);
  }

  const keyPresence = Object.fromEntries(PROVIDER_IDS.map((id) => [id, Boolean(getApiKey(id, env))])) as Record<ProviderId, boolean>;
  const configuredCount = Object.values(keyPresence).filter(Boolean).length;

  if (configuredCount === 0) {
    logger.warn(
      "[env-check] No AI provider keys configured (GEMINI_API_KEY/GOOGLE_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY all missing) — AI_ENGINE=v3 will fall back to the deterministic V2 pipeline for every message."
    );
  } else {
    logger.info(`[env-check] provider keys present — gemini:${keyPresence.gemini} groq:${keyPresence.groq} openrouter:${keyPresence.openrouter}`);
  }

  const activeEngine = getConfiguredEngineName(env);
  logger.info(`[env-check] active engine resolved to "${activeEngine}"`);
}
