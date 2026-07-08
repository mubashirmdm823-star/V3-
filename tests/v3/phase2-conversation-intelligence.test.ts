// V3 Phase 2 — Conversation Intelligence Layer tests.
//
// Covers the 9 required scenarios: clarification lock (pasta/sandwich),
// multi-item order memory across sequential clarifications, remove +
// recommendation in one message, category-browse intelligence, follow-up
// reference resolution, replace intelligence, customer-support
// conversation (escalate/cancel), and fact correction. Same scripted-fetch
// convention as tests/v3/agent.test.ts — no network call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase2-conversation-intelligence.test.ts

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

// ─── 1/2. Clarification lock (pasta / sandwich) ─────────────────────────────

test("1. pasta clarification: 'mujhe ek pasta chahiye' -> 'mexican' resolves to Mexican Pasta, never Mexican Sandwich", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  const answered = await drive(session, "mexican", scriptedFetch(plan({ reply: "Mexican Sandwich add ho gaya!", cartActions: [{ type: "add_item", query: "mexican" }] })));
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "mexican-pasta-white-sauce");
  assert.match(answered.reply, /Mexican Pasta/);
  assert.doesNotMatch(answered.reply, /Mexican Sandwich/);
});

test("2. sandwich clarification: 'mujhe ek sandwich chahiye' -> 'mexican' resolves to Mexican Sandwich, never Mexican Pasta", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek sandwich chahiye", scriptedFetch(plan({ reply: "Aap kaunsa sandwich chahenge?", cartActions: [{ type: "add_item", query: "sandwich" }] })));
  session = asked.session;
  const answered = await drive(session, "mexican", scriptedFetch(plan({ reply: "Mexican Pasta white sauce add ho gaya!", cartActions: [{ type: "add_item", query: "mexican" }] })));
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "mexican-sandwich");
  assert.match(answered.reply, /Mexican Sandwich/);
  assert.doesNotMatch(answered.reply, /Mexican Pasta/);
});

// ─── 3. Multi-item order memory, resolved sequentially ─────────────────────

test("3. hotshot+pasta+chowmein: quantities preserved through sequential clarifications", async () => {
  let session = freshSession();
  const first = await drive(
    session,
    "ek hotshot kardo ek pasta or 4 chowmin",
    scriptedFetch(
      plan({
        reply: "Hotshot add ho gaya, pasta aur chowmein ke liye options bata raha hoon.",
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
  session = first.session;
  assert.equal(session.conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(session.conversation.order.clarificationQueue?.length, 2);

  const second = await drive(session, "small", scriptedFetch(plan({ reply: "Pasta Small add ho gaya, ab chowmein bata dein.", cartActions: [{ type: "add_item", query: "small" }] })));
  session = second.session;
  assert.equal(session.conversation.order.state, "AWAITING_CLARIFICATION", "chowmein question should still be pending");

  const third = await drive(session, "chicken", scriptedFetch(plan({ reply: "Chicken Chowmein add ho gaya.", cartActions: [{ type: "add_item", query: "chicken" }] })));
  session = third.session;

  const cart = session.conversation.order.cart;
  const hotshot = cart.items.find((l) => l.itemId === "hot-shot-8-pcs-with-fries");
  const pasta = cart.items.find((l) => l.itemId === "pasta-small");
  const chowmein = cart.items.find((l) => l.itemId === "chicken-chowmein");
  assert.equal(hotshot?.qty, 1);
  assert.equal(pasta?.qty, 1);
  assert.equal(chowmein?.qty, 4, "chowmein's original quantity of 4 must survive both clarification hops");
  assert.notEqual(session.conversation.order.state, "AWAITING_CLARIFICATION");
});

// ─── 4. Multi-intent: remove + recommendation in one message ───────────────

test("4. 'pasta hata do aur kuch spicy suggest karo': removes pasta AND suggests real spicy items", async () => {
  let session = freshSession();
  const added = await drive(session, "ek pasta small dedo", scriptedFetch(plan({ reply: "Pasta Small add ho gaya.", cartActions: [{ type: "add_item", query: "pasta small" }] })));
  session = added.session;
  assert.equal(session.conversation.order.cart.items.length, 1);

  const result = await drive(
    session,
    "pasta hata do aur kuch spicy suggest karo",
    scriptedFetch(
      plan({
        reply: "Pasta hata di gayi hai.",
        cartActions: [{ type: "remove_item", query: "pasta" }],
        recommendationRequest: { theme: "spicy" },
      })
    )
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0, "pasta must actually be removed");
  assert.match(result.reply, /Spicy Stuff Burger|Hot Shot/i, "a REAL spicy menu item must be suggested");
});

// ─── 5. Category browse intelligence ────────────────────────────────────────

test("5a. 'mujhe burgers dikhao' shows only Burgers", async () => {
  const result = await drive(freshSession(), "mujhe burgers dikhao", scriptedFetch(plan({ reply: "Yeh raha hamara pura menu: Pasta Small, Chicken Steak" })));
  assert.match(result.reply, /Zinger Burger/);
  assert.doesNotMatch(result.reply, /Chicken Steak/);
  assert.doesNotMatch(result.reply, /Pasta Small/);
});

test("5b. 'pizza menu dikhao' shows only Pizza", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Yahan hain: Zinger Burger, Chicken Sandwich" })));
  assert.match(result.reply, /Pizza Large 12 inch/);
  assert.doesNotMatch(result.reply, /Zinger Burger/);
});

test("5c. 'full menu dikhao' shows the full menu across categories", async () => {
  const result = await drive(freshSession(), "full menu dikhao", scriptedFetch(plan({ reply: "..." })));
  assert.match(result.reply, /Zinger Burger/);
  assert.match(result.reply, /Pizza Large 12 inch/);
  assert.match(result.reply, /Chicken Chowmein/);
});

// ─── 6. Follow-up reference resolution ──────────────────────────────────────

test("6a. 'ek aur kar do' adds one more of the last-mentioned item using memory, not menu-wide search", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const more = await drive(session, "ek aur kar do", scriptedFetch(plan({ reply: "Ek aur add ho gaya.", cartActions: [{ type: "add_item", query: "ek aur" }] })));
  const line = more.session.conversation.order.cart.items.find((l) => l.itemId === "zinger-burger");
  assert.equal(line?.qty, 2);
});

test("6b. 'isko hata do' removes the last-mentioned item via memory", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const removed = await drive(session, "isko hata do", scriptedFetch(plan({ reply: "Hata diya.", cartActions: [{ type: "remove_item", query: "isko" }] })));
  assert.equal(removed.session.conversation.order.cart.items.length, 0);
});

test("6c. 'large kar do' swaps the last-mentioned sized item for the Large sibling in the same category", async () => {
  let session = freshSession();
  const added = await drive(session, "ek pizza small dedo", scriptedFetch(plan({ reply: "Pizza Small add ho gaya.", cartActions: [{ type: "add_item", query: "pizza small 6 inch" }] })));
  session = added.session;
  const upsized = await drive(session, "large kar do", scriptedFetch(plan({ reply: "Theek hai.", cartActions: [{ type: "change_quantity", query: "large kar do", quantity: 1 }] })));
  const cart = upsized.session.conversation.order.cart;
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].itemId, "pizza-large-12-inch");
});

