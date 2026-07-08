// AI Gateway — tests.
//
// Covers provider priority (Gemini -> Groq -> OpenRouter -> deterministic
// V2 fallback signal), cooldown behavior per failure kind (429/timeout/5xx),
// metrics tracking, provider-order configuration, graceful degradation when
// keys are missing, and that V3 routes through the gateway rather than
// calling a provider directly.
//
// Same fake-fetch convention as the rest of this codebase (tests/v3/agent.
// test.ts, tests/v2/llm.test.ts): a scripted fetchImpl, dispatched by URL,
// returns exactly what each provider's real REST API would return — no
// network call, no flakiness.
//
// Run with: npx tsx --test tests/ai-gateway/ai-gateway.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callAIGateway,
  getProviderOrder,
  getMetrics,
  resetMetrics,
  resetAllCooldowns,
  isProviderInCooldown,
  getGatewayStatus,
} from "../../ai-gateway";
import type { FetchLike } from "../../v2/llm/types";
import { callAgent } from "../../v3/agent/llm-call";
import { createAgentSession } from "../../v3/agent/context";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

beforeEach(() => {
  resetAllCooldowns();
  resetMetrics();
});

// ─── Fake transports, one per provider's real response envelope ────────────

// Real Response objects always implement BOTH .json() and .text() — the
// gateway's failure path reads .text() to build a safe diagnostic error
// message, so these fakes need to match that real shape.
function geminiResponse(text: string, status = 200, errorBody?: unknown): Response {
  const body = status < 400
    ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }
    : (errorBody ?? { error: { code: status, message: `Simulated Gemini failure ${status}`, status: "FAILED" } });
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function openAIStyleResponse(text: string, status = 200, errorBody?: unknown): Response {
  const body = status < 400
    ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
    : (errorBody ?? { error: { message: `Simulated failure ${status}`, type: "simulated_error" } });
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type ProviderScript = "timeout" | { text: string; status?: number };

// Dispatches by URL so a single fetchImpl can answer for all 3 providers in
// one gateway call — exactly what a real failover sequence does.
function scriptedGatewayFetch(scripts: { gemini?: ProviderScript; groq?: ProviderScript; openrouter?: ProviderScript }): {
  fetchImpl: FetchLike;
  calls: () => string[];
} {
  const calledUrls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calledUrls.push(url);
    let script: ProviderScript | undefined;
    let isGemini = false;
    if (url.includes("generativelanguage.googleapis.com")) {
      script = scripts.gemini;
      isGemini = true;
    } else if (url.includes("api.groq.com")) {
      script = scripts.groq;
    } else if (url.includes("openrouter.ai")) {
      script = scripts.openrouter;
    }

    if (script === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (!script) throw new Error(`No script configured for URL: ${url}`);
    return isGemini ? geminiResponse(script.text, script.status) : openAIStyleResponse(script.text, script.status);
  }) as unknown as FetchLike;

  return { fetchImpl, calls: () => calledUrls };
}

const PLAN_JSON = JSON.stringify({ reply: "ok", cartActions: [], pendingClarifications: [], checkoutAction: null });

const FAST_TIMEOUT_ENV = { AI_GATEWAY_TIMEOUT_MS: "25" };

// ─── 1. Gemini success ──────────────────────────────────────────────────────

test("1. Gemini succeeds when configured first in priority order", async () => {
  const { fetchImpl, calls } = scriptedGatewayFetch({ gemini: { text: PLAN_JSON } });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: "g-key" }, fetchImpl }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, "gemini");
    assert.equal(result.text, PLAN_JSON);
    assert.deepEqual(result.fallbackChain, []);
    assert.equal(result.tokens.total, 15);
  }
  assert.equal(calls().length, 1);
});

// ─── 2. Gemini 429 then Groq success ────────────────────────────────────────

test("2. Gemini 429 falls over to Groq, which succeeds", async () => {
  const { fetchImpl, calls } = scriptedGatewayFetch({
    gemini: { text: "", status: 429 },
    groq: { text: PLAN_JSON },
  });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: "g-key", GROQ_API_KEY: "groq-key" }, fetchImpl }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, "groq");
    assert.deepEqual(result.fallbackChain, ["gemini:429"]);
  }
  assert.equal(calls().length, 2);
});

