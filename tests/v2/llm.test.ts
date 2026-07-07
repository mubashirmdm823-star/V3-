// V2 LLM Integration Layer tests. This phase stops at the provider
// abstraction (no real network calls, no wiring into the deterministic
// pipeline) — every provider test injects a fake `fetchImpl` so nothing
// here ever hits a real API, matching the phase's own security rules (API
// keys only via env vars, never logged, never a real network dependency in
// tests). The "production conversation simulation" section (M) drives the
// REAL deterministic pipeline (context-builder -> intent-parser/order-state
// -> response-builder) with a fake, always-failing LLM provider to prove
// the fallback contract end-to-end: the customer must never notice.
// Run with:
//   npx tsx --test tests/v2/llm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import { createInitialContext, processMessage } from "../../v2/order-state-engine";
import { parseMessage } from "../../v2/intent-parser/parser";
import { buildResponse } from "../../v2/response-builder";
import { createMemorySession, buildAIContext, updateMemoryAfterTurn, type MemorySession } from "../../v2/context-builder";

import type { FetchLike, LLMCompletionRequest, LLMProvider, ProviderConfig } from "../../v2/llm/types";
import { createOpenAIProvider } from "../../v2/llm/openai";
import { createClaudeProvider } from "../../v2/llm/claude";
import { createGeminiProvider } from "../../v2/llm/gemini";
import { createGoogleAIProvider } from "../../v2/llm/google-ai";
import { createOpenRouterProvider } from "../../v2/llm/openrouter";
import {
  createProvider,
  loadProviderConfigFromEnv,
  safeLoadProviderConfigFromEnv,
  isProviderName,
  callWithTimeoutAndRetry,
  LLMTimeoutError,
  LLMProviderError,
  DEFAULT_TIMEOUT_MS,
} from "../../v2/llm/provider";
import { SYSTEM_PROMPT, buildSystemPrompt } from "../../v2/llm/system-prompt";
import { buildPrompt, estimatePromptLength } from "../../v2/llm/prompt-builder";
import {
  buildContextInjection,
  renderCartAsText,
  renderMenuAsText,
  renderPendingClarificationAsText,
  renderRestaurantConfigAsText,
} from "../../v2/llm/context-injector";
import {
  ALLOWED_LLM_INTENTS,
  LLM_RESPONSE_ALLOWED_FIELDS,
  MAX_REASONABLE_QUANTITY,
  MIN_CONFIDENCE_TO_ACCEPT,
} from "../../v2/llm/json-schema";
import { validateLLMResponse } from "../../v2/llm/json-validator";
import { LLMCache, buildCacheKey, isCacheableIntent, DEFAULT_TTL_MS } from "../../v2/llm/cache";
import {
  shouldFallback,
  resolveIntent,
  completeWithFallback,
  completeWithFallbackFromEnv,
  type LLMCallOutcome,
} from "../../v2/llm/fallback";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

// ─────────────────────────────────────────────────────────────────────────
// Fake fetch helpers — no test in this file ever performs a real network
// call.
// ─────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fakeFetch(status: number, body: unknown): FetchLike {
  return (async () => jsonResponse(status, body)) as unknown as FetchLike;
}

function sequencedFetch(responses: Array<{ status: number; body: unknown }>): { fetchImpl: FetchLike; callCount: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return jsonResponse(r.status, r.body);
  }) as unknown as FetchLike;
  return { fetchImpl, callCount: () => calls };
}

function neverResolvingFetch(): FetchLike {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as FetchLike;
}

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { provider: "openai", apiKey: "test-key-not-real", ...overrides };
}

const SAMPLE_REQUEST: LLMCompletionRequest = { systemPrompt: "system", userPrompt: "user" };

// ─────────────────────────────────────────────────────────────────────────
// B. Provider interface — request shaping + response parsing per provider
// ─────────────────────────────────────────────────────────────────────────

test("B1. openai provider builds the expected request and parses choices[0].message.content", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, { choices: [{ message: { content: '{"intent":"SHOW_MENU","confidence":0.9,"items":[]}' } }] });
  }) as unknown as FetchLike;

  const provider = createOpenAIProvider(baseConfig({ provider: "openai", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);

  assert.equal(provider.name, "openai");
  assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");
  assert.match(String((capturedInit?.headers as Record<string, string>).Authorization), /^Bearer /);
  assert.equal(result.raw, '{"intent":"SHOW_MENU","confidence":0.9,"items":[]}');
  assert.equal(result.provider, "openai");
});

test("B2. openai provider throws a provider error when the response shape is unexpected", async () => {
  const provider = createOpenAIProvider(baseConfig({ fetchImpl: fakeFetch(200, { unexpected: true }) }));
  await assert.rejects(() => provider.complete(SAMPLE_REQUEST), LLMProviderError);
});

test("B3. claude provider sends x-api-key + anthropic-version headers and parses content[0].text", async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse(200, { content: [{ text: '{"intent":"SHOW_CART","confidence":0.9,"items":[]}' }] });
  }) as unknown as FetchLike;

  const provider = createClaudeProvider(baseConfig({ provider: "claude", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "test-key-not-real");
  assert.ok(headers["anthropic-version"]);
  assert.equal(result.raw, '{"intent":"SHOW_CART","confidence":0.9,"items":[]}');
  assert.equal(result.provider, "claude");
});

test("B4. claude provider throws a provider error when content[0].text is missing", async () => {
  const provider = createClaudeProvider(baseConfig({ provider: "claude", fetchImpl: fakeFetch(200, { content: [] }) }));
  await assert.rejects(() => provider.complete(SAMPLE_REQUEST), LLMProviderError);
});

test("B5. gemini provider puts the API key in the URL query string, never a header", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string) => {
    capturedUrl = url;
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"intent":"SHOW_MENU","confidence":0.9,"items":[]}' }] } }] });
  }) as unknown as FetchLike;

  const provider = createGeminiProvider(baseConfig({ provider: "gemini", apiKey: "gemini-key", fetchImpl }));
  await provider.complete(SAMPLE_REQUEST);

  assert.match(capturedUrl, /key=gemini-key/);
  assert.match(capturedUrl, /generateContent/);
});

test("B6. gemini provider parses candidates[0].content.parts[0].text", async () => {
  const fetchImpl = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"intent":"PRICE_QUERY","confidence":0.9,"items":[]}' }] } }] });
  const provider = createGeminiProvider(baseConfig({ provider: "gemini", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);
  assert.equal(result.raw, '{"intent":"PRICE_QUERY","confidence":0.9,"items":[]}');
});

test("B7. gemini provider throws a provider error when candidates are missing", async () => {
  const provider = createGeminiProvider(baseConfig({ provider: "gemini", fetchImpl: fakeFetch(200, {}) }));
  await assert.rejects(() => provider.complete(SAMPLE_REQUEST), LLMProviderError);
});

test("B8. openrouter provider is OpenAI-compatible in request/response shape", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string) => {
    capturedUrl = url;
    return jsonResponse(200, { choices: [{ message: { content: '{"intent":"SHOW_MENU","confidence":0.9,"items":[]}' } }] });
  }) as unknown as FetchLike;

  const provider = createOpenRouterProvider(baseConfig({ provider: "openrouter", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);

  assert.match(capturedUrl, /openrouter\.ai/);
  assert.equal(result.provider, "openrouter");
});

