// V3 Phase 10 — Rules Centralization.
//
// v3/agent/rules.ts is a REFACTOR, not new behaviour: it centralizes the
// word lists / regex-backed rules that were previously scattered across
// conversation-memory.ts, reply-normalizer.ts, and fact-verifier.ts, so
// future fixes have one place to look. This suite proves two things:
//   1. rules.ts actually exports everything the spec asked for (shape test).
//   2. every behaviour the refactor touched (acknowledgement guard, banned
//      terms, menu price format, recommendation-never-auto-adds, order
//      priority over location, checkout review-before-delivery) is
//      UNCHANGED after the refactor.
// The clarification queue lifecycle itself is NOT re-tested here — it
// wasn't touched by this refactor (clarification-engine.ts/actions.ts only
// gained doc-only TODO comments) and remains fully covered by
// tests/v3/phase9-clarification-queue-lifecycle.test.ts, which stays in the
// test:v3 script chain unchanged.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase10-rules-centralization.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import { containsInternalTerms, stripInternalTerms } from "../../v3/agent/reply-normalizer";
import {
  ACKNOWLEDGEMENT_MESSAGES,
  ACKNOWLEDGEMENT_RULE,
  ADD_INTENT_WORDS,
  RECOMMENDATION_WORDS,
  RECOMMENDATION_RULE,
  ORDER_REVIEW_WORDS,
  ORDER_REVIEW_RULE,
  RESTAURANT_INFO_WORDS,
  RESTAURANT_INFO_RULE,
  CHECKOUT_WORDS,
  CHECKOUT_RULES,
  BANNED_CUSTOMER_REPLY_TERMS,
  MENU_PRICE_FORMAT_RULE,
  formatMenuLine,
  CLARIFICATION_RULES,
  CART_MUTATION_RULES,
  PRIORITY_RULES,
} from "../../v3/agent/rules";

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

// ─── 1. rules.ts exports all 11 required rule groups ───────────────────────

test("rules.ts exports all 11 required rule groups with the exact canonical content", () => {
  assert.deepEqual(ACKNOWLEDGEMENT_MESSAGES, ["ok", "okay", "theek hai", "acha", "done", "thanks", "thank you", "👍"]);
  assert.equal(ACKNOWLEDGEMENT_RULE, "Acknowledgements must never mutate cart.");

  assert.deepEqual(ADD_INTENT_WORDS, ["add", "kar do", "kardo", "daal do", "order karo", "chahiye", "dena", "dedo"]);

  assert.deepEqual(RECOMMENDATION_WORDS, ["suggest", "recommend", "batao", "kuch acha", "kuch spicy", "hot and spicy", "kids ke liye"]);
  assert.equal(RECOMMENDATION_RULE, "Recommendation must never auto-add.");

  assert.deepEqual(ORDER_REVIEW_WORDS, ["order dikhao", "current order", "mera order", "cart dikhao", "order batao", "order bataen", "kahan hai current order"]);
  assert.equal(ORDER_REVIEW_RULE, "Order/cart intent has priority over location.");

  assert.deepEqual(RESTAURANT_INFO_WORDS, ["kahan hai", "address", "location", "timing", "delivery charges", "delivery time", "phone"]);
  assert.equal(RESTAURANT_INFO_RULE, "Restaurant info only applies when message does not contain order/cart/checkout/menu intent.");

  assert.deepEqual(CHECKOUT_WORDS, ["checkout", "place order", "order proceed", "confirm karna hai"]);
  assert.equal(CHECKOUT_RULES.length, 3);

  assert.deepEqual(BANNED_CUSTOMER_REPLY_TERMS, ["backend", "tool", "json", "provider", "gateway", "internal", "system", "debug", "V2", "V3", "engine"]);

  assert.equal(MENU_PRICE_FORMAT_RULE, "All menu/category/recommendation/clarification lines must use: • Item Name — PKR Price");
  assert.equal(formatMenuLine("Zinger Burger", 500), "• Zinger Burger — PKR 500");

  assert.equal(CLARIFICATION_RULES.length, 4);
  assert.equal(CART_MUTATION_RULES.length, 4);
  assert.equal(PRIORITY_RULES.length, 10);
  assert.equal(PRIORITY_RULES[0], "1. Post-order");
  assert.equal(PRIORITY_RULES[9], "10. General reply");
});

// ─── 2. Acknowledgement guard still works ──────────────────────────────────

function cartItems(result: Awaited<ReturnType<typeof drive>>) {
  return result.session.conversation.order.cart.items;
}

test("acknowledgement guard: 'ok' after an add never mutates the cart", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const qtyAfterAdd = cartItems(addResult).find((i) => i.name === "Zinger Burger")?.qty ?? 0;
  assert.ok(qtyAfterAdd > 0);

  const ackResult = await drive(
    addResult.session,
    "ok",
    scriptedFetch(plan({ reply: "Theek hai!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const qtyAfterAck = cartItems(ackResult).find((i) => i.name === "Zinger Burger")?.qty ?? 0;
  assert.equal(qtyAfterAck, qtyAfterAdd, "a bare 'ok' must never mutate the cart, even if the model drafts a cartAction");
});

// ─── 3. Recommendation never auto-adds ─────────────────────────────────────

test("recommendation never auto-adds: 'kuch spicy suggest karo' leaves the cart empty", async () => {
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(plan({ reply: "Zaroor, spicy chahiye!", recommendationRequest: { theme: "spicy" } }))
  );
  assert.equal(cartItems(result).length, 0, "a recommendation request must never itself add anything to the cart");
});

// ─── 4. Order/cart review priority beats restaurant-info/location ─────────

test("order priority beats location: 'kahan hai current order' shows the order, not just the address", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const result = await drive(addResult.session, "kahan hai current order", scriptedFetch(plan({ reply: "Hamara address yeh hai." })));
  assert.match(result.reply, /current order/i);
  assert.match(result.reply, /Zinger Burger/);
  assert.doesNotMatch(result.reply, /Address:/);
});

// ─── 5. Checkout review-before-delivery still works ────────────────────────

test("checkout review-before-delivery: start_checkout always shows the full order review before asking delivery/pickup", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const result = await drive(addResult.session, "checkout", scriptedFetch(plan({ reply: "Chaliye checkout karte hain!", checkoutAction: { type: "start_checkout" } })));
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Zinger Burger/);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});

// ─── 6. Banned customer-reply terms still removed ──────────────────────────

test("banned terms still removed: every BANNED_CUSTOMER_REPLY_TERMS word is stripped from a customer-facing reply", () => {
  for (const word of BANNED_CUSTOMER_REPLY_TERMS) {
    const withLeak = `Some reply mentioning ${word} here.`;
    assert.equal(containsInternalTerms(withLeak), true, `should flag "${word}"`);
    assert.doesNotMatch(stripInternalTerms(withLeak), new RegExp(`\\b${word}\\b`, "i"), `should strip "${word}"`);
  }
});

// ─── 7. Menu price format still works ──────────────────────────────────────

test("menu price format still works: category browse renders every item as '• Item Name — PKR Price'", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  const pizzaItems = menu.categories.find((c) => c.key === "pizza")!.items;
  for (const item of pizzaItems) {
    assert.ok(result.reply.includes(formatMenuLine(item.name, item.price)), `expected "${formatMenuLine(item.name, item.price)}" in:\n${result.reply}`);
  }
});