// ─── 3. Gemini missing key then Groq success ────────────────────────────────

test("3. Gemini has no key configured (DISABLED, skipped silently) and Groq succeeds", async () => {
  const { fetchImpl, calls } = scriptedGatewayFetch({ groq: { text: PLAN_JSON } });
  const result = await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: { GROQ_API_KEY: "groq-key" }, fetchImpl });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, "groq");
    // A DISABLED (unconfigured) provider is never counted as an attempt —
    // fallbackChain only records providers that were actually tried.
    assert.deepEqual(result.fallbackChain, []);
  }
  assert.equal(calls().length, 1);
  assert.equal(getGatewayStatus({ GROQ_API_KEY: "groq-key" }).gemini, "DISABLED");
});

// ─── 4. Gemini 429 cooldown prevents second Gemini call ────────────────────

test("4. a 429 puts Gemini into cooldown; a second gateway call skips it without a network attempt", async () => {
  const first = scriptedGatewayFetch({ gemini: { text: "", status: 429 }, groq: { text: PLAN_JSON } });
  const env = { GEMINI_API_KEY: "g-key", GROQ_API_KEY: "groq-key" };
  const r1 = await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env, fetchImpl: first.fetchImpl });
  assert.equal(r1.ok, true);
  assert.equal(isProviderInCooldown("gemini"), true);

  // Second call: if the gateway called Gemini again it would throw (no
  // script registered for gemini this time) — proving Gemini is skipped.
  const second = scriptedGatewayFetch({ groq: { text: PLAN_JSON } });
  const r2 = await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env, fetchImpl: second.fetchImpl });
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.provider, "groq");
    assert.deepEqual(r2.fallbackChain, ["gemini:cooldown"]);
  }
});

test("4b. after the cooldown window expires, Gemini can be tried again", async () => {
  const { fetchImpl } = scriptedGatewayFetch({ gemini: { text: "", status: 429 } });
  await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: { GEMINI_API_KEY: "g-key" }, fetchImpl });
  assert.equal(isProviderInCooldown("gemini", Date.now()), true);
  // 61 seconds later (past the 60s rate-limit cooldown) it's clear again.
  assert.equal(isProviderInCooldown("gemini", Date.now() + 61_000), false);
});

// ─── 5. Groq fail then OpenRouter success ──────────────────────────────────

test("5. Gemini disabled, Groq fails (5xx), OpenRouter succeeds", async () => {
  const { fetchImpl, calls } = scriptedGatewayFetch({
    groq: { text: "", status: 503 },
    openrouter: { text: PLAN_JSON },
  });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GROQ_API_KEY: "groq-key", OPENROUTER_API_KEY: "or-key" }, fetchImpl }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, "openrouter");
    assert.deepEqual(result.fallbackChain, ["groq:503"]);
  }
  assert.equal(calls().length, 2);
});

// ─── 6. All providers fail -> gateway returns ok:false ──────────────────────

test("6. every configured provider failing returns a clean ok:false with the full fallback chain", async () => {
  const { fetchImpl } = scriptedGatewayFetch({
    gemini: { text: "", status: 429 },
    groq: { text: "", status: 500 },
    openrouter: { text: "", status: 401 },
  });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "gr", OPENROUTER_API_KEY: "or" }, fetchImpl }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.provider, null);
    assert.equal(result.error, "all_providers_failed");
    assert.deepEqual(result.fallbackChain, ["gemini:429", "groq:500", "openrouter:401"]);
  }
});

// ─── 7. Missing all keys never crashes ──────────────────────────────────────

test("7. no provider configured at all returns ok:false without throwing or making a network call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    throw new Error("should never be called");
  }) as unknown as FetchLike;

  const result = await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: {}, fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "all_providers_failed");
    assert.deepEqual(result.fallbackChain, []);
  }
  assert.equal(called, false);
});