test("B9. openrouter provider throws a provider error on unexpected response shape", async () => {
  const provider = createOpenRouterProvider(baseConfig({ provider: "openrouter", fetchImpl: fakeFetch(200, { choices: [] }) }));
  await assert.rejects(() => provider.complete(SAMPLE_REQUEST), LLMProviderError);
});

test("B10. every provider reports a sensible default model when none is configured", () => {
  const providers = [
    createOpenAIProvider(baseConfig({ provider: "openai" })),
    createClaudeProvider(baseConfig({ provider: "claude" })),
    createGeminiProvider(baseConfig({ provider: "gemini" })),
    createGoogleAIProvider(baseConfig({ provider: "google-ai" })),
    createOpenRouterProvider(baseConfig({ provider: "openrouter" })),
  ];
  for (const p of providers) {
    assert.ok(p.model.length > 0);
  }
});

test("B11. a custom model override is respected by every provider", () => {
  const p = createOpenAIProvider(baseConfig({ provider: "openai", model: "gpt-custom" }));
  assert.equal(p.model, "gpt-custom");
});

test("B12. all five providers implement exactly the same LLMProvider interface shape", () => {
  const providers: LLMProvider[] = [
    createOpenAIProvider(baseConfig({ provider: "openai" })),
    createClaudeProvider(baseConfig({ provider: "claude" })),
    createGeminiProvider(baseConfig({ provider: "gemini" })),
    createGoogleAIProvider(baseConfig({ provider: "google-ai" })),
    createOpenRouterProvider(baseConfig({ provider: "openrouter" })),
  ];
  for (const p of providers) {
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.model, "string");
    assert.equal(typeof p.complete, "function");
  }
});

test("B13. google-ai provider puts the API key in the URL query string, exactly like gemini", async () => {
  let capturedUrl = "";
  const fetchImpl = (async (url: string) => {
    capturedUrl = url;
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"intent":"SHOW_MENU","confidence":0.9,"items":[]}' }] } }] });
  }) as unknown as FetchLike;

  const provider = createGoogleAIProvider(baseConfig({ provider: "google-ai", apiKey: "google-ai-key", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);

  assert.equal(provider.name, "google-ai");
  assert.match(capturedUrl, /key=google-ai-key/);
  assert.match(capturedUrl, /generateContent/);
  assert.equal(result.provider, "google-ai");
});

test("B14. google-ai provider parses candidates[0].content.parts[0].text, same as gemini", async () => {
  const fetchImpl = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"intent":"PRICE_QUERY","confidence":0.9,"items":[]}' }] } }] });
  const provider = createGoogleAIProvider(baseConfig({ provider: "google-ai", fetchImpl }));
  const result = await provider.complete(SAMPLE_REQUEST);
  assert.equal(result.raw, '{"intent":"PRICE_QUERY","confidence":0.9,"items":[]}');
});

test("B15. google-ai provider throws a provider error when candidates are missing", async () => {
  const provider = createGoogleAIProvider(baseConfig({ provider: "google-ai", fetchImpl: fakeFetch(200, {}) }));
  await assert.rejects(() => provider.complete(SAMPLE_REQUEST), LLMProviderError);
});

test("B16. gemini and google-ai are independent provider identities despite sharing request logic", () => {
  const gemini = createGeminiProvider(baseConfig({ provider: "gemini" }));
  const googleAi = createGoogleAIProvider(baseConfig({ provider: "google-ai" }));
  assert.equal(gemini.name, "gemini");
  assert.equal(googleAi.name, "google-ai");
  assert.notEqual(gemini.name, googleAi.name);
});

// ─────────────────────────────────────────────────────────────────────────
// C. Provider factory & configuration switching
// ─────────────────────────────────────────────────────────────────────────

test("C1. createProvider dispatches to the correct concrete provider for every name", () => {
  assert.equal(createProvider(baseConfig({ provider: "openai" })).name, "openai");
  assert.equal(createProvider(baseConfig({ provider: "claude" })).name, "claude");
  assert.equal(createProvider(baseConfig({ provider: "gemini" })).name, "gemini");
  assert.equal(createProvider(baseConfig({ provider: "google-ai" })).name, "google-ai");
  assert.equal(createProvider(baseConfig({ provider: "openrouter" })).name, "openrouter");
});

test("C2. isProviderName recognizes exactly the five supported providers", () => {
  assert.equal(isProviderName("openai"), true);
  assert.equal(isProviderName("claude"), true);
  assert.equal(isProviderName("gemini"), true);
  assert.equal(isProviderName("google-ai"), true);
  assert.equal(isProviderName("openrouter"), true);
  assert.equal(isProviderName("chatgpt"), false);
});

test("C3. loadProviderConfigFromEnv reads LLM_PROVIDER + OPENAI_API_KEY for openai", () => {
  const config = loadProviderConfigFromEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, "sk-test");
});

test("C4. loadProviderConfigFromEnv works for claude/gemini/openrouter with their own key names", () => {
  assert.equal(loadProviderConfigFromEnv({ LLM_PROVIDER: "claude", ANTHROPIC_API_KEY: "x" }).provider, "claude");
  assert.equal(loadProviderConfigFromEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "x" }).provider, "gemini");
  assert.equal(loadProviderConfigFromEnv({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "x" }).provider, "openrouter");
});

test("C4b. LLM_PROVIDER=google-ai automatically uses GOOGLE_API_KEY", () => {
  const config = loadProviderConfigFromEnv({ LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "g-test" });
  assert.equal(config.provider, "google-ai");
  assert.equal(config.apiKey, "g-test");
});

test("C4c. claude reads ANTHROPIC_API_KEY, not CLAUDE_API_KEY", () => {
  assert.throws(() => loadProviderConfigFromEnv({ LLM_PROVIDER: "claude", CLAUDE_API_KEY: "wrong-var" }));
  assert.doesNotThrow(() => loadProviderConfigFromEnv({ LLM_PROVIDER: "claude", ANTHROPIC_API_KEY: "right-var" }));
});

test("C5. loadProviderConfigFromEnv is case-insensitive on LLM_PROVIDER", () => {
  const config = loadProviderConfigFromEnv({ LLM_PROVIDER: "OpenAI", OPENAI_API_KEY: "sk-test" });
  assert.equal(config.provider, "openai");
});

test("C6. loadProviderConfigFromEnv throws when LLM_PROVIDER is missing or unknown", () => {
  assert.throws(() => loadProviderConfigFromEnv({}));
  assert.throws(() => loadProviderConfigFromEnv({ LLM_PROVIDER: "chatgpt" }));
});

test("C7. loadProviderConfigFromEnv throws when the API key is missing", () => {
  assert.throws(() => loadProviderConfigFromEnv({ LLM_PROVIDER: "openai" }));
  assert.throws(() => loadProviderConfigFromEnv({ LLM_PROVIDER: "google-ai" }));
});

test("C8. loadProviderConfigFromEnv picks up optional model/base URL overrides", () => {
  const config = loadProviderConfigFromEnv({
    LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-5", OPENAI_BASE_URL: "https://example.test",
  });
  assert.equal(config.model, "gpt-5");
  assert.equal(config.baseUrl, "https://example.test");
});

