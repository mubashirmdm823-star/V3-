// V3 one-call AI Conversation Agent — tests.
//
// Covers the one-call-per-message architecture (index.ts): exactly one
// Gemini call per real customer message (never more — no second pass, no
// keyword-bypass gate deciding whether to call Gemini at all), strict
// clarification-category scoping reused from V2's own (already fixed)
// resolver, cart/checkout action validation against the real menu/cart/
// order-state, the bounded reply-correction pass, and fallback to the full
// V2 deterministic pipeline on any failure (no config, invalid JSON,
// network error, 429 cooldown).
//
// Same fake-fetch convention as the rest of this codebase (v2/llm.test.ts):
// a scripted `fetchImpl` returns EXACTLY what a real model would return, so
// every hop is exercised for real with no network call and no flakiness.
//
// Run with: npx tsx --test tests/v3/agent.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown, isCooldownActive, COOLDOWN_BUSY_REPLY } from "../../v3/agent/index";
import { validateAgentTurnPlan } from "../../v3/agent/schema";
import { recordRateLimitHit } from "../../v3/agent/cooldown";
import { v3Engine } from "../../lib/engine/v3";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

const FAKE_ENV = { LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "fake-key-for-tests" };

// Cooldown is module-level (process-wide) state by design (one shared
// Google API key) — reset before EVERY test so no test's 429 side effect
// leaks into an unrelated later test.
beforeEach(() => {
  resetCooldown();
});

// ─── Fake LLM transport (Google AI response shape, no network) ─────────────

function googleJsonResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as unknown as Response;
}

function scriptedFetch(rawText: string): FetchLike {
  return (async () => googleJsonResponse(rawText)) as unknown as FetchLike;
}

function countingFetch(rawText: string): { fetchImpl: FetchLike; count: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return googleJsonResponse(rawText);
  }) as unknown as FetchLike;
  return { fetchImpl, count: () => calls };
}

function throwingFetch(): FetchLike {
  return (async () => {
    throw new Error("fetchImpl should never be called for this turn");
  }) as unknown as FetchLike;
}

function plan(overrides: Partial<{ reply: string; cartActions: unknown[]; pendingClarifications: string[]; checkoutAction: unknown }>): string {
  return JSON.stringify({
    reply: overrides.reply ?? "Theek hai!",
    cartActions: overrides.cartActions ?? [],
    pendingClarifications: overrides.pendingClarifications ?? [],
    checkoutAction: overrides.checkoutAction ?? null,
  });
}

function freshSession(): AgentSession {
  return createAgentSession("test-conv", "test-session");
}

async function drive(session: AgentSession, message: string, fetchImpl: FetchLike, env: Record<string, string> = FAKE_ENV) {
  return processAgentMessage(session, message, menu, restaurantConfig, { fetchImpl, env });
}

// ─── A. Schema validation ───────────────────────────────────────────────────

test("A1. validateAgentTurnPlan accepts a well-formed plan", () => {
  const result = validateAgentTurnPlan({
    reply: "hi",
    cartActions: [{ type: "add_item", query: "zinger burger", quantity: 2 }],
    pendingClarifications: [],
    checkoutAction: null,
  });
  assert.ok(result);
  assert.equal(result?.cartActions.length, 1);
});

test("A2. validateAgentTurnPlan rejects missing reply / non-array cartActions / bad action type", () => {
  assert.equal(validateAgentTurnPlan({ cartActions: [], checkoutAction: null }), null);
  assert.equal(validateAgentTurnPlan({ reply: "hi", cartActions: "not-an-array", checkoutAction: null }), null);
  assert.equal(validateAgentTurnPlan({ reply: "hi", cartActions: [{ type: "delete_everything" }], checkoutAction: null }), null);
});

test("A3. validateAgentTurnPlan rejects a runaway action list (>10)", () => {
  const cartActions = Array.from({ length: 11 }, () => ({ type: "add_item", query: "burger" }));
  assert.equal(validateAgentTurnPlan({ reply: "hi", cartActions, pendingClarifications: [], checkoutAction: null }), null);
});

test("A4. validateAgentTurnPlan rejects a malformed checkoutAction but accepts null", () => {
  assert.ok(validateAgentTurnPlan({ reply: "hi", cartActions: [], pendingClarifications: [], checkoutAction: null }));
  assert.equal(
    validateAgentTurnPlan({ reply: "hi", cartActions: [], pendingClarifications: [], checkoutAction: { type: "teleport" } }),
    null
  );
});

// ─── B. One-call-per-message invariant ──────────────────────────────────────

test("B1. a normal turn makes exactly one Gemini call", async () => {
  const { fetchImpl, count } = countingFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }));
  const result = await drive(freshSession(), "ek zinger burger dedo", fetchImpl);
  assert.equal(count(), 1);
  assert.equal(result.apiCallsThisTurn, 1);
  assert.equal(result.usedLLM, true);
});

test("B2. no provider configured makes zero calls and falls back to V2", async () => {
  const result = await drive(freshSession(), "hello", throwingFetch(), {});
  assert.equal(result.apiCallsThisTurn, 0);
  assert.equal(result.usedLLM, false);
  assert.equal(result.fallbackUsed, true);
  assert.ok(result.reply.length > 0);
});

