// V3 Phase 13 — Greeting Must Never Trigger Menu (Production Stabilization
// Mode bug fix).
//
// Reproduced bug: a fresh "hi" got the ENTIRE full priced menu dumped back
// instead of a plain greeting.
//
// Root cause: fact-verifier.ts#renderMenuIntroOnlyFallbackIfApplicable (the
// last-resort backstop for a model draft that mentions "menu" but lists no
// priced items) only ever excluded restaurant-info asks (INFO_TOPICS) —
// nothing excluded a bare greeting. A perfectly reasonable greeting draft
// ("Hi! Think Food mein khushamdeed. Hamara menu dekhna chahenge?")
// legitimately contains the word "menu" with no priced lines, so the
// backstop replaced the whole greeting with the full menu dump — the
// customer never asked for it at all.
//
// Fix: a new GREETING_PATTERN (exact, case-insensitive match to the WHOLE
// trimmed customer message — same convention as isBareAcknowledgment/
// isNoMoreItemsReply elsewhere in this file) short-circuits the backstop
// for a bare greeting, deliberately narrower than requiring the full
// listing-intent vocabulary — the backstop's job of catching untaught menu
// phrasings ("hey what do you guys offer around here", still covered by
// its own existing, unmodified test) is preserved.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase13-greeting-must-not-trigger-menu.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const FAKE_ENV = { LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "fake-key-for-tests" };

beforeEach(() => {
  resetCooldown();
});

function googleJsonResponse(text: string): Response {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) } as unknown as Response;
}

function scriptedFetch(rawText: string): FetchLike {
  return (async () => googleJsonResponse(rawText)) as unknown as FetchLike;
}

interface PlanOverrides {
  reply?: string;
  cartActions?: unknown[];
}

function plan(overrides: PlanOverrides): string {
  return JSON.stringify({
    reply: overrides.reply ?? "Theek hai!",
    cartActions: overrides.cartActions ?? [],
    pendingClarifications: [],
    checkoutAction: null,
    recommendationRequest: null,
  });
}

function freshSession(): AgentSession {
  return createAgentSession("test-conv", "test-session");
}

async function drive(session: AgentSession, message: string, fetchImpl: FetchLike) {
  return processAgentMessage(session, message, menu, restaurantConfig, { fetchImpl, env: FAKE_ENV });
}

const CATEGORY_HEADINGS = ["Burgers", "Sandwiches", "Pizza", "Pasta", "Noodles", "Rice", "Steaks"];

function bulletLines(reply: string): string[] {
  return reply.split("\n").filter((line) => line.trim().startsWith("•"));
}

// ─── 1/2. Fresh greeting returns greeting only, never the menu ────────────

test("1. fresh 'hi' returns the greeting only, no menu items", async () => {
  const result = await drive(
    freshSession(),
    "hi",
    scriptedFetch(plan({ reply: "Hi! Think Food mein khushamdeed. Kaise help kar sakta hoon?" }))
  );
  assert.equal(bulletLines(result.reply).length, 0, `expected no menu bullet lines in:\n${result.reply}`);
  assert.doesNotMatch(result.reply, /PKR \d+/);
  assert.match(result.reply, /khushamdeed|help/i);
});

test("2. fresh 'hello' returns the greeting only, no menu items", async () => {
  const result = await drive(
    freshSession(),
    "hello",
    scriptedFetch(plan({ reply: "Hello! Welcome to Think Food. Would you like to see the menu?" }))
  );
  assert.equal(bulletLines(result.reply).length, 0, `expected no menu bullet lines in:\n${result.reply}`);
  assert.doesNotMatch(result.reply, /PKR \d+/);
});

// ─── 3/4. Explicit menu requests still return the full priced menu ────────

test("3. 'menu' still returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "menu", scriptedFetch(plan({ reply: "Sure, here's our menu!" })));
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
  for (const line of bulletLines(result.reply)) assert.match(line, /PKR \d+/);
});

test("4. 'menu please' still returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "menu please", scriptedFetch(plan({ reply: "Sure, here's our full menu for you!" })));
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
  for (const line of bulletLines(result.reply)) assert.match(line, /PKR \d+/);
});

// ─── 5. No greeting reply ever contains a menu category heading ───────────

test("5. no greeting reply contains menu category headings like Burgers/Pizza/Pasta", async () => {
  const scenarios = [
    ["hi", "Hi! Think Food mein khushamdeed. Kaise help kar sakta hoon?"],
    ["hello", "Hello! Welcome to Think Food. Would you like to see the menu?"],
    ["hey", "Hey there! Menu dekhna hai ya order karna hai?"],
  ] as const;
  for (const [message, draft] of scenarios) {
    const result = await drive(freshSession(), message, scriptedFetch(plan({ reply: draft })));
    for (const heading of CATEGORY_HEADINGS) {
      assert.doesNotMatch(result.reply, new RegExp(`^${heading}:`, "m"), `"${message}" leaked a "${heading}:" category heading:\n${result.reply}`);
    }
  }
});

// ─── 6. Existing menu/category smoke tests still pass ──────────────────────

test("6a. smoke: 'pizza menu dikhao' still shows every pizza item with its price", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name));
  }
});

test("6b. smoke: 'kya kya available hai' still shows the full menu", async () => {
  const result = await drive(freshSession(), "or kia kia available hai", scriptedFetch(plan({ reply: "Poora menu yeh hai" })));
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
});

test("6c. smoke: an untaught menu phrasing still gets the real menu (backstop preserved)", async () => {
  const result = await drive(
    freshSession(),
    "hey what do you guys offer around here",
    scriptedFetch(plan({ reply: "We have a great menu! Let me know if you have questions." }))
  );
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
});

test("6d. smoke: 'hi, menu dikhao' (greeting + explicit menu ask in one message) still gets the menu", async () => {
  const result = await drive(freshSession(), "hi, menu dikhao", scriptedFetch(plan({ reply: "Hi! Yahan hamara menu hai." })));
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
});