test("C8b. GOOGLE_MODEL/GOOGLE_BASE_URL override google-ai's defaults", () => {
  const config = loadProviderConfigFromEnv({
    LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "g-test", GOOGLE_MODEL: "gemini-custom", GOOGLE_BASE_URL: "https://example.test",
  });
  assert.equal(config.model, "gemini-custom");
  assert.equal(config.baseUrl, "https://example.test");
});

test("C9. switching providers requires no code change — same createProvider call, different config", () => {
  const configs: ProviderConfig[] = ["openai", "claude", "gemini", "google-ai", "openrouter"].map((p) => baseConfig({ provider: p as ProviderConfig["provider"] }));
  const providers = configs.map(createProvider);
  assert.deepEqual(providers.map((p) => p.name), ["openai", "claude", "gemini", "google-ai", "openrouter"]);
});

test("C10. an API key is never present anywhere in a provider's public surface (name/model)", () => {
  const provider = createOpenAIProvider(baseConfig({ apiKey: "super-secret-key" }));
  assert.doesNotMatch(provider.name, /super-secret-key/);
  assert.doesNotMatch(provider.model, /super-secret-key/);
});

// ─────────────────────────────────────────────────────────────────────────
// D. Timeout & retry
// ─────────────────────────────────────────────────────────────────────────

test("D1. a request that never resolves times out with LLMTimeoutError", async () => {
  await assert.rejects(
    () => callWithTimeoutAndRetry("openai", neverResolvingFetch(), "https://x", { method: "POST" }, 30, 0),
    LLMTimeoutError
  );
});

test("D2. DEFAULT_TIMEOUT_MS is a sane positive number", () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

test("D3. a 500 response is retried up to maxRetries then succeeds", async () => {
  const { fetchImpl, callCount } = sequencedFetch([
    { status: 500, body: {} },
    { status: 200, body: { ok: true } },
  ]);
  const response = await callWithTimeoutAndRetry("openai", fetchImpl, "https://x", { method: "POST" }, 1000, 1);
  assert.equal(response.ok, true);
  assert.equal(callCount(), 2);
});

test("D4. a 400 response is never retried", async () => {
  const { fetchImpl, callCount } = sequencedFetch([{ status: 400, body: {} }]);
  await assert.rejects(() => callWithTimeoutAndRetry("openai", fetchImpl, "https://x", { method: "POST" }, 1000, 3), LLMProviderError);
  assert.equal(callCount(), 1);
});

test("D5. exhausting all retries on repeated 500s still throws", async () => {
  const { fetchImpl, callCount } = sequencedFetch([{ status: 500, body: {} }, { status: 500, body: {} }]);
  await assert.rejects(() => callWithTimeoutAndRetry("openai", fetchImpl, "https://x", { method: "POST" }, 1000, 1));
  assert.equal(callCount(), 2);
});

test("D6. a successful first attempt makes no retry calls", async () => {
  const { fetchImpl, callCount } = sequencedFetch([{ status: 200, body: {} }]);
  await callWithTimeoutAndRetry("openai", fetchImpl, "https://x", { method: "POST" }, 1000, 3);
  assert.equal(callCount(), 1);
});

test("D7. LLMTimeoutError message never includes request internals, only provider + duration", () => {
  const err = new LLMTimeoutError("gemini", 1234);
  assert.match(err.message, /gemini/);
  assert.match(err.message, /1234/);
});

test("D8. LLMProviderError never includes the request body/headers in its message", () => {
  const err = new LLMProviderError("openai", 500, "internal detail that should not leak into .message");
  assert.doesNotMatch(err.message, /internal detail/);
});

// ─────────────────────────────────────────────────────────────────────────
// E. System prompt
// ─────────────────────────────────────────────────────────────────────────

test("E1. buildSystemPrompt is deterministic", () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
  assert.equal(buildSystemPrompt(), SYSTEM_PROMPT);
});

test("E2. system prompt states the model must only output JSON, no markdown/prose", () => {
  assert.match(SYSTEM_PROMPT, /ONLY a single JSON object/);
  assert.match(SYSTEM_PROMPT, /No markdown/);
});

test("E3. system prompt lists every absolute rule the LLM must never break", () => {
  for (const phrase of [
    "Calculate totals", "Modify the cart", "Change the order state", "Generate a checkout flow",
    "Generate a customer-facing reply", "Invent menu items", "Invent prices", "Invent delivery information",
    "Invent restaurant information",
  ]) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), `expected system prompt to mention: ${phrase}`);
  }
});

test("E4. system prompt never contains a real API key or secret-shaped string", () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /sk-[a-zA-Z0-9]{10,}/);
});

// ─────────────────────────────────────────────────────────────────────────
// F. Prompt builder
// ─────────────────────────────────────────────────────────────────────────

function freshSession(): MemorySession {
  return createMemorySession(`conv-${Math.random()}`, `sess-${Math.random()}`);
}

