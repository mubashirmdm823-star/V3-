// V3 Phase 11 — Recommendation Category Exclusion (Production Stabilization
// Mode bug fix).
//
// Reproduced bug: after the recommendation engine suggests a spicy item
// from Burgers ("Spicy Stuff Burger"), the customer explicitly excludes
// that category ("burgers ke ilawa kia hai spicy ma", "ye to burger hai na
// iske ilawa..."), but the assistant kept re-suggesting the exact same
// burger every turn.
//
// Root cause: multi-intent.ts#resolveRecommendation scopes every
// recommendation by `memory.lastMentionedCategory` — a POSITIVE hint meant
// to keep suggestions on-topic. But that field is itself updated FROM the
// previous turn's own suggestion (conversation-memory.ts#updateMemoryAfterTurn),
// so after suggesting a burger, lastMentionedCategory becomes "burgers" —
// and nothing anywhere detected the customer's exclusion phrase, so the
// very next "spicy" request re-scoped straight back into Burgers and
// returned the same item again. No exclusion concept existed at all.
//
// Fix: multi-intent.ts now detects an exclusion marker ("ke ilawa"/"siwa"/
// "nahi") in the customer's raw message, resolves the named category via
// the intent parser's own findCategoryByName (reused, not duplicated —
// same primitive used everywhere else in this codebase for text ->
// category resolution) or falls back to memory.lastMentionedCategory for a
// bare "is ke ilawa" with no category word, and passes that as a new
// excludeCategoryKey to recommendation-engine.ts#recommendItems, which
// filters it out of every candidate pool (scoped and unscoped) before
// slicing to MAX_SUGGESTIONS.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase11-recommendation-category-exclusion.test.ts

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
  pendingClarifications?: string[];
  checkoutAction?: unknown;
  recommendationRequest?: unknown;
}

function plan(overrides: PlanOverrides): string {
  return JSON.stringify({
    reply: overrides.reply ?? "Theek hai!",
    cartActions: overrides.cartActions ?? [],
    pendingClarifications: overrides.pendingClarifications ?? [],
    checkoutAction: overrides.checkoutAction ?? null,
    recommendationRequest: overrides.recommendationRequest ?? null,
  });
}

function freshSession(): AgentSession {
  return createAgentSession("test-conv", "test-session");
}

async function drive(session: AgentSession, message: string, fetchImpl: FetchLike) {
  return processAgentMessage(session, message, menu, restaurantConfig, { fetchImpl, env: FAKE_ENV });
}

function cartItems(result: Awaited<ReturnType<typeof drive>>) {
  return result.session.conversation.order.cart.items;
}

// ─── 1. "spicy ma" may still suggest the spicy burger when nothing has
// been excluded ─────────────────────────────────────────────────────────

test("'spicy ma' with no exclusion may suggest the spicy burger", async () => {
  const result = await drive(freshSession(), "spicy ma", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  assert.match(result.reply, /Spicy Stuff Burger/);
  assert.match(result.reply, /PKR 700/);
});

// ─── 2. Explicit "burgers ke ilawa spicy ma" excludes every burger item ──

test("'burgers ke ilawa kia hai spicy ma' never suggests a burger item", async () => {
  const session = freshSession();
  // Turn 1: establish a spicy burger suggestion (sets lastMentionedCategory
  // to "burgers", the exact condition that caused the live bug).
  const first = await drive(session, "spicy ma", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  assert.match(first.reply, /Spicy Stuff Burger/);

  // Turn 2: the customer explicitly excludes burgers.
  const result = await drive(
    first.session,
    "burgers ke ilawa kia hai spicy ma",
    scriptedFetch(plan({ reply: "Spicy Stuff Burger try karein.", recommendationRequest: { theme: "spicy" } }))
  );
  assert.doesNotMatch(result.reply, /Spicy Stuff Burger/i);
  assert.doesNotMatch(result.reply, /Burger/i);
  assert.match(result.reply, /Hot Shot/);
  assert.match(result.reply, /PKR 800/);
});

// ─── 3. Bare "iske ilawa" (no named category) falls back to the last
// suggested category and still excludes it ──────────────────────────────

test("'ye to burger hai na iske ilawa kuch nahi hai spicy ma' does not repeat the burger", async () => {
  const session = freshSession();
  const first = await drive(session, "spicy ma", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  assert.match(first.reply, /Spicy Stuff Burger/);

  const result = await drive(
    first.session,
    "ye to burger hai na iske ilawa kuch nahi hai spicy ma",
    scriptedFetch(plan({ reply: "Spicy Stuff Burger hi try karein.", recommendationRequest: { theme: "spicy" } }))
  );
  assert.doesNotMatch(result.reply, /Spicy Stuff Burger/i);
  assert.match(result.reply, /Hot Shot/);
});

// ─── 4. Recommendation replies still include PKR prices ───────────────────

test("category-excluded recommendation still includes PKR prices", async () => {
  const session = freshSession();
  const first = await drive(session, "spicy ma", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  const result = await drive(
    first.session,
    "burger nahi, kuch aur spicy batao",
    scriptedFetch(plan({ reply: "Spicy Stuff Burger.", recommendationRequest: { theme: "spicy" } }))
  );
  const bulletLines = result.reply.split("\n").filter((line) => line.trim().startsWith("•"));
  assert.ok(bulletLines.length > 0, `expected at least one priced bullet line in:\n${result.reply}`);
  for (const line of bulletLines) assert.match(line, /PKR \d+/);
});

// ─── 5. Recommendation never adds to cart, excluded or not ────────────────

test("category-excluded recommendation never adds anything to the cart", async () => {
  const session = freshSession();
  const first = await drive(session, "spicy ma", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  const result = await drive(
    first.session,
    "burgers ke ilawa kia hai spicy ma",
    scriptedFetch(plan({ reply: "Hot Shot try karein.", recommendationRequest: { theme: "spicy" } }))
  );
  assert.equal(cartItems(result).length, 0, "a recommendation must never itself add anything to the cart");
});

// ─── 6. Unrelated flows still pass (menu, order review, clarification,
// checkout) — narrow smoke checks, not full re-tests of those suites ──────

test("smoke: menu request still works after this fix", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name), `expected "${item.name}" in:\n${result.reply}`);
  }
});

test("smoke: order review still works after this fix", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const result = await drive(addResult.session, "order dikhao", scriptedFetch(plan({ reply: "Aapka order yeh hai." })));
  assert.match(result.reply, /Zinger Burger/);
});

test("smoke: clarification still works after this fix", async () => {
  const result = await drive(
    freshSession(),
    "mujhe pasta chahiye",
    scriptedFetch(plan({ reply: "Kaunsa pasta?", cartActions: [{ type: "add_item", query: "pasta" }] }))
  );
  for (const item of menu.categories.find((c) => c.key === "pasta")!.items) {
    assert.ok(result.reply.includes(item.name), `expected "${item.name}" in:\n${result.reply}`);
  }
});

test("smoke: checkout review-before-delivery still works after this fix", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const result = await drive(addResult.session, "checkout", scriptedFetch(plan({ reply: "Chaliye!", checkoutAction: { type: "start_checkout" } })));
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});
