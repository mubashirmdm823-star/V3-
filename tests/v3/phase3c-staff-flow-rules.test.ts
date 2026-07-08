// V3 Phase 3C — Restaurant Staff Flow Rules tests.
//
// Covers the 11 required scenarios: full pasta option listing, "nahi"
// after an add moving to order review, checkout always opening with a
// full order review before delivery/pickup, the delivery flow requiring
// BOTH address and name (never submitting on address alone), the final
// submit reaching PENDING_VERIFICATION, and post-order acknowledgment
// replies never looping or falsely claiming "confirmed" early. Same
// scripted-fetch convention as the rest of tests/v3/ — no network call,
// no flakiness.
//
// Run with: npx tsx --test tests/v3/phase3c-staff-flow-rules.test.ts

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

// ─── 1. Pasta clarification shows ALL 5 options ─────────────────────────────

test("1. 'mujhe pasta chahiye' shows all 5 Pasta options with prices, not just small/large", async () => {
  const result = await drive(
    freshSession(),
    "mujhe pasta chahiye",
    scriptedFetch(plan({ reply: "Chota ya bara?", cartActions: [{ type: "add_item", query: "pasta" }] }))
  );
  assert.match(result.reply, /Aap kaunsa Pasta chahenge/);
  assert.match(result.reply, /Pasta Small — PKR 500/);
  assert.match(result.reply, /Pasta Large — PKR 600/);
  assert.match(result.reply, /Alfredo Pasta white sauce — PKR 850/);
  assert.match(result.reply, /Macaroni Pasta red sauce — PKR 750/);
  assert.match(result.reply, /Mexican Pasta white sauce — PKR 850/);
});

// ─── 2. Alfredo add then "nahi" -> order review ────────────────────────────

test("2. alfredo add then 'nahi' shows the order review + checkout prompt", async () => {
  let session = freshSession();
  const added = await drive(session, "alfredo kardo", scriptedFetch(plan({ reply: "Alfredo add ho gaya.", cartActions: [{ type: "add_item", query: "alfredo" }] })));
  session = added.session;
  assert.equal(session.conversation.order.cart.items[0]?.itemId, "alfredo-pasta-white-sauce");

  const result = await drive(session, "nahi", scriptedFetch(plan({ reply: "Aur kuch chahiye?" })));
  assert.match(result.reply, /current order/i);
  assert.match(result.reply, /Alfredo Pasta white sauce/);
  assert.match(result.reply, /Total: PKR 850/);
  assert.match(result.reply, /checkout/i);
  assert.equal(result.session.conversation.order.cart.items.length, 1, "cart must be untouched by the plain 'nahi'");
});

// ─── 3/3b. Checkout always opens with the full order review ───────────────

test("3. 'checkout' shows the full order review with real prices before anything else", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const result = await drive(session, "checkout", scriptedFetch(plan({ reply: "Delivery ya pickup?", checkoutAction: { type: "start_checkout" } })));
  assert.match(result.reply, /Order Review/);
  assert.match(result.reply, /Zinger Burger × 1 — PKR 500/);
  assert.match(result.reply, /Total: PKR 500/);
  assert.equal(result.session.conversation.order.state, "ORDER_REVIEW");
});

test("3b. checkout never asks delivery/pickup without the order review appearing first", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const result = await drive(session, "place order", scriptedFetch(plan({ reply: "Delivery chahiye ya pickup?", checkoutAction: { type: "start_checkout" } })));
  // The reply must contain BOTH — review always precedes the delivery/pickup ask, never just the question alone.
  assert.match(result.reply, /Order Review/);
  assert.match(result.reply, /Delivery chahiye ya pickup/);
});

// ─── 4/5/6. Delivery flow requires BOTH address and name ──────────────────

async function reachAwaitingAddress(): Promise<AgentSession> {
  let session = freshSession();
  session = (await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })))).session;
  session = (await drive(session, "checkout", scriptedFetch(plan({ reply: "Review.", checkoutAction: { type: "start_checkout" } })))).session;
  session = (await drive(session, "confirm order", scriptedFetch(plan({ reply: "Confirm.", checkoutAction: { type: "confirm_order" } })))).session;
  session = (await drive(session, "delivery", scriptedFetch(plan({ reply: "Address batayein.", checkoutAction: { type: "select_delivery" } })))).session;
  assert.equal(session.conversation.order.state, "AWAITING_ADDRESS");
  return session;
}

