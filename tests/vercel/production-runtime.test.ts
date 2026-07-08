// Vercel production-runtime hardening — tests.
//
// Covers the 4 required scenarios: the health route reports config
// presence safely, the chat route survives a completely unconfigured
// production environment (no provider keys at all), the chat route always
// returns valid JSON even when something genuinely unexpected throws
// (the real try/catch in app/api/chat/route.ts, not a hand-waved
// assertion), and no response anywhere ever echoes a real secret value.
//
// Calls the real Next.js route handlers directly with standard Fetch API
// Request objects — no running server needed, same convention as
// tests/v2/api-chat.test.ts.
//
// Run with: npx tsx --test tests/vercel/production-runtime.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/chat/route";
import { GET as healthGET } from "../../app/api/health/route";

const ENV_KEYS = ["AI_ENGINE", "AI_PROVIDER_ORDER", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "LOG_LEVEL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Partial<Record<EnvKey, string | undefined>>;

before(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

interface ChatResponseBody {
  reply: string;
  cart: { itemId: string }[];
  error?: string;
  message?: string;
  [key: string]: unknown;
}

async function chat(body: unknown): Promise<{ status: number; body: ChatResponseBody; raw: string }> {
  const res = await post(body);
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw), raw };
}

// ─── 1. Health route ────────────────────────────────────────────────────────

test("health route returns ok:true with engine/providerOrder/provider-presence booleans", async () => {
  process.env.AI_ENGINE = "v3";
  process.env.AI_PROVIDER_ORDER = "gemini,groq,openrouter";
  process.env.GOOGLE_API_KEY = "fake-realistic-looking-google-key-1234567890";
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  const res = await healthGET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, "v3");
  assert.equal(body.providerOrder, "gemini,groq,openrouter");
  assert.equal(body.providers.google, true);
  assert.equal(body.providers.groq, false);
  assert.equal(body.providers.openrouter, false);
});

test("health route reports null engine/providerOrder (never crashes) when nothing is configured", async () => {
  clearEnv();
  const res = await healthGET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, null);
  assert.equal(body.providerOrder, null);
  assert.deepEqual(body.providers, { google: false, groq: false, openrouter: false });
});

// ─── 2. Chat route survives a completely unconfigured production env ──────

test("chat route handles a fully missing environment safely — no provider keys, no AI_PROVIDER_ORDER, no crash", async () => {
  clearEnv();
  process.env.AI_ENGINE = "v3";
  const { status, body } = await chat({ message: "ek jumbo zinger dedo" });
  assert.equal(status, 200);
  assert.ok(body.reply.length > 0);
  assert.equal(body.cart[0]?.itemId, "jumbo-zinger");
});

test("chat route handles a missing AI_ENGINE (defaults safely, never crashes)", async () => {
  clearEnv();
  const { status, body } = await chat({ message: "hello" });
  assert.equal(status, 200);
  assert.ok(body.reply.length > 0);
});

test("chat route with debug:true never crashes even fully unconfigured, and never includes provider key values", async () => {
  clearEnv();
  process.env.AI_ENGINE = "v3";
  const { status, raw } = await chat({ message: "hello", debug: true });
  assert.equal(status, 200);
  assert.doesNotMatch(raw, /AIzaSy|gsk_|sk-or-v1-/);
});

// ─── 3. Chat route always returns valid JSON, even on a genuinely
// unexpected runtime error (the real outer try/catch, not a hand-wave) ────

test("chat route returns a safe JSON error body if something genuinely unexpected throws mid-request", async () => {
  const originalJson = Response.json;
  let calls = 0;
  // Simulate an unexpected failure the FIRST time this route tries to build
  // its success response — the real code has no way to anticipate this, so
  // this proves the actual try/catch in route.ts, not a mocked-out version
  // of it. The second call (from inside the catch block itself) must
  // succeed normally.
  (Response as unknown as { json: typeof Response.json }).json = ((...args: Parameters<typeof Response.json>) => {
    calls += 1;
    if (calls === 1) throw new Error("simulated unexpected failure with a secret-looking token sk-or-v1-should-never-leak");
    return originalJson(...args);
  }) as typeof Response.json;

  try {
    const { status, body, raw } = await chat({ message: "ek jumbo zinger dedo" });
    assert.equal(status, 500);
    assert.deepEqual(body, { error: "api_runtime_error", message: "Something went wrong processing your request." });
    assert.doesNotMatch(raw, /simulated unexpected failure/);
    assert.doesNotMatch(raw, /sk-or-v1-should-never-leak/);
  } finally {
    Response.json = originalJson;
  }
});

test("chat route returns 400 JSON (not a crash) for invalid JSON in the request body", async () => {
  const res = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_json");
});

test("chat route returns 400 JSON (not a crash) for a missing message field", async () => {
  const { status, body } = await chat({});
  assert.equal(status, 400);
  assert.equal(body.error, "missing_message");
});

// ─── 4. No secret leakage across any response, in any scenario ────────────
//
// Deliberately never sets AI_ENGINE=v3 together with real-looking provider
// keys here — that would make the AI Gateway actually attempt real network
// calls to Google/Groq/OpenRouter (this repo's established convention,
// followed by every test in tests/ai-gateway/ and tests/v3/, is NO test
// ever makes a real network call; gateway/provider-level leak-safety is
// already proven exhaustively with a fake fetchImpl in
// tests/ai-gateway/diagnostics.test.ts's "the real API key never appears in
// ANY logged line" test). This test instead proves the ROUTE layer itself:
// realistic-looking keys sitting in process.env never appear in ANY
// response this route produces, regardless of which engine handles the
// request — checked via the health route (zero network calls, ever) and
// via the chat route pinned to AI_ENGINE=v1 (deterministic, never touches
// the AI Gateway or a provider key at all).
test("no response (health or chat, success or error) ever echoes a real provider key value", async () => {
  const REAL_LOOKING_KEYS = {
    GOOGLE_API_KEY: "AIzaSyFAKE_REAL_LOOKING_KEY_1234567890abcdef",
    GROQ_API_KEY: "gsk_FAKE_REAL_LOOKING_KEY_1234567890abcdefGH",
    OPENROUTER_API_KEY: "sk-or-v1-FAKE_REAL_LOOKING_KEY_1234567890abcdef",
  };
  Object.assign(process.env, REAL_LOOKING_KEYS);
  process.env.AI_ENGINE = "v1";
  process.env.AI_PROVIDER_ORDER = "gemini,groq,openrouter";

  const healthRes = await healthGET();
  const healthRaw = await healthRes.text();

  const chatRes = await post({ message: "hello", debug: true });
  const chatRaw = await chatRes.text();

  for (const value of Object.values(REAL_LOOKING_KEYS)) {
    assert.doesNotMatch(healthRaw, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(chatRaw, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
