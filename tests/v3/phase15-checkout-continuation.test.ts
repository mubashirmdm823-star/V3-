// V3 Phase 15 — Checkout Continuation After "han bas yahi hai"
// (Production Stabilization Mode bug fix).
//
// Reproduced bug (two symptoms, one root cause):
//   1. After building up a real cart across several turns, "han bas yahi
//      hai" ("yes, this is it") got only "Aapka cart update kar diya gaya
//      hai." — a dead end. Nothing deterministically recognized this as a
//      "the order is final, start checkout" signal, so whatever the model
//      drafted (often a false checkout-confirmation claim) got corrected
//      down to the generic cart-update fallback, with no forward progress.
//   2. Because state never actually reached ORDER_REVIEW, the customer's
//      next message ("delivery") was rejected with "Is waqt yeh action
//      possible nahi hai..." — canSelectDeliveryPickup requires
//      AWAITING_DELIVERY_PICKUP, which was never reached either.
//
// Root cause fixed in TWO files:
//   - v3/agent/fact-verifier.ts: new isReadyForCheckoutSignal() (a
//     narrower, stronger signal than the existing NO_MORE_ITEMS_REPLIES
//     nudge — "bas yahi hai"/"bas yahi order hai") deterministically maps
//     to start_checkout, and renderCheckoutReviewIfApplicable now includes
//     the required "no changes after confirmation" warning line.
//   - v3/agent/index.ts: wires isReadyForCheckoutSignal in, mirroring the
//     existing noMoreItemsThisTurn pattern exactly — never trusts the
//     model's own checkoutAction for this signal, always overrides to
//     start_checkout. Once state reaches ORDER_REVIEW, the ALREADY-
//     EXISTING (untouched) answeringDeliveryPickupEarly/
//     deliverySelectionOverride mechanism correctly accepts "delivery"/
//     "pickup" and asks for the address/name — bug #2 needed no separate
//     fix, it was purely downstream of bug #1 never reaching ORDER_REVIEW.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase15-checkout-continuation.test.ts

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
  checkoutAction?: unknown;
}

function plan(overrides: PlanOverrides): string {
  return JSON.stringify({
    reply: overrides.reply ?? "Theek hai!",
    cartActions: overrides.cartActions ?? [],
    pendingClarifications: [],
    checkoutAction: overrides.checkoutAction ?? null,
    recommendationRequest: null,
  });
}

function freshSession(): AgentSession {
  return createAgentSession("test-conv", "test-session");
}

async function drive(session: AgentSession, message: string, fetchImpl: FetchLike) {
  return processAgentMessage(session, message, menu, restaurantConfig, { fetchImpl, env: FAKE_ENV });
}

async function sessionWithCart(): Promise<AgentSession> {
  const result = await drive(
    freshSession(),
    "ek alfredo add karo",
    scriptedFetch(plan({ reply: "Alfredo Pasta add ho gaya!", cartActions: [{ type: "add_item", query: "alfredo pasta white sauce", quantity: 1 }] }))
  );
  return result.session;
}

// ─── 1. "han bas yahi hai" starts checkout review from an existing cart ───

test("1. existing cart + 'han bas yahi hai' starts checkout review", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "han bas yahi hai", scriptedFetch(plan({ reply: "Aapka order confirm ho gaya hai!" })));
  assert.equal(result.session.conversation.order.state, "ORDER_REVIEW");
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Alfredo Pasta white sauce/);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});

// ─── 2. "bas yahi order hai mera" also starts checkout review ─────────────

test("2. existing cart + 'bas yahi order hai mera' starts checkout review", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "bas yahi order hai mera", scriptedFetch(plan({ reply: "Cart update ho gaya." })));
  assert.equal(result.session.conversation.order.state, "ORDER_REVIEW");
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});

// ─── 3. Checkout review includes the no-changes-after-confirmation warning ─

test("3. checkout review includes the no-changes-after-confirmation warning", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "han bas yahi hai", scriptedFetch(plan({ reply: "Theek hai." })));
  assert.match(result.reply, /Order confirm hone ke baad changes nahi ki ja sakengi/i);
});

// ─── 4/5. "delivery" right after the delivery/pickup question is accepted,
// never rejected ───────────────────────────────────────────────────────────

test("4. 'delivery' after the delivery/pickup question asks for the address", async () => {
  const session = await sessionWithCart();
  const reviewed = await drive(session, "han bas yahi hai", scriptedFetch(plan({ reply: "Theek hai." })));
  const result = await drive(reviewed.session, "delivery", scriptedFetch(plan({ reply: "Delivery select ho gaya." })));
  assert.equal(result.session.conversation.order.state, "AWAITING_ADDRESS");
  assert.match(result.reply, /address/i);
});

test("5. 'delivery' response never returns the action-not-possible message", async () => {
  const session = await sessionWithCart();
  const reviewed = await drive(session, "han bas yahi hai", scriptedFetch(plan({ reply: "Theek hai." })));
  const result = await drive(reviewed.session, "delivery", scriptedFetch(plan({ reply: "Delivery select ho gaya." })));
  assert.doesNotMatch(result.reply, /Is waqt yeh action possible nahi hai/i);
  assert.doesNotMatch(result.reply, /yeh abhi possible nahi hai/i);
});

// ─── 6. Existing menu/order/recommendation smoke tests still pass ─────────

test("6a. smoke: menu request still works", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name));
  }
});

test("6b. smoke: order review request still works", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "order dikhao", scriptedFetch(plan({ reply: "Dekhte hain." })));
  assert.match(result.reply, /Alfredo Pasta white sauce/);
  assert.match(result.reply, /Total/);
});

test("6c. smoke: recommendation still works and never auto-adds", async () => {
  const result = await drive(freshSession(), "kuch spicy suggest karo", scriptedFetch(plan({ reply: "Zaroor!" })));
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

test("6d. smoke: 'checkout' (explicit word, no 'bas yahi hai') still opens review the normal way", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "checkout", scriptedFetch(plan({ reply: "Chaliye!", checkoutAction: { type: "start_checkout" } })));
  assert.equal(result.session.conversation.order.state, "ORDER_REVIEW");
  assert.match(result.reply, /Order Review/i);
});

test("6e. smoke: the softer 'bas' (no-more-items) nudge still works unchanged, doesn't jump straight to review", async () => {
  const session = await sessionWithCart();
  const result = await drive(session, "bas", scriptedFetch(plan({ reply: "Theek hai." })));
  assert.equal(result.session.conversation.order.state, "CART_EDITING");
  assert.match(result.reply, /checkout/i);
  assert.doesNotMatch(result.reply, /Delivery chahiye ya pickup/i);
});