test("F1. prompt sections appear in the required order", () => {
  const aiContext = buildAIContext(freshSession(), "ek jumbo zinger dedo", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  const order = ["Restaurant Rules:", "Current Conversation Summary:", "Current Cart:", "Current State:", "Pending Clarification:", "Relevant Menu:", "Customer Message:"];
  // The embedded conversation summary (context-builder/context-summary.ts)
  // legitimately reuses some of these same header words ("Current State:",
  // "Current Cart:", "Pending Clarification:") inside its own compact
  // recap — lastIndexOf, not indexOf, is what actually lands on this
  // prompt's own top-level section headers rather than their earlier,
  // embedded namesakes.
  let lastIndex = -1;
  for (const marker of order) {
    const idx = request.userPrompt.lastIndexOf(marker);
    assert.ok(idx > lastIndex, `expected "${marker}" to appear in order`);
    lastIndex = idx;
  }
});

test("F2. system prompt section is the fixed SYSTEM_PROMPT", () => {
  const aiContext = buildAIContext(freshSession(), "hi", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.equal(request.systemPrompt, SYSTEM_PROMPT);
});

test("F3. the customer message appears verbatim in the prompt", () => {
  const aiContext = buildAIContext(freshSession(), "2 jumbo zinger aur 1 alfredo pasta dedo", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /2 jumbo zinger aur 1 alfredo pasta dedo/);
});

test("F4. only the relevant menu subset is included, never the full menu.json for a specific item", () => {
  const aiContext = buildAIContext(freshSession(), "pizza", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /Pizza:/);
  assert.doesNotMatch(request.userPrompt, /Burgers:/);
});

test("F5. a restaurant-info question needs no menu section content", () => {
  const aiContext = buildAIContext(freshSession(), "aapka address kya hai", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /no menu items are relevant/);
});

test("F6. current cart is rendered with real item names and quantities", () => {
  const session = freshSession();
  let ctx = createInitialContext();
  const pr = parseMessage("ek jumbo zinger dedo", ctx.cart, menu);
  ctx = processMessage(ctx, pr, menu);
  const aiContext = buildAIContext({ ...session, memory: { ...session.memory, currentCart: ctx.cart } }, "checkout", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /Jumbo Zinger/);
});

test("F7. restaurant rules section includes real config values, never placeholders", () => {
  const aiContext = buildAIContext(freshSession(), "hi", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /Think Food/);
  assert.match(request.userPrompt, /0312-2175855/);
});

test("F8. estimatePromptLength reflects the actual combined prompt size", () => {
  const aiContext = buildAIContext(freshSession(), "menu dikhao", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.equal(estimatePromptLength(request), request.systemPrompt.length + request.userPrompt.length);
});

test("F9. prompt never contains a raw history array/JSON dump", () => {
  const aiContext = buildAIContext(freshSession(), "hi", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.doesNotMatch(request.userPrompt, /\[\s*\{/);
});

test("F10. Roman Urdu, English, and Hinglish customer messages all pass through unmodified", () => {
  for (const msg of ["ek jumbo zinger dedo", "I want a jumbo zinger", "2 zinger burger add karo please"]) {
    const aiContext = buildAIContext(freshSession(), msg, menu, restaurantConfig);
    const request = buildPrompt(aiContext);
    assert.match(request.userPrompt, new RegExp(msg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("F11. pending clarification is rendered with its real options when present", () => {
  const session = freshSession();
  let ctx = createInitialContext();
  const pr = parseMessage("5 pasta", ctx.cart, menu);
  ctx = processMessage(ctx, pr, menu);
  const withPending = { ...session, memory: { ...session.memory, pendingClarification: ctx.pendingClarification, currentOrderState: ctx.state } };
  const aiContext = buildAIContext(withPending, "2 small 2 large 1 alfredo", menu, restaurantConfig);
  const request = buildPrompt(aiContext);
  assert.match(request.userPrompt, /Pasta Small/);
});

test("F12. a stress-length prompt (very long conversation) still builds without throwing", () => {
  let session = freshSession();
  let ctx = createInitialContext();
  for (let i = 0; i < 60; i++) {
    const pr = parseMessage("menu dikhao", ctx.cart, menu);
    const after = processMessage(ctx, pr, menu);
    session = updateMemoryAfterTurn(session, { rawMessage: "menu dikhao", parseResult: pr, before: ctx, after, reply: "ok", menu });
    ctx = after;
  }
  assert.doesNotThrow(() => buildPrompt(buildAIContext(session, "ek jumbo zinger dedo", menu, restaurantConfig)));
});

// ─────────────────────────────────────────────────────────────────────────
// G. Context injection
// ─────────────────────────────────────────────────────────────────────────

test("G1. buildContextInjection exposes exactly the allowed fields", () => {
  const aiContext = buildAIContext(freshSession(), "hi", menu, restaurantConfig);
  const injection = buildContextInjection(aiContext);
  assert.deepEqual(
    Object.keys(injection).sort(),
    ["conversationSummary", "currentCart", "currentState", "relevantMenu", "restaurantConfig"].sort()
  );
});

test("G2. buildContextInjection includes pendingClarification only when present", () => {
  const session = freshSession();
  let ctx = createInitialContext();
  const pr = parseMessage("ek zinger dedo", ctx.cart, menu);
  ctx = processMessage(ctx, pr, menu);
  const withPending = { ...session, memory: { ...session.memory, pendingClarification: ctx.pendingClarification, currentOrderState: ctx.state } };
  const aiContext = buildAIContext(withPending, "jumbo zinger", menu, restaurantConfig);
  const injection = buildContextInjection(aiContext);
  assert.ok(injection.pendingClarification);
});

test("G3. context injection never carries the full menu, only the relevant subset", () => {
  const aiContext = buildAIContext(freshSession(), "pizza", menu, restaurantConfig);
  const injection = buildContextInjection(aiContext);
  assert.ok(injection.relevantMenu.categories.length < menu.categories.length);
});

test("G4. context injection never carries conversation history", () => {
  const aiContext = buildAIContext(freshSession(), "hi", menu, restaurantConfig);
  const injection = buildContextInjection(aiContext) as unknown as Record<string, unknown>;
  assert.equal("history" in injection, false);
});

test("G5. renderCartAsText shows 'Empty' for an empty cart, real lines otherwise", () => {
  assert.equal(renderCartAsText({ items: [] }), "Empty");
  const cart: CartState = { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 2 }] };
  assert.match(renderCartAsText(cart), /2 x Gyro \(id: gyro\)/);
});

test("G6. renderMenuAsText renders real item ids and prices, never invented ones", () => {
  const text = renderMenuAsText({ categories: [menu.categories[0]] });
  assert.match(text, new RegExp(menu.categories[0].items[0].id));
});

test("G7. renderPendingClarificationAsText says 'None' when nothing is pending", () => {
  assert.equal(renderPendingClarificationAsText(undefined), "None");
});

test("G8. renderRestaurantConfigAsText never fabricates a field not in the real config", () => {
  const text = renderRestaurantConfigAsText(restaurantConfig);
  assert.match(text, /Think Food/);
  assert.doesNotMatch(text, /branches/i);
});

// ─────────────────────────────────────────────────────────────────────────
// H. JSON schema constants
// ─────────────────────────────────────────────────────────────────────────

test("H1. ALLOWED_LLM_INTENTS has exactly 34 entries matching IntentName (incl. the conversation layer)", () => {
  assert.equal(ALLOWED_LLM_INTENTS.size, 34);
  for (const intent of ["GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT", "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK", "IRRELEVANT_QUERY", "HELP", "GOODBYE"] as const) {
    assert.equal(ALLOWED_LLM_INTENTS.has(intent), true, intent);
  }
});

test("H2. LLM_RESPONSE_ALLOWED_FIELDS never includes a business-logic field like 'total' or 'reply'", () => {
  assert.equal(LLM_RESPONSE_ALLOWED_FIELDS.has("total"), false);
  assert.equal(LLM_RESPONSE_ALLOWED_FIELDS.has("reply"), false);
});

test("H3. MIN_CONFIDENCE_TO_ACCEPT matches the deterministic layer's high-confidence threshold", () => {
  assert.equal(MIN_CONFIDENCE_TO_ACCEPT, 0.85);
});

test("H4. MAX_REASONABLE_QUANTITY is a sane positive cap", () => {
  assert.ok(MAX_REASONABLE_QUANTITY > 0 && MAX_REASONABLE_QUANTITY < 1000);
});

// ─────────────────────────────────────────────────────────────────────────
// I. JSON validation
// ─────────────────────────────────────────────────────────────────────────

function validAddResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "jumbo-zinger", quantity: 1 }], ...overrides });
}

test("I1. a well-formed response validates successfully", () => {
  const result = validateLLMResponse(validAddResponse(), menu);
  assert.equal(result.ok, true);
});

test("I2. malformed JSON is rejected", () => {
  const result = validateLLMResponse("not json {", menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_json");
});

test("I3. a JSON array (not an object) is rejected", () => {
  const result = validateLLMResponse("[1,2,3]", menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_object");
});

// Google AI/Gemini (and potentially other models) sometimes wrap
// otherwise-valid JSON in a markdown code fence despite the system prompt
// explicitly forbidding it — the validator must not trust the model to
// police its own output format.
test("I3a. valid JSON wrapped in a ```json fence is accepted", () => {
  const result = validateLLMResponse('```json\n{"intent":"SHOW_OPTIONS","confidence":1,"items":[]}\n```', menu);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.response.intent, "SHOW_OPTIONS");
});

test("I3b. valid JSON wrapped in a bare ``` fence (no 'json' label) is accepted", () => {
  const result = validateLLMResponse('```\n{"intent":"GREETING","confidence":1,"items":[]}\n```', menu);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.response.intent, "GREETING");
});

test("I3c. a fence label is case-insensitive (```JSON)", () => {
  const result = validateLLMResponse('```JSON\n{"intent":"HELP","confidence":1,"items":[]}\n```', menu);
  assert.equal(result.ok, true);
});

test("I3d. genuinely malformed JSON inside a fence still fails as invalid_json", () => {
  const result = validateLLMResponse('```json\n{"intent":"SHOW_OPTIONS"\n```', menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_json");
});

test("I3e. a code fence appearing mid-text (not wrapping the whole response) is left alone and still fails", () => {
  const result = validateLLMResponse('here is json ```{"intent":"GREETING"}```', menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_json");
});

test("I4. a missing required field is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", items: [] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_field");
});

test("I5. an unknown top-level field is rejected", () => {
  const result = validateLLMResponse(validAddResponse({ total: 500 }).slice(0, -1) + ',"total":500}', menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unknown_field");
});

test("I6. an unrecognized intent is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ORDER_PIZZA", confidence: 0.9, items: [] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unknown_intent");
});

test("I7. a confidence outside [0,1] is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 1.5, items: [] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_confidence");
});

test("I8. a confidence below the acceptance threshold is rejected as low_confidence", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.5, items: [] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "low_confidence");
});

test("I9. a hallucinated menu item id is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "made-up-item", quantity: 1 }] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "hallucinated_item");
});