test("4. delivery flow asks for address, then asks for the name next", async () => {
  const session = await reachAwaitingAddress();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  const result = await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })));
  assert.equal(result.session.conversation.order.address, address);
  assert.equal(result.session.conversation.order.state, "AWAITING_NAME");
  assert.match(result.reply, /naam/i);
});

test("5. the order can NEVER submit with only an address — no name means no PENDING_VERIFICATION", async () => {
  const session = await reachAwaitingAddress();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  const addressGiven = await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })));
  // Even if the model tries to jump straight to confirm_order right after the address, it must not submit.
  const prematureConfirm = await drive(
    addressGiven.session,
    "confirm order",
    scriptedFetch(plan({ reply: "Order confirm ho gaya!", checkoutAction: { type: "confirm_order" } }))
  );
  assert.notEqual(prematureConfirm.session.conversation.order.state, "PENDING_VERIFICATION");
  assert.equal(prematureConfirm.session.conversation.order.customerName, undefined);
  assert.doesNotMatch(prematureConfirm.reply, /order confirm ho gaya/i);
});

test("6. name capture after address works and reaches READY_TO_SUBMIT", async () => {
  const session = await reachAwaitingAddress();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  const addressGiven = await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })));
  const nameGiven = await drive(addressGiven.session, "Fahad", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "Fahad" } })));
  assert.equal(nameGiven.session.conversation.order.customerName, "Fahad");
  assert.equal(nameGiven.session.conversation.order.state, "READY_TO_SUBMIT");
  assert.match(nameGiven.reply, /Fahad/);
  assert.match(nameGiven.reply, /Delivery address/);
});

// ─── 7. Final submit reaches PENDING_VERIFICATION with honest wording ──────

test("7. final confirm reaches PENDING_VERIFICATION and never says a bare 'order confirm ho gaya'", async () => {
  const session = await reachAwaitingAddress();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  let s = (await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })))).session;
  s = (await drive(s, "Fahad", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "Fahad" } })))).session;
  const finalSubmit = await drive(s, "confirm", scriptedFetch(plan({ reply: "Order confirm ho gaya!", checkoutAction: { type: "confirm_order" } })));
  assert.equal(finalSubmit.session.conversation.order.state, "PENDING_VERIFICATION");
  assert.match(finalSubmit.reply, /verification/i);
  assert.doesNotMatch(finalSubmit.reply, /order confirm ho gaya/i);
});

// ─── 8/9. Post-order acknowledgment never loops ────────────────────────────

async function reachPendingVerification(): Promise<AgentSession> {
  const session = await reachAwaitingAddress();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  let s = (await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })))).session;
  s = (await drive(s, "Fahad", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "Fahad" } })))).session;
  s = (await drive(s, "confirm", scriptedFetch(plan({ reply: "Order submit ho gaya!", checkoutAction: { type: "confirm_order" } })))).session;
  assert.equal(s.conversation.order.state, "PENDING_VERIFICATION");
  return s;
}

test("8. 'okay' after PENDING_VERIFICATION gives the one-time short acknowledgment, not the long finalization message again", async () => {
  const session = await reachPendingVerification();
  const result = await drive(session, "okay", scriptedFetch(plan({ reply: "Aapka order finalize ho raha hai, thodi der intezar karein..." })));
  assert.match(result.reply, /verification ke liye send ho chuka hai/);
  assert.doesNotMatch(result.reply, /finalize ho raha hai/i);
});

test("9. a SECOND 'okay' says the order is already in verification, not the first message again", async () => {
  let session = await reachPendingVerification();
  const first = await drive(session, "okay", scriptedFetch(plan({ reply: "..." })));
  session = first.session;
  const second = await drive(session, "theek hai", scriptedFetch(plan({ reply: "Aapka order finalize ho raha hai..." })));
  assert.match(second.reply, /already verification mein hai/);
  assert.doesNotMatch(second.reply, /send ho chuka hai/);
});

// ─── 10. No false "confirmed" wording before real confirmation ────────────

test("10. no premature 'confirmed' claim anywhere before PENDING_VERIFICATION is actually reached", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;
  const checkout = await drive(session, "checkout", scriptedFetch(plan({ reply: "Order confirm ho gaya! Delivery ya pickup?", checkoutAction: { type: "start_checkout" } })));
  assert.doesNotMatch(checkout.reply, /order confirm ho gaya/i);
  assert.equal(checkout.session.conversation.order.state, "ORDER_REVIEW");
});