test("B3. invalid JSON from the model costs one attempted call, then falls back — never a second call", async () => {
  const { fetchImpl, count } = countingFetch("not valid json at all");
  const result = await drive(freshSession(), "ek zinger burger dedo", fetchImpl);
  assert.equal(count(), 1);
  assert.equal(result.apiCallsThisTurn, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.providerError, true);
  assert.ok(result.reply.length > 0);
});

test("B4. an active 429 cooldown makes zero calls this turn", async () => {
  recordRateLimitHit();
  const result = await drive(freshSession(), "ek zinger burger dedo", throwingFetch());
  assert.equal(result.apiCallsThisTurn, 0);
  assert.equal(result.cooldownActive, true);
  assert.equal(result.reply, COOLDOWN_BUSY_REPLY);
  assert.equal(isCooldownActive(), true);
});

test("B5. clarification replies also go through the single-call path (no special 0-call shortcut)", async () => {
  let session = freshSession();
  const first = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = first.session;
  const { fetchImpl, count } = countingFetch(plan({ reply: "Mexican add ho gaya", cartActions: [{ type: "add_item", query: "mexican" }] }));
  const second = await drive(session, "mexican", fetchImpl);
  assert.equal(count(), 1);
  assert.equal(second.apiCallsThisTurn, 1);
});

// ─── C. Cart actions applied deterministically ──────────────────────────────

test("C1. add_item resolves an exact item and reports the real cart", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const cart = result.session.conversation.order.cart;
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].itemId, "zinger-burger");
});

test("C2. add_multiple_items: exact items land even when one is ambiguous (hotshot + pasta + 4 chowmein)", async () => {
  const result = await drive(
    freshSession(),
    "ek hotshot kardo ek pasta or 4 chowmin",
    scriptedFetch(
      plan({
        reply: "Hotshot aur Chowmein add ho gaye, pasta ke liye options bata raha hoon.",
        cartActions: [
          {
            type: "add_multiple_items",
            items: [
              { query: "hotshot", quantity: 1 },
              { query: "pasta", quantity: 1 },
              { query: "chowmein", quantity: 4 },
            ],
          },
        ],
      })
    )
  );
  const cart = result.session.conversation.order.cart;
  assert.ok(cart.items.some((l) => l.name.toLowerCase().includes("hot shot") || l.name.toLowerCase().includes("hotshot")));
  assert.equal(result.session.conversation.order.state, "AWAITING_CLARIFICATION");
  // "chowmein" (Chicken/Vegetable) is itself ambiguous, just like "pasta" —
  // both queue as clarifications; pasta is asked first, chowmein's
  // quantity of 4 must be preserved in the SECOND queued question rather
  // than silently reset to 1.
  const queue = result.session.conversation.order.clarificationQueue ?? [];
  assert.equal(queue.length, 2);
  assert.equal(queue[0].category, "pasta");
  assert.equal(queue[1].quantity, 4, "chowmein's quantity must be preserved at 4 in the queued question");
});

test("C3. remove_item removes a real cart line", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const removed = await drive(session, "zinger burger hata do", scriptedFetch(plan({ reply: "Theek hai, hata diya.", cartActions: [{ type: "remove_item", query: "zinger burger" }] })));
  assert.equal(removed.session.conversation.order.cart.items.length, 0);
});

test("C4. change_quantity updates an existing line", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const changed = await drive(
    session,
    "3 kar do",
    scriptedFetch(plan({ reply: "3 kar diya", cartActions: [{ type: "change_quantity", query: "zinger burger", quantity: 3 }] }))
  );
  assert.equal(changed.session.conversation.order.cart.items[0].qty, 3);
});

test("C5. clear_cart empties the cart and drops the clarification queue", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const cleared = await drive(session, "cart khali kardo", scriptedFetch(plan({ reply: "Cart khali kar di.", cartActions: [{ type: "clear_cart" }] })));
  assert.equal(cleared.session.conversation.order.cart.items.length, 0);
});

test("C6. a hallucinated/unavailable item is never added, and a false 'added' claim is corrected", async () => {
  const result = await drive(
    freshSession(),
    "ek beef burger dedo",
    scriptedFetch(plan({ reply: "Beef Burger add kar diye gaye hain!", cartActions: [{ type: "add_item", query: "beef burger" }] }))
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0);
  assert.doesNotMatch(result.reply, /add kar diye/i);
});

// ─── D. Strict clarification-category scoping (the fixed bug class) ────────

test("D1. pasta clarification -> 'mexican' resolves to Mexican Pasta, never Mexican Sandwich, even if the draft named the wrong one", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  // The draft (written before backend resolution) wrongly names Mexican Sandwich.
  const answered = await drive(
    session,
    "mexican",
    scriptedFetch(plan({ reply: "✅ Mexican Sandwich add kar diye gaye hain.", cartActions: [{ type: "add_item", query: "mexican" }] }))
  );
  const cart = answered.session.conversation.order.cart;
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].itemId, "mexican-pasta-white-sauce");
  assert.match(answered.reply, /Mexican Pasta/);
  assert.doesNotMatch(answered.reply, /Mexican Sandwich/);
});