// ─── 8. Provider order config works ─────────────────────────────────────────

test("8. AI_PROVIDER_ORDER reorders which provider is tried first", async () => {
  assert.deepEqual(getProviderOrder({}), ["gemini", "groq", "openrouter"]);
  assert.deepEqual(getProviderOrder({ AI_PROVIDER_ORDER: "groq,openrouter,gemini" }), ["groq", "openrouter", "gemini"]);
  // Unknown/malformed entries are dropped, not thrown.
  assert.deepEqual(getProviderOrder({ AI_PROVIDER_ORDER: "groq,bogus,groq,gemini" }), ["groq", "gemini"]);

  const { fetchImpl, calls } = scriptedGatewayFetch({ groq: { text: PLAN_JSON }, gemini: { text: PLAN_JSON } });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { AI_PROVIDER_ORDER: "groq,gemini", GROQ_API_KEY: "groq-key", GEMINI_API_KEY: "g-key" }, fetchImpl }
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.provider, "groq");
  assert.equal(calls().length, 1);
  assert.ok(calls()[0].includes("api.groq.com"));
});

// ─── 9. Metrics update correctly ────────────────────────────────────────────

test("9. metrics track calls/success/429/timeout/failure/latency/fallback per provider", async () => {
  const success = scriptedGatewayFetch({ gemini: { text: PLAN_JSON } });
  await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: { GEMINI_API_KEY: "g" }, fetchImpl: success.fetchImpl });

  const rateLimited = scriptedGatewayFetch({ gemini: { text: "", status: 429 }, groq: { text: PLAN_JSON } });
  await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "gr" }, fetchImpl: rateLimited.fetchImpl }
  );

  const metrics = getMetrics();
  assert.equal(metrics.providers.gemini.calls, 2);
  assert.equal(metrics.providers.gemini.success, 1);
  assert.equal(metrics.providers.gemini.rateLimited, 1);
  assert.equal(metrics.providers.groq.calls, 1);
  assert.equal(metrics.providers.groq.success, 1);
  assert.ok(metrics.providers.gemini.averageLatencyMs >= 0);
  // Call 1 was a clean Gemini win (no fallback); call 2 fell over to Groq.
  assert.equal(metrics.fallbackCount, 1);
});

test("9b. a timeout is bucketed as a timeout, not a generic failure, and cools down for 30s", async () => {
  const { fetchImpl } = scriptedGatewayFetch({ gemini: "timeout", groq: { text: PLAN_JSON } });
  const result = await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "gr", ...FAST_TIMEOUT_ENV }, fetchImpl }
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.fallbackChain, ["gemini:timeout"]);
  assert.equal(getMetrics().providers.gemini.timeouts, 1);
  assert.equal(isProviderInCooldown("gemini"), true);
});

// ─── 10. V3 uses the AI Gateway, never a direct provider call ─────────────

test("10a. v3/agent/llm-call.ts imports only the AI Gateway, never a provider module directly", () => {
  const source = readFileSync(join(__dirname, "../../v3/agent/llm-call.ts"), "utf8");
  assert.ok(source.includes('"../../ai-gateway"'), "expected llm-call.ts to import from the ai-gateway module");
  assert.equal(/v2\/llm\/(provider|gemini|openai|claude|openrouter|google-ai)/.test(source), false);
  assert.equal(source.includes("createProvider("), false);
});

test("10b. callAgent (the real V3 call site) resolves through the gateway's Groq path end-to-end", async () => {
  const { fetchImpl, calls } = scriptedGatewayFetch({ groq: { text: PLAN_JSON } });
  const session = createAgentSession("conv", "sess");
  const outcome = await callAgent(
    { session, menu, restaurantConfig, customerMessage: "hello" },
    { env: { GROQ_API_KEY: "groq-key" }, fetchImpl }
  );
  assert.equal(outcome.attempted, true);
  assert.ok(outcome.plan);
  assert.equal(calls().length, 1);
  assert.ok(calls()[0].includes("api.groq.com"));
});