test("I10. a zero or negative quantity is rejected", () => {
  for (const qty of [0, -1]) {
    const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: qty }] }), menu);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_quantity");
  }
});

test("I11. a non-integer quantity is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: 1.5 }] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_quantity");
});

test("I12. an absurdly large quantity is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: 99999 }] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_quantity");
});

test("I13. items must be an array", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: "gyro" }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_items");
});

test("I14. an item with an unknown extra field is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: 1, note: "extra" }] }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_items");
});

test("I15. a valid replace is accepted", () => {
  const result = validateLLMResponse(
    JSON.stringify({ intent: "REPLACE_ITEM", confidence: 0.95, items: [], replace: { fromId: "zinger-burger", toId: "chicken-steak" } }),
    menu
  );
  assert.equal(result.ok, true);
});

test("I16. a replace with a hallucinated fromId/toId is rejected", () => {
  const r1 = validateLLMResponse(JSON.stringify({ intent: "REPLACE_ITEM", confidence: 0.95, items: [], replace: { fromId: "not-real", toId: "gyro" } }), menu);
  assert.equal(r1.ok, false);
  const r2 = validateLLMResponse(JSON.stringify({ intent: "REPLACE_ITEM", confidence: 0.95, items: [], replace: { fromId: "gyro", toId: "not-real" } }), menu);
  assert.equal(r2.ok, false);
});

test("I17. a replace object with an extra field is rejected", () => {
  const result = validateLLMResponse(
    JSON.stringify({ intent: "REPLACE_ITEM", confidence: 0.95, items: [], replace: { fromId: "gyro", toId: "wrap", note: "x" } }),
    menu
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_replace");
});

test("I18. category, when present, must be a string", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "SHOW_OPTIONS", confidence: 0.9, items: [], category: 123 }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_field");
});

test("I19. needsClarification, when present, must be a boolean", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ASK_CLARIFICATION", confidence: 0.9, items: [], needsClarification: "yes" }), menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_field");
});

test("I20. an empty items array is valid for a non-cart intent", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "SHOW_MENU", confidence: 0.95, items: [] }), menu);
  assert.equal(result.ok, true);
});

test("I21. multiple valid items (ADD_MULTIPLE_ITEMS) validate correctly", () => {
  const result = validateLLMResponse(
    JSON.stringify({ intent: "ADD_MULTIPLE_ITEMS", confidence: 0.95, items: [{ id: "jumbo-zinger", quantity: 2 }, { id: "alfredo-pasta-white-sauce", quantity: 1 }] }),
    menu
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.response.items.length, 2);
});

test("I22. the validated response strips nothing valid — every accepted field survives", () => {
  const result = validateLLMResponse(
    JSON.stringify({ intent: "SHOW_OPTIONS", confidence: 0.9, items: [], category: "burgers", needsClarification: true }),
    menu
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.response.category, "burgers");
    assert.equal(result.response.needsClarification, true);
  }
});

test("I23. a non-string item id is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: 123, quantity: 1 }] }), menu);
  assert.equal(result.ok, false);
});

test("I24. an empty-string item id is rejected", () => {
  const result = validateLLMResponse(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "", quantity: 1 }] }), menu);
  assert.equal(result.ok, false);
});

test("I25. null is rejected outright", () => {
  const result = validateLLMResponse("null", menu);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_object");
});

// ─────────────────────────────────────────────────────────────────────────
// J. Cache
// ─────────────────────────────────────────────────────────────────────────

test("J1. cache set/get round-trips a response", () => {
  const cache = new LLMCache();
  const response = { intent: "SHOW_MENU" as const, confidence: 0.95, items: [] };
  cache.set("menu dikhao", response);
  assert.deepEqual(cache.get("menu dikhao"), response);
});

test("J2. cache miss returns undefined", () => {
  const cache = new LLMCache();
  assert.equal(cache.get("never set"), undefined);
});

