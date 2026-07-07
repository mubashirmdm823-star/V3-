// LIVE end-to-end tests for the 12 required customer-facing behaviors of
// the one-call V3 agent, driven over plain fetch() against a REAL running
// `next dev` server's real `/api/chat` route — the exact same HTTP call
// the WhatsApp simulator UI makes. This is intentionally NOT a fake-fetch
// unit test (see tests/v3/agent.test.ts for that): it proves the real
// deployed behavior against the real configured Gemini key.
//
// Requires, before running:
//   1. AI_ENGINE=v3 and a real LLM_PROVIDER/GOOGLE_API_KEY set (.env.local)
//   2. `npm run dev` already running at http://localhost:3000
//
// Run with: npm run test:e2e
//
// NOT part of `npm run test` — that suite must stay fast, deterministic,
// and runnable with no server/network/API key, same as every other suite
// in this repo. LLM wording varies turn to turn, so assertions check for
// the presence/absence of key facts (item names, category scope, absence
// of a wrong item) rather than exact strings.
//
// All 12 behaviors run as SEQUENTIAL subtests of one parent test (Node's
// test runner guarantees subtest ordering, unlike independent top-level
// tests which may run concurrently) — this repo's free-tier Gemini key has
// a low requests-per-minute quota, and firing 12 real calls in parallel
// trips the app's own 429 cooldown mid-run. Conversations are shared across
// behaviors where the same setup applies, to keep total real API calls low,
// and a short pause follows every real call to stay under quota.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PACE_MS = 4500;

interface ChatResponse {
  reply: string;
  cart: { itemId: string; name: string; price: number; qty: number }[];
  context: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function send(message: string, context?: unknown): Promise<ChatResponse> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context }),
  });
  if (!res.ok) throw new Error(`/api/chat returned HTTP ${res.status}`);
  const body = (await res.json()) as ChatResponse;
  await sleep(PACE_MS); // stay well under the free-tier requests-per-minute quota
  return body;
}

test("V3 one-call agent — 12 required behaviors (live)", async (t) => {
  try {
    await fetch(BASE_URL);
  } catch {
    throw new Error(
      `Cannot reach ${BASE_URL} — start the dev server first (npm run dev), with AI_ENGINE=v3 and a real LLM key configured in .env.local.`
    );
  }

  await t.test("1. 'mujhe burgers dikhao' shows only the burger category", async () => {
    const r = await send("mujhe burgers dikhao");
    assert.match(r.reply, /Zinger/i);
    assert.doesNotMatch(r.reply, /Pizza/i);
    assert.doesNotMatch(r.reply, /Chowmein/i);
  });

  await t.test("2. 'pizza menu dikhao' shows only the pizza category", async () => {
    const r = await send("pizza menu dikhao");
    assert.match(r.reply, /Pizza/i);
    assert.doesNotMatch(r.reply, /Zinger/i);
    assert.doesNotMatch(r.reply, /Chowmein/i);
  });

  await t.test("3. 'full menu dikhao' shows the whole menu (multiple categories)", async () => {
    const r = await send("full menu dikhao");
    assert.match(r.reply, /Burger/i);
    assert.match(r.reply, /Pizza/i);
  });

  // Conversation D: 4 -> 5 -> 9, shared to keep total real calls low.
  let ctxD: unknown;

  await t.test("4. 'mujhe ek pasta chahiye' asks which pasta, adds nothing yet", async () => {
    const r = await send("mujhe ek pasta chahiye");
    ctxD = r.context;
    assert.equal(r.cart.length, 0);
    assert.match(r.reply, /pasta/i);
  });

  await t.test("5. pasta clarification -> 'mexican' adds Mexican Pasta, never Mexican Sandwich", async () => {
    const r = await send("mexican", ctxD);
    ctxD = r.context;
    assert.equal(r.cart.length, 1);
    assert.equal(r.cart[0].itemId, "mexican-pasta-white-sauce");
    assert.doesNotMatch(r.reply, /Mexican Sandwich/i);
  });

  await t.test("9. 'pasta hatado or kuch spicy suggest karo' removes pasta and suggests items", async () => {
    const r = await send("pasta hatado or kuch spicy suggest karo", ctxD);
    assert.equal(r.cart.some((l) => l.name.toLowerCase().includes("pasta")), false);
    assert.ok(r.reply.length > 20, "should include a real suggestion, not a one-word reply");
  });

  // Conversation E: 6 -> 7 -> 8 -> 12, shared to keep total real calls low.
  let ctxE: unknown;

  await t.test("6. 'ek hotshot kardo ek pasta or 4 chowmin' adds hotshot immediately, asks about pasta", async () => {
    const r = await send("ek hotshot kardo ek pasta or 4 chowmin");
    ctxE = r.context;
    assert.ok(
      r.cart.some((l) => l.name.toLowerCase().includes("hot shot") || l.name.toLowerCase().includes("hotshot")),
      "hotshot should be added immediately"
    );
    assert.match(r.reply, /pasta/i);
  });

  await t.test("7. 'small' resolves the pasta clarification, then asks about chowmein", async () => {
    const r = await send("small", ctxE);
    ctxE = r.context;
    assert.match(r.reply, /chowmein/i);
  });

  await t.test("8. 'chicken' resolves the chowmein clarification at the preserved quantity of 4", async () => {
    const r = await send("chicken", ctxE);
    ctxE = r.context;
    const chowmeinLine = r.cart.find((l) => l.name.toLowerCase().includes("chowmein"));
    assert.equal(chowmeinLine?.qty, 4, "chicken chowmein quantity must resolve to 4");
  });

  await t.test("12. 'kitna total hua' reports the correct real total", async () => {
    const r = await send("kitna total hua", ctxE);
    const cartTotal = r.cart.reduce((sum, l) => sum + l.price * l.qty, 0);
    assert.match(r.reply, new RegExp(String(cartTotal)));
  });

  await t.test("10. 'manager se baat karni hai' triggers human support, no cart mutation", async () => {
    const r = await send("manager se baat karni hai");
    assert.equal(r.cart.length, 0);
    assert.match(r.reply, /(manager|human|insaan|agent|rabta)/i);
  });

  await t.test("11. 'hello' gets a natural greeting", async () => {
    const r = await send("hello");
    assert.ok(r.reply.length > 0);
    assert.doesNotMatch(r.reply, /[{}[\]]/);
  });
});