// ─── 7. Replace intelligence ─────────────────────────────────────────────────

test("7. 'zinger hata kar jumbo zinger kar do' removes Zinger Burger and adds Jumbo Zinger", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const replaced = await drive(
    session,
    "zinger hata kar jumbo zinger kar do",
    scriptedFetch(plan({ reply: "Jumbo Zinger kar diya.", cartActions: [{ type: "replace_item", fromQuery: "zinger", toQuery: "jumbo zinger" }] }))
  );
  const cart = replaced.session.conversation.order.cart;
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].itemId, "jumbo-zinger");
});

// ─── 8. Customer support conversation ───────────────────────────────────────

test("8a. 'manager se baat karni hai' escalates without mutating cart/state", async () => {
  const result = await drive(freshSession(), "manager se baat karni hai", scriptedFetch(plan({ reply: "Zaroor, hamari team aapse rabta karegi.", checkoutAction: { type: "escalate_to_human" } })));
  assert.equal(result.session.conversation.order.cart.items.length, 0);
  assert.equal(result.session.conversation.order.state, "BROWSING");
});

test("8b. 'delivery late hai' (complaint) never mutates the cart", async () => {
  const result = await drive(freshSession(), "delivery bohat late hai", scriptedFetch(plan({ reply: "Maazrat chahte hain, hum abhi check kar rahe hain." })));
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

test("8c. 'order cancel karo' cancels a real in-progress order", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const cancelled = await drive(session, "order cancel karo", scriptedFetch(plan({ reply: "Aapka order cancel kar diya gaya hai.", checkoutAction: { type: "cancel_order" } })));
  assert.equal(cancelled.session.conversation.order.state, "CANCELLED");
});

// ─── 9. Fact correction (draft names the wrong item) ────────────────────────

test("9. LLM draft says Mexican Sandwich but the resolved item is Mexican Pasta -> final reply says Mexican Pasta", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  const answered = await drive(
    session,
    "mexican",
    scriptedFetch(plan({ reply: "✅ Mexican Sandwich add kar diya gaya hai, shukriya!", cartActions: [{ type: "add_item", query: "mexican" }] }))
  );
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "mexican-pasta-white-sauce");
  assert.match(answered.reply, /Mexican Pasta/);
  assert.doesNotMatch(answered.reply, /Mexican Sandwich/);
});