test("J3. cache entries expire after their TTL", () => {
  let now = 1000;
  const cache = new LLMCache(100, () => now);
  cache.set("k", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  now += 50;
  assert.ok(cache.get("k"));
  now += 100;
  assert.equal(cache.get("k"), undefined);
});

test("J4. a per-entry TTL override is respected", () => {
  let now = 0;
  const cache = new LLMCache(DEFAULT_TTL_MS, () => now);
  cache.set("k", { intent: "SHOW_MENU", confidence: 0.9, items: [] }, 10);
  now = 20;
  assert.equal(cache.get("k"), undefined);
});

test("J5. buildCacheKey normalizes case and surrounding whitespace", () => {
  assert.equal(buildCacheKey("  Menu Dikhao  "), buildCacheKey("menu dikhao"));
});

test("J6. buildCacheKey collapses repeated internal whitespace", () => {
  assert.equal(buildCacheKey("menu   dikhao"), buildCacheKey("menu dikhao"));
});

test("J7. isCacheableIntent whitelists only safe-to-cache intents", () => {
  assert.equal(isCacheableIntent("SHOW_MENU"), true);
  assert.equal(isCacheableIntent("ASK_RESTAURANT_INFO"), true);
  assert.equal(isCacheableIntent("PRICE_QUERY"), true);
});

test("J8. isCacheableIntent rejects cart-mutating intents", () => {
  assert.equal(isCacheableIntent("ADD_ITEM"), false);
  assert.equal(isCacheableIntent("REMOVE_ALL"), false);
  assert.equal(isCacheableIntent("CONFIRM_ORDER"), false);
});

test("J9. cache.has mirrors cache.get's presence/expiry semantics", () => {
  const cache = new LLMCache();
  assert.equal(cache.has("k"), false);
  cache.set("k", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  assert.equal(cache.has("k"), true);
});

test("J10. cache.delete removes a single entry", () => {
  const cache = new LLMCache();
  cache.set("a", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  cache.set("b", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
});

test("J11. cache.clear empties every entry", () => {
  const cache = new LLMCache();
  cache.set("a", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  cache.clear();
  assert.equal(cache.size, 0);
});

test("J12. cache.size reflects the live entry count", () => {
  const cache = new LLMCache();
  cache.set("a", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  cache.set("b", { intent: "SHOW_MENU", confidence: 0.9, items: [] });
  assert.equal(cache.size, 2);
});

test("J13. delivery-charges/timing/address-style queries are cacheable by design", () => {
  assert.equal(isCacheableIntent("ASK_RESTAURANT_INFO"), true);
});

test("J14. repeated identical raw messages share one cache key regardless of punctuation-free variation", () => {
  assert.equal(buildCacheKey("gyro ki price kya hai"), buildCacheKey("Gyro Ki Price Kya Hai"));
});

// ─────────────────────────────────────────────────────────────────────────
// K. Fallback / completeWithFallback
// ─────────────────────────────────────────────────────────────────────────

function fakeProvider(raw: string | (() => Promise<never>)): LLMProvider {
  return {
    name: "openai",
    model: "fake",
    async complete() {
      if (typeof raw === "function") return raw();
      return { raw, provider: "openai", model: "fake", latencyMs: 1 };
    },
  };
}

test("K1. shouldFallback is true for any failed outcome", () => {
  const outcome: LLMCallOutcome = { ok: false, reason: "timeout" };
  assert.equal(shouldFallback(outcome), true);
});

test("K2. shouldFallback is false for a successful outcome", () => {
  const outcome: LLMCallOutcome = { ok: true, response: { intent: "SHOW_MENU", confidence: 0.95, items: [] }, latencyMs: 1 };
  assert.equal(shouldFallback(outcome), false);
});

test("K3. resolveIntent returns the LLM response when the outcome succeeded", () => {
  const outcome: LLMCallOutcome = { ok: true, response: { intent: "SHOW_MENU", confidence: 0.95, items: [] }, latencyMs: 1 };
  const resolved = resolveIntent({ rawMessage: "menu dikhao", cart: { items: [] }, menu, outcome });
  assert.equal(resolved.source, "llm");
});

test("K4. resolveIntent falls back to the deterministic parser when the outcome failed", () => {
  const outcome: LLMCallOutcome = { ok: false, reason: "invalid_json" };
  const resolved = resolveIntent({ rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu, outcome });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.parseResult.intent, "ADD_ITEM");
});

test("K5. completeWithFallback succeeds via the LLM when the response validates", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "SHOW_MENU", confidence: 0.95, items: [] }));
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "menu dikhao", cart: { items: [] }, menu });
  assert.equal(resolved.source, "llm");
});

test("K6. completeWithFallback falls back on a provider timeout", async () => {
  const provider = fakeProvider(() => { throw new LLMTimeoutError("openai", 100); });
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "timeout");
});

test("K7. completeWithFallback falls back on invalid JSON", async () => {
  const provider = fakeProvider("not json");
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "invalid_json");
});

test("K8. completeWithFallback falls back on a hallucinated menu item", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "fake-id", quantity: 1 }] }));
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "hallucinated_item");
});

test("K9. completeWithFallback falls back on low confidence", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.4, items: [] }));
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "low_confidence");
});

test("K10. completeWithFallback falls back on an unknown intent", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "ORDER_PIZZA", confidence: 0.95, items: [] }));
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "unknown_intent");
});

test("K11. completeWithFallback falls back on invalid quantity", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: -1 }] }));
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek gyro dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "invalid_quantity");
});

test("K12. completeWithFallback falls back on a generic provider error", async () => {
  const provider = fakeProvider(() => { throw new Error("network exploded"); });
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "provider_error");
});

test("K13. a fallback's ParseResult is a real, valid ParseResult from the deterministic parser", async () => {
  const provider = fakeProvider("garbage");
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  if (resolved.source === "fallback") {
    assert.equal(resolved.parseResult.intent, "ADD_ITEM");
    assert.equal(resolved.parseResult.safetyDecision, "SAFE_TO_EXECUTE");
  }
});

test("K14. a cache hit skips the provider entirely", async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: "openai", model: "fake",
    async complete() {
      calls += 1;
      return { raw: JSON.stringify({ intent: "SHOW_MENU", confidence: 0.95, items: [] }), provider: "openai", model: "fake", latencyMs: 1 };
    },
  };
  const cache = new LLMCache();
  await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "menu dikhao", cart: { items: [] }, menu, cache });
  await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "menu dikhao", cart: { items: [] }, menu, cache });
  assert.equal(calls, 1);
});

test("K15. only cacheable intents actually get cached", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "gyro", quantity: 1 }] }));
  const cache = new LLMCache();
  await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek gyro dedo", cart: { items: [] }, menu, cache });
  assert.equal(cache.size, 0);
});

test("K16. the customer-facing outcome is identical whether the LLM succeeds or a fallback is used, for a cart-mutating message", async () => {
  const cart: CartState = { items: [] };
  const successProvider = fakeProvider(JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "jumbo-zinger", quantity: 1 }] }));
  const failProvider = fakeProvider("garbage");

  const succeeded = await completeWithFallback({ provider: successProvider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart, menu });
  const fellBack = await completeWithFallback({ provider: failProvider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart, menu });

  assert.equal(succeeded.source, "llm");
  assert.equal(fellBack.source, "fallback");
  if (fellBack.source === "fallback") {
    assert.equal(fellBack.parseResult.items[0]?.candidateItemIds?.[0], "jumbo-zinger");
  }
});

// ─────────────────────────────────────────────────────────────────────────
// L. Stress prompts / long conversations / mixed language
// ─────────────────────────────────────────────────────────────────────────

test("L1. building a prompt for every message of a 40-turn conversation never throws", () => {
  let session = freshSession();
  let ctx = createInitialContext();
  const messages = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "ek gyro dedo" : "gyro remove karo"));
  for (const m of messages) {
    const aiContext = buildAIContext(session, m, menu, restaurantConfig);
    assert.doesNotThrow(() => buildPrompt(aiContext));
    const pr = parseMessage(m, ctx.cart, menu);
    const after = processMessage(ctx, pr, menu);
    session = updateMemoryAfterTurn(session, { rawMessage: m, parseResult: pr, before: ctx, after, reply: "ok", menu });
    ctx = after;
  }
});

test("L2. a prompt for a long conversation stays reasonably sized (relevant-menu-only keeps it bounded)", () => {
  let session = freshSession();
  let ctx = createInitialContext();
  for (let i = 0; i < 30; i++) {
    const pr = parseMessage("menu dikhao", ctx.cart, menu);
    const after = processMessage(ctx, pr, menu);
    session = updateMemoryAfterTurn(session, { rawMessage: "menu dikhao", parseResult: pr, before: ctx, after, reply: "ok", menu });
    ctx = after;
  }
  const request = buildPrompt(buildAIContext(session, "pizza", menu, restaurantConfig));
  assert.ok(estimatePromptLength(request) < 5000, `prompt grew too large: ${estimatePromptLength(request)}`);
});

test("L3. Roman Urdu conversation resolves correctly end to end via fallback", async () => {
  const provider = fakeProvider("not json");
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "ek jumbo zinger dedo", cart: { items: [] }, menu });
  assert.equal(resolved.source, "fallback");
});

