// AI Gateway — provider-failure diagnostics tests.
//
// Covers the audit's required logging: every provider failure prints one
// safe, structured [ai-gateway:diagnostic] record (provider/model/status/
// safe error message/timeoutMs/attempt count/cooldown before+after/API-key-
// present/baseUrl) and NEVER the raw API key value, even when a provider's
// own error body happens to echo something back. Same scripted-fetch
// convention as ai-gateway.test.ts — no network call, no flakiness.
//
// Run with: npx tsx --test tests/ai-gateway/diagnostics.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callAIGateway, resetAllCooldowns, resetMetrics } from "../../ai-gateway";
import type { FetchLike } from "../../v2/llm/types";

beforeEach(() => {
  resetAllCooldowns();
  resetMetrics();
});

// Realistic-length fake keys — long enough that the redaction logic
// actually engages (a 1-2 character placeholder would never appear
// unintentionally, so it wouldn't prove anything about real-key safety).
const GEMINI_KEY = "AIzaSyFAKE_TEST_KEY_1234567890abcdefGHIJ";
const GROQ_KEY = "gsk_FAKE_TEST_KEY_1234567890abcdefGHIJKLMN";
const OPENROUTER_KEY = "sk-or-v1-FAKE_TEST_KEY_1234567890abcdefGHIJ";

let originalConsoleLog: typeof console.log;
let originalLogLevel: string | undefined;
let capturedLines: string[];

beforeEach(() => {
  originalConsoleLog = console.log;
  capturedLines = [];
  console.log = (...args: unknown[]) => {
    capturedLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  // The [ai-gateway:diagnostic] record is debug-level (lib/logger.ts) since
  // production shouldn't print a full per-failure JSON dump by default —
  // this suite is specifically about that record's content, so it opts
  // into debug verbosity for its own duration.
  originalLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
});

afterEach(() => {
  console.log = originalConsoleLog;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

function diagnosticRecords(): Record<string, unknown>[] {
  return capturedLines
    .filter((line) => line.startsWith("[ai-gateway:diagnostic]"))
    .map((line) => JSON.parse(line.slice("[ai-gateway:diagnostic] ".length)));
}

function geminiErrorResponse(status: number, message: string): Response {
  const body = { error: { code: status, message, status: "FAILED" } };
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function openAIStyleErrorResponse(status: number, message: string): Response {
  const body = { error: { message, type: "error" } };
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

// ─── 1. Fake Gemini 429 logs the safe reason ───────────────────────────────

test("1. a fake Gemini 429 logs a full, safe diagnostic record", async () => {
  const fetchImpl = (async () => geminiErrorResponse(429, "Resource has been exhausted (e.g. check quota).")) as unknown as FetchLike;
  await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: { GEMINI_API_KEY: GEMINI_KEY }, fetchImpl });

  const [record] = diagnosticRecords();
  assert.ok(record, "expected a diagnostic record to be logged");
  assert.equal(record.provider, "gemini");
  assert.equal(record.model, "gemini-2.5-flash");
  assert.equal(record.httpStatus, 429);
  assert.equal(record.errorMessage, "Resource has been exhausted (e.g. check quota).");
  assert.equal(record.timeoutMs, 8000);
  assert.equal(record.attemptCount, 1);
  assert.equal(record.cooldownBefore, "ONLINE");
  assert.equal(record.cooldownAfter, "RATE_LIMITED");
  assert.equal(record.apiKeyPresent, true);
  assert.ok(typeof record.baseUrl === "string" && record.baseUrl.includes("key=***REDACTED***"));
});

// ─── 2. Fake Groq 429 logs the safe reason ─────────────────────────────────

test("2. a fake Groq 429 logs a full, safe diagnostic record", async () => {
  const fetchImpl = (async () => openAIStyleErrorResponse(429, "Rate limit reached for requests per minute.")) as unknown as FetchLike;
  await callAIGateway({ systemPrompt: "sys", userPrompt: "user" }, { env: { GROQ_API_KEY: GROQ_KEY }, fetchImpl });

  const [record] = diagnosticRecords();
  assert.ok(record);
  assert.equal(record.provider, "groq");
  assert.equal(record.model, "llama-3.3-70b-versatile");
  assert.equal(record.httpStatus, 429);
  assert.equal(record.errorMessage, "Rate limit reached for requests per minute.");
  assert.equal(record.baseUrl, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(record.apiKeyPresent, true);
  assert.equal(record.cooldownAfter, "RATE_LIMITED");
});

// ─── 3. Fake OpenRouter timeout logs the timeout detail ────────────────────

test("3. a fake OpenRouter timeout logs timeoutMs and a null httpStatus (no response ever arrived)", async () => {
  const fetchImpl = ((url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as FetchLike;

  await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { OPENROUTER_API_KEY: OPENROUTER_KEY, AI_GATEWAY_TIMEOUT_MS: "20" }, fetchImpl }
  );

  const [record] = diagnosticRecords();
  assert.ok(record);
  assert.equal(record.provider, "openrouter");
  assert.equal(record.httpStatus, null);
  assert.equal(record.timeoutMs, 20);
  assert.match(String(record.errorMessage), /timed out after 20ms/);
  assert.equal(record.cooldownAfter, "COOLDOWN");
  assert.equal(record.baseUrl, "https://openrouter.ai/api/v1/chat/completions");
});

// ─── 4. No API key is ever logged, in any field, for any provider/failure ──

test("4. the real API key never appears in ANY logged line, across every provider and failure kind", async () => {
  const scripts: { url: RegExp; status: number; message: string }[] = [
    { url: /generativelanguage/, status: 429, message: `Quota exceeded, key=${GEMINI_KEY} rejected` },
    { url: /api\.groq\.com/, status: 401, message: `Invalid API key: ${GROQ_KEY}` },
    { url: /openrouter\.ai/, status: 403, message: `Forbidden for key ${OPENROUTER_KEY}` },
  ];
  const fetchImpl = (async (url: string) => {
    const script = scripts.find((s) => s.url.test(url));
    if (!script) throw new Error(`unexpected URL ${url}`);
    return script.status === 429 || script.status === 401 || script.status === 403
      ? url.includes("generativelanguage")
        ? geminiErrorResponse(script.status, script.message)
        : openAIStyleErrorResponse(script.status, script.message)
      : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
  }) as unknown as FetchLike;

  await callAIGateway(
    { systemPrompt: "sys", userPrompt: "user" },
    { env: { GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY }, fetchImpl }
  );

  const fullLog = capturedLines.join("\n");
  assert.doesNotMatch(fullLog, new RegExp(GEMINI_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(fullLog, new RegExp(GROQ_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(fullLog, new RegExp(OPENROUTER_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Sanity: this actually exercised all 3 provider failures, so the
  // assertions above aren't vacuously true.
  const records = diagnosticRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.provider), ["gemini", "groq", "openrouter"]);
  // The error-message-echoing-the-key case is exactly what the second-pass
  // redaction (failover.ts, over the whole serialized record) exists for —
  // prove the message itself was cleaned, not just absent by chance.
  assert.match(String(records[0].errorMessage), /Quota exceeded, key=\*\*\*REDACTED\*\*\* rejected/);
  assert.match(String(records[1].errorMessage), /Invalid API key: \*\*\*REDACTED\*\*\*/);
  assert.match(String(records[2].errorMessage), /Forbidden for key \*\*\*REDACTED\*\*\*/);
});
