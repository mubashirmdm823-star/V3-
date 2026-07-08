// V3 Phase 3 — Behaviour Polish tests.
//
// Covers the 12 required scenarios: recommendation never auto-adds, total
// questions always get the exact backend total (including the empty-cart
// case), remove+recommend stays split, replace, ambiguous vs unambiguous
// removal, reference-triggered add after a recommendation, and fact
// correction (item name / total / no internal leakage). Same scripted-fetch
// convention as the rest of tests/v3/ — no network call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase3-behaviour-polish.test.ts

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

// ─── 1/2. Recommendation must never auto-add ────────────────────────────────

test("1. 'kuch spicy suggest karo' never adds anything, even if the model drafts an add action anyway", async () => {
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(
      plan({
        reply: "Zaroor, yeh spicy hai.",
        cartActions: [{ type: "add_item", query: "Spicy Stuff Burger" }],
        recommendationRequest: { theme: "spicy" },
      })
    )
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0, "recommendation must never mutate the cart");
  assert.match(result.reply, /Spicy Stuff Burger|Hot Shot/i);
});

test("2. 'kuch acha batao' never adds anything", async () => {
  const result = await drive(
    freshSession(),
    "kuch acha batao",
    scriptedFetch(
      plan({
        reply: "Yeh humari specialty hai.",
        cartActions: [{ type: "add_multiple_items", items: [{ query: "Think Food Special Pizza" }] }],
        recommendationRequest: { theme: "popular" },
      })
    )
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

// ─── 3. Remove + recommendation stays split ─────────────────────────────────

test("3. 'pasta hata do aur spicy suggest karo' removes only pasta and never adds the suggestion", async () => {
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
        cartActions: [
          { type: "remove_item", query: "pasta" },
          { type: "add_item", query: "Spicy Stuff Burger" },
        ],
        recommendationRequest: { theme: "spicy" },
      })
    )
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0, "pasta removed and the spicy suggestion must NOT be added");
  assert.match(result.reply, /Spicy Stuff Burger|Hot Shot/i);
});

// ─── 4. A later, explicit confirmation DOES add the recommended item ───────

test("4. recommendation followed by 'haan ye add kar do' adds the previously-suggested item via memory", async () => {
  let session = freshSession();
  const suggested = await drive(
    session,
    "kuch spicy suggest karo",
    scriptedFetch(plan({ reply: "Yeh spicy hai.", recommendationRequest: { theme: "spicy" } }))
  );
  session = suggested.session;
  assert.equal(session.conversation.order.cart.items.length, 0);

  const confirmed = await drive(
    session,
    "haan ye wala add kar do",
    scriptedFetch(plan({ reply: "Add kar diya.", cartActions: [{ type: "add_item", query: "ye wala" }] }))
  );
  assert.equal(confirmed.session.conversation.order.cart.items.length, 1);
  assert.equal(confirmed.session.conversation.order.cart.items[0].itemId, "spicy-stuff-burger");
});

// ─── 5/6. Total questions always answer with the exact backend total ──────

test("5. 'kitna total hua' always states the exact real total", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const result = await drive(session, "kitna total hua", scriptedFetch(plan({ reply: "Abhi calculate kar raha hoon..." })));
  assert.match(result.reply, /Total: PKR 500/);
  assert.match(result.reply, /Zinger Burger/);
});

test("6. 'bill kitna hai' on an empty cart gives a friendly empty-cart reply, never a fake number", async () => {
  const result = await drive(freshSession(), "bill kitna hai", scriptedFetch(plan({ reply: "Aapka total PKR 500 hai." })));
  assert.match(result.reply, /khali/i);
  assert.doesNotMatch(result.reply, /PKR \d/);
});

// ─── 7. Replace behaviour ────────────────────────────────────────────────────

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

// ─── 8/9. Ambiguous vs unambiguous removal ──────────────────────────────────

test("8. 'burger hata do' with exactly one burger in the cart removes it directly", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const removed = await drive(session, "burger hata do", scriptedFetch(plan({ reply: "Hata diya.", cartActions: [{ type: "remove_item", query: "burger" }] })));
  assert.equal(removed.session.conversation.order.cart.items.length, 0);
});

test("9. 'burger hata do' with two different burgers in the cart asks which one, without touching the cart", async () => {
  // Both names literally contain "Burger" (unlike "Jumbo Zinger", which
  // deliberately does NOT match the bare word "burger" in this codebase's
  // matching rules) — genuinely ambiguous for a bare "burger hata do".
  let session = freshSession();
  const first = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = first.session;
  const second = await drive(session, "ek smoke burger bhi dedo", scriptedFetch(plan({ reply: "Smoke Burger add ho gaya.", cartActions: [{ type: "add_item", query: "smoke burger" }] })));
  session = second.session;
  assert.equal(session.conversation.order.cart.items.length, 2);

  const result = await drive(session, "burger hata do", scriptedFetch(plan({ reply: "Zinger Burger hata diya!", cartActions: [{ type: "remove_item", query: "burger" }] })));
  assert.equal(result.session.conversation.order.cart.items.length, 2, "cart must stay untouched until the customer picks one");
  assert.equal(result.session.memory.pendingRemoval?.options.length, 2);
  assert.match(result.reply, /kaunsa|which/i);
  assert.doesNotMatch(result.reply, /Zinger Burger hata diya/i, "the model's premature 'removed' claim must be corrected away");
});

// ─── 10/11. Fact correction ──────────────────────────────────────────────────

test("10. a wrong item name in the draft is corrected to the real resolved item", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  const answered = await drive(
    session,
    "mexican",
    scriptedFetch(plan({ reply: "Mexican Sandwich add kar diya gaya hai!", cartActions: [{ type: "add_item", query: "mexican" }] }))
  );
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "mexican-pasta-white-sauce");
  assert.match(answered.reply, /Mexican Pasta/);
  assert.doesNotMatch(answered.reply, /Mexican Sandwich/);
});

test("11. a wrong total in the draft is corrected to the real cart subtotal", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya! Aapka total PKR 999999 hai.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  assert.match(result.reply, /PKR 500/);
  assert.doesNotMatch(result.reply, /999999/);
});

// ─── 12. No internal leakage ────────────────────────────────────────────────

test("12. no customer reply ever contains JSON, tool names, debug fields, or raw item ids", async () => {
  const scenarios = [
    plan({ reply: '{"tool":"add_item"} Zinger Burger add ho gaya', cartActions: [{ type: "add_item", query: "zinger burger" }] }),
    plan({ reply: "activeEngine parserSource zinger-burger-w-c add_item queue_clarification", cartActions: [] }),
  ];
  for (const script of scenarios) {
    const result = await drive(freshSession(), "ek zinger burger dedo", scriptedFetch(script));
    assert.doesNotMatch(result.reply, /"tool"|add_item|queue_clarification|activeEngine|parserSource/);
    assert.doesNotMatch(result.reply, /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/);
  }
});