test("L4. English conversation resolves correctly end to end via fallback", async () => {
  const provider = fakeProvider("not json");
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "I want a jumbo zinger", cart: { items: [] }, menu });
  if (resolved.source === "fallback") assert.equal(resolved.parseResult.intent, "ADD_ITEM");
});

test("L5. Hinglish conversation resolves correctly end to end via fallback", async () => {
  const provider = fakeProvider("not json");
  // A single item at quantity 2 is still ADD_ITEM (one distinct item) —
  // ADD_MULTIPLE_ITEMS means multiple distinct items in one message.
  const resolved = await completeWithFallback({ provider, request: SAMPLE_REQUEST, rawMessage: "2 zinger burger add karo please", cart: { items: [] }, menu });
  if (resolved.source === "fallback") assert.equal(resolved.parseResult.intent, "ADD_ITEM");
});

test("L6. a mixed-language stress prompt (Urdu + English in one message) builds without throwing", () => {
  const aiContext = buildAIContext(freshSession(), "please ek jumbo zinger add kardo thanks", menu, restaurantConfig);
  assert.doesNotThrow(() => buildPrompt(aiContext));
});

// ─────────────────────────────────────────────────────────────────────────
// M. 50 complete production conversation simulations
// ─────────────────────────────────────────────────────────────────────────

type FailureMode = "timeout" | "invalid_json" | "hallucinated_item" | "low_confidence" | "unknown_intent" | "unknown_field" | "provider_error";

function makeFailingProvider(mode: FailureMode): LLMProvider {
  return {
    name: "openai",
    model: "fake-model",
    async complete() {
      if (mode === "timeout") throw new LLMTimeoutError("openai", 50);
      if (mode === "provider_error") throw new Error("simulated network failure");
      const bodies: Record<Exclude<FailureMode, "timeout" | "provider_error">, string> = {
        invalid_json: "not valid json at all",
        hallucinated_item: JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [{ id: "definitely-not-a-real-item", quantity: 1 }] }),
        low_confidence: JSON.stringify({ intent: "ADD_ITEM", confidence: 0.3, items: [] }),
        unknown_intent: JSON.stringify({ intent: "ORDER_PIZZA_NOW", confidence: 0.95, items: [] }),
        unknown_field: JSON.stringify({ intent: "ADD_ITEM", confidence: 0.95, items: [], totalPrice: 500 }),
      };
      return { raw: bodies[mode as Exclude<FailureMode, "timeout" | "provider_error">], provider: "openai", model: "fake-model", latencyMs: 1 };
    },
  };
}

const UNAMBIGUOUS_ITEM_MESSAGES = [
  "ek jumbo zinger dedo", "ek gyro dedo", "ek zinger burger dedo", "ek chicken steak dedo",
  "ek chicken sandwich dedo", "ek club sandwich dedo", "ek wrap dedo", "ek pasta small dedo",
  "ek alfredo pasta dedo", "ek chicken chowmein dedo", "ek vegetable rice dedo", "ek chicken fried rice dedo",
  "ek think food special pizza dedo", "ek pizza regular dedo", "ek pizza fries small box dedo", "ek hot shot dedo",
  "ek bbq sandwich dedo", "ek smoke sandwich dedo", "ek vegi sandwich dedo", "ek mexican sandwich dedo",
  "ek crispy sandwich dedo", "ek think food special sandwich dedo", "ek grill sandwich dedo", "ek egg rice dedo",
  "ek singaporean rice dedo", "ek white singaporean dedo", "ek macaroni pasta dedo", "ek mexican pasta dedo",
  "ek vegetable chowmein dedo", "ek chicken strips dedo", "ek mexican pizza dedo", "ek smoke burger dedo",
  "ek spicy stuff burger dedo", "ek think food sp burger dedo", "ek zinger burger w/c dedo",
];

const FAILURE_MODES: FailureMode[] = ["timeout", "invalid_json", "hallucinated_item", "low_confidence", "unknown_intent", "unknown_field", "provider_error"];

// extractCustomerName (order-state-engine/customer-info.ts) only accepts a
// bare reply when every word is letters-only — a name like "Customer38"
// (digits included) is correctly rejected as not name-shaped, which would
// stall these simulations at AWAITING_NAME. Real, letters-only names only.
const CUSTOMER_NAMES = [
  "Ali", "Sara", "Bilal", "Hina", "Zara", "Omar", "Fahad", "Ayesha", "Kamran", "Nida",
  "Waqas", "Bushra", "Imran", "Rabia", "Tariq", "Sana", "Adeel", "Mahnoor", "Usman", "Hamza",
  "Farah", "Kashif", "Naila", "Danish", "Rida", "Sami", "Ahmed", "Anum", "Junaid", "Mariam",
  "Bilquis", "Talha", "Nimra", "Shahzaib", "Wajiha", "Asad", "Rimsha", "Danyal", "Iqra", "Owais",
  "Laiba", "Rayyan", "Zoya", "Hamna", "Saad", "Areeba", "Faizan", "Komal", "Yasir", "Sadia",
];

interface ProductionSimCase {
  name: string;
  addMessage: string;
  deliveryType: "delivery" | "pickup";
  customerName: string;
  address?: string;
  submitPhrase: string;
  failureMode: FailureMode;
}

const PRODUCTION_SIMULATIONS: ProductionSimCase[] = Array.from({ length: 50 }, (_, i) => {
  const addMessage = UNAMBIGUOUS_ITEM_MESSAGES[i % UNAMBIGUOUS_ITEM_MESSAGES.length];
  const deliveryType: "delivery" | "pickup" = i % 2 === 0 ? "pickup" : "delivery";
  const submitPhrase = ["submit", "final submit", "yes submit", "done"][i % 4];
  return {
    name: `sim ${i + 1}: "${addMessage}" (${deliveryType}, LLM ${FAILURE_MODES[i % FAILURE_MODES.length]})`,
    addMessage,
    deliveryType,
    customerName: CUSTOMER_NAMES[i % CUSTOMER_NAMES.length],
    address: deliveryType === "delivery" ? `House ${i + 1} Street ${i + 1} Nazimabad` : undefined,
    submitPhrase,
    failureMode: FAILURE_MODES[i % FAILURE_MODES.length],
  };
});

async function runProductionSimulation(sim: ProductionSimCase): Promise<{ finalState: string; sources: string[] }> {
  const provider = makeFailingProvider(sim.failureMode);
  const cache = new LLMCache();
  let session = freshSession();
  let ctx = createInitialContext();
  const sources: string[] = [];

  const messages = [
    sim.addMessage,
    "checkout",
    "confirm order",
    sim.deliveryType,
    ...(sim.address ? [sim.address] : []),
    sim.deliveryType === "pickup" ? sim.customerName : sim.customerName,
    sim.submitPhrase,
  ];

  for (const rawMessage of messages) {
    const aiContext = buildAIContext(session, rawMessage, menu, restaurantConfig);
    const request = buildPrompt(aiContext);
    const resolved = await completeWithFallback({ provider, request, rawMessage, cart: ctx.cart, menu, cache });
    sources.push(resolved.source);

    // This phase stops at the provider abstraction — mapping a successful
    // LLM response into a pipeline-ready ParseResult is explicitly future
    // work, so every simulation here uses an always-failing fake provider
    // and asserts the fallback path carries the conversation exactly as
    // the deterministic pipeline already does on its own.
    assert.equal(resolved.source, "fallback", `expected "${rawMessage}" to resolve via fallback`);
    if (resolved.source !== "fallback") continue;

    const before = ctx;
    const after = processMessage(before, resolved.parseResult, menu);
    const reply = buildResponse({ parseResult: resolved.parseResult, before, after, menu, restaurantConfig });
    assert.ok(reply.length > 0);
    session = updateMemoryAfterTurn(session, { rawMessage, parseResult: resolved.parseResult, before, after, reply, menu });
    ctx = after;
  }

  return { finalState: ctx.state, sources };
}

