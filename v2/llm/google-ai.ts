// V2 phase 10 — Google AI Studio (Gemini API) provider adapter.
//
// A dedicated, first-class provider module per this phase's requirement —
// but it deliberately does not duplicate any request/response/business
// logic. Google AI Studio's REST API is the exact same shape gemini.ts
// already implements (`generativelanguage.googleapis.com`), so this file
// only supplies this provider's own identity ("google-ai") and default
// model/base URL, and delegates everything else to
// gemini.ts#createGeminiStyleProvider. The only real difference from the
// existing "gemini" provider is which environment variable supplies the
// API key (GOOGLE_API_KEY vs GEMINI_API_KEY — see
// provider.ts#loadProviderConfigFromEnv) and which `LLM_PROVIDER` value
// selects it.

import type { LLMProvider, ProviderConfig } from "./types";
import { createGeminiStyleProvider } from "./gemini";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export function createGoogleAIProvider(config: ProviderConfig): LLMProvider {
  return createGeminiStyleProvider("google-ai", config, DEFAULT_MODEL, DEFAULT_BASE_URL);
}