test("D2. pasta clarification -> 'club' is rejected (Club Sandwich is not a Pasta option), cart stays empty, queue preserved", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  const answered = await drive(
    session,
    "club",
    scriptedFetch(plan({ reply: "Club Sandwich add kar diye gaye hain!", cartActions: [{ type: "add_item", query: "club" }] }))
  );
  assert.equal(answered.session.conversation.order.cart.items.length, 0);
  assert.equal(answered.session.conversation.order.state, "AWAITING_CLARIFICATION");
  assert.match(answered.reply, /Pasta mein available nahi hai/);
  assert.doesNotMatch(answered.reply, /Club Sandwich add/);
});

test("D3. sandwich clarification -> 'mexican' resolves to Mexican Sandwich (not Pasta)", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek sandwich chahiye", scriptedFetch(plan({ reply: "Aap kaunsa sandwich chahenge?", cartActions: [{ type: "add_item", query: "sandwich" }] })));
  session = asked.session;
  const answered = await drive(session, "mexican", scriptedFetch(plan({ reply: "Mexican add ho gaya", cartActions: [{ type: "add_item", query: "mexican" }] })));
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "mexican-sandwich");
});

// ─── E. Checkout guard validation ───────────────────────────────────────────

test("E1. start_checkout is rejected on an empty cart", async () => {
  const result = await drive(
    freshSession(),
    "checkout karo",
    scriptedFetch(plan({ reply: "Checkout start!", checkoutAction: { type: "start_checkout" } }))
  );
  assert.notEqual(result.session.conversation.order.state, "ORDER_REVIEW");
});

test("E2. start_checkout then confirm_order walks the real state machine", async () => {
  let session = freshSession();
  session = (await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ cartActions: [{ type: "add_item", query: "zinger burger" }] })))).session;
  session = (await drive(session, "checkout karo", scriptedFetch(plan({ reply: "Order review!", checkoutAction: { type: "start_checkout" } })))).session;
  assert.equal(session.conversation.order.state, "ORDER_REVIEW");
  session = (await drive(session, "confirm karo", scriptedFetch(plan({ reply: "Delivery ya pickup?", checkoutAction: { type: "confirm_order" } })))).session;
  assert.equal(session.conversation.order.state, "AWAITING_DELIVERY_PICKUP");
});

test("E3. escalate_to_human never mutates the cart or state", async () => {
  const result = await drive(
    freshSession(),
    "manager se baat karni hai",
    scriptedFetch(plan({ reply: "Zaroor, hamara manager aapse rabta karega.", checkoutAction: { type: "escalate_to_human" } }))
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0);
  assert.equal(result.session.conversation.order.state, "BROWSING");
});

// ─── F. Reply correction ────────────────────────────────────────────────────

test("F1. a wrong total in the draft is corrected to the real cart subtotal", async () => {
  let session = freshSession();
  session = (await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ cartActions: [{ type: "add_item", query: "zinger burger" }] })))).session;
  const result = await drive(session, "kitna total hua", scriptedFetch(plan({ reply: "Aapka total PKR 1 hai." })));
  const realTotal = result.session.conversation.order.cart.items[0].price;
  assert.match(result.reply, new RegExp(`PKR ${realTotal}`));
  assert.doesNotMatch(result.reply, /PKR 1\b/);
});

test("F2. Rs./Rs currency mentions are normalized to PKR", async () => {
  const result = await drive(freshSession(), "hello", scriptedFetch(plan({ reply: "Welcome! Delivery Rs. 150 hai." })));
  assert.match(result.reply, /PKR 150/);
  assert.doesNotMatch(result.reply, /Rs\./);
});

// ─── G. No internal leakage ──────────────────────────────────────────────────

test("G1. reply never leaks JSON, tool names, or raw item ids", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: 'add_item {"itemId":"zinger-burger","added":true} Zinger Burger add ho gaya!', cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  assert.doesNotMatch(result.reply, /add_item/);
  assert.doesNotMatch(result.reply, /zinger-burger/);
  assert.doesNotMatch(result.reply, /[{}[\]]/);
});

// ─── H. lib/engine/v3 adapter still conforms to the shared AIEngine contract ─

test("H1. v3Engine.processMessage returns the standard EngineResponse shape and stays context-safe across a restore", async () => {
  process.env.LLM_PROVIDER = "";
  process.env.GOOGLE_API_KEY = "";
  const first = await v3Engine.processMessage({ message: "hello" });
  assert.ok(typeof first.reply === "string" && first.reply.length > 0);
  assert.ok(Array.isArray(first.cart));
  assert.equal(typeof first.isFinished, "boolean");
  const second = await v3Engine.processMessage({ message: "ek zinger burger dedo", context: first.context });
  assert.ok(second.reply.length > 0);
});

test("H2. a garbage context never throws — starts a fresh session instead", async () => {
  const result = await v3Engine.processMessage({ message: "hello", context: { garbage: true, nested: [1, 2, 3] } });
  assert.ok(result.reply.length > 0);
});