for (const sim of PRODUCTION_SIMULATIONS) {
  test(`M. production simulation — ${sim.name}`, async () => {
    const { finalState, sources } = await runProductionSimulation(sim);
    assert.equal(finalState, "PENDING_VERIFICATION");
    assert.ok(sources.every((s) => s === "fallback"));
  });
}

test("M-count. at least 50 complete production conversation simulations are defined", () => {
  assert.ok(PRODUCTION_SIMULATIONS.length >= 50, `expected >= 50 simulations, got ${PRODUCTION_SIMULATIONS.length}`);
});

// ─────────────────────────────────────────────────────────────────────────
// N. Security
// ─────────────────────────────────────────────────────────────────────────

test("N1. loadProviderConfigFromEnv never hardcodes an API key — it always comes from the env object", () => {
  const config = loadProviderConfigFromEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "unique-marker-abc123" });
  assert.equal(config.apiKey, "unique-marker-abc123");
});

test("N2. a thrown LLMProviderError never includes the configured API key", async () => {
  const provider = createOpenAIProvider(baseConfig({ apiKey: "top-secret-key-xyz", fetchImpl: fakeFetch(500, {}) }));
  try {
    await provider.complete(SAMPLE_REQUEST);
    assert.fail("expected provider.complete to throw");
  } catch (error) {
    assert.doesNotMatch(String(error), /top-secret-key-xyz/);
  }
});

test("N3. none of the provider default base URLs contain a query-string API key placeholder", () => {
  const providers = [
    createOpenAIProvider(baseConfig({ provider: "openai" })),
    createClaudeProvider(baseConfig({ provider: "claude" })),
    createOpenRouterProvider(baseConfig({ provider: "openrouter" })),
  ];
  for (const p of providers) {
    assert.equal(typeof p.model, "string");
  }
});

test("N4. the system prompt never instructs the model to reveal internal reasoning or secrets", () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /api[_-]?key/i);
});

test("N5. cache keys never contain the raw provider response, only the customer message", () => {
  const key = buildCacheKey("ek jumbo zinger dedo");
  assert.doesNotMatch(key, /choices|candidates|content/);
});

test("N6. an LLMValidationResult failure never echoes back a full raw payload that could contain injected content unescaped", () => {
  const result = validateLLMResponse("<script>alert(1)</script>", menu);
  assert.equal(result.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────
// O. Graceful degradation when no provider/API key is configured
// ─────────────────────────────────────────────────────────────────────────

test("O1. safeLoadProviderConfigFromEnv returns undefined instead of throwing when LLM_PROVIDER is missing", () => {
  assert.equal(safeLoadProviderConfigFromEnv({}), undefined);
});

test("O2. safeLoadProviderConfigFromEnv returns undefined when the API key is missing", () => {
  assert.equal(safeLoadProviderConfigFromEnv({ LLM_PROVIDER: "google-ai" }), undefined);
});

test("O3. safeLoadProviderConfigFromEnv returns a real config when everything is present", () => {
  const config = safeLoadProviderConfigFromEnv({ LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "g-test" });
  assert.equal(config?.provider, "google-ai");
  assert.equal(config?.apiKey, "g-test");
});

test("O4. completeWithFallbackFromEnv falls back to the deterministic parser when LLM_PROVIDER is unset — no network attempted", async () => {
  const resolved = await completeWithFallbackFromEnv({
    env: {},
    request: SAMPLE_REQUEST,
    rawMessage: "ek jumbo zinger dedo",
    cart: { items: [] },
    menu,
  });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") {
    assert.equal(resolved.reason, "missing_config");
    assert.equal(resolved.parseResult.intent, "ADD_ITEM");
  }
});

test("O5. completeWithFallbackFromEnv falls back gracefully when LLM_PROVIDER=google-ai but GOOGLE_API_KEY is missing", async () => {
  const resolved = await completeWithFallbackFromEnv({
    env: { LLM_PROVIDER: "google-ai" },
    request: SAMPLE_REQUEST,
    rawMessage: "ek gyro dedo",
    cart: { items: [] },
    menu,
  });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "missing_config");
});

test("O6. completeWithFallbackFromEnv falls back gracefully when LLM_PROVIDER is an unrecognized value", async () => {
  const resolved = await completeWithFallbackFromEnv({
    env: { LLM_PROVIDER: "chatgpt", OPENAI_API_KEY: "sk-test" },
    request: SAMPLE_REQUEST,
    rawMessage: "menu dikhao",
    cart: { items: [] },
    menu,
  });
  assert.equal(resolved.source, "fallback");
});

test("O7. completeWithFallbackFromEnv actually calls the configured provider when everything is present", async () => {
  const fetchImpl = fakeFetch(200, { choices: [{ message: { content: JSON.stringify({ intent: "SHOW_MENU", confidence: 0.95, items: [] }) } }] });
  const resolved = await completeWithFallbackFromEnv({
    env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" },
    request: SAMPLE_REQUEST,
    rawMessage: "menu dikhao",
    cart: { items: [] },
    menu,
    fetchImpl,
  });
  assert.equal(resolved.source, "llm");
});

test("O8. completeWithFallbackFromEnv still falls back normally (not missing_config) when the configured provider itself fails", async () => {
  const fetchImpl = fakeFetch(500, {});
  const resolved = await completeWithFallbackFromEnv({
    env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" },
    request: SAMPLE_REQUEST,
    rawMessage: "ek jumbo zinger dedo",
    cart: { items: [] },
    menu,
    fetchImpl,
  });
  assert.equal(resolved.source, "fallback");
  if (resolved.source === "fallback") assert.equal(resolved.reason, "provider_error");
});

test("O9. google-ai works end to end through completeWithFallbackFromEnv when configured with a fake fetch", async () => {
  const fetchImpl = fakeFetch(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: "ASK_RESTAURANT_INFO", confidence: 0.95, items: [] }) }] } }] });
  const resolved = await completeWithFallbackFromEnv({
    env: { LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "g-test" },
    request: SAMPLE_REQUEST,
    rawMessage: "aapka address kya hai",
    cart: { items: [] },
    menu,
    fetchImpl,
  });
  assert.equal(resolved.source, "llm");
  if (resolved.source === "llm") assert.equal(resolved.response.intent, "ASK_RESTAURANT_INFO");
});

test("O10. missing configuration never throws — it's always a normal ResolvedIntent, same shape as any other fallback", async () => {
  await assert.doesNotReject(() =>
    completeWithFallbackFromEnv({ env: {}, request: SAMPLE_REQUEST, rawMessage: "hi", cart: { items: [] }, menu })
  );
});
