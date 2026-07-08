// V3 Phase 3B — Checkout Name/Address Hardening tests.
//
// Covers the 9 required scenarios: deterministic name/address capture while
// AWAITING_NAME/AWAITING_ADDRESS, confirm_order structurally blocked in both
// states, conversational/help/wait routed correctly (never saved as data),
// and the reply always reflecting what the backend actually did — never a
// false success claim. Same scripted-fetch convention as the rest of
// tests/v3/ — no network call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase3b-checkout-hardening.test.ts

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

// Drives a fresh session all the way to AWAITING_NAME via the pickup path
// (add item -> start_checkout -> confirm_order -> select_pickup).
async function reachAwaitingNameViaPickup(): Promise<AgentSession> {
  let session = freshSession();
  session = (await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })))).session;
  session = (await drive(session, "checkout karo", scriptedFetch(plan({ reply: "Checkout shuru.", checkoutAction: { type: "start_checkout" } })))).session;
  session = (await drive(session, "confirm order", scriptedFetch(plan({ reply: "Confirm ho gaya.", checkoutAction: { type: "confirm_order" } })))).session;
  session = (await drive(session, "pickup", scriptedFetch(plan({ reply: "Pickup select ho gaya.", checkoutAction: { type: "select_pickup" } })))).session;
  assert.equal(session.conversation.order.state, "AWAITING_NAME");
  return session;
}

// Drives a fresh session to AWAITING_ADDRESS via the delivery path.
async function reachAwaitingAddressViaDelivery(): Promise<AgentSession> {
  let session = freshSession();
  session = (await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })))).session;
  session = (await drive(session, "checkout karo", scriptedFetch(plan({ reply: "Checkout shuru.", checkoutAction: { type: "start_checkout" } })))).session;
  session = (await drive(session, "confirm order", scriptedFetch(plan({ reply: "Confirm ho gaya.", checkoutAction: { type: "confirm_order" } })))).session;
  session = (await drive(session, "delivery", scriptedFetch(plan({ reply: "Delivery select ho gaya.", checkoutAction: { type: "select_delivery" } })))).session;
  assert.equal(session.conversation.order.state, "AWAITING_ADDRESS");
  return session;
}

// ─── 1/2. AWAITING_NAME saves a valid name ──────────────────────────────────

test("1. AWAITING_NAME + 'Fahad' saves the name and moves toward submission", async () => {
  const session = await reachAwaitingNameViaPickup();
  const result = await drive(session, "Fahad", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "Fahad" } })));
  assert.equal(result.session.conversation.order.customerName, "Fahad");
  assert.equal(result.session.conversation.order.state, "READY_TO_SUBMIT");
  assert.match(result.reply, /Fahad/);
});

test("2. AWAITING_NAME + 'mera naam Fahad hai' saves ONLY 'Fahad', not the whole sentence", async () => {
  const session = await reachAwaitingNameViaPickup();
  const result = await drive(session, "mera naam Fahad hai", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "mera naam Fahad hai" } })));
  assert.equal(result.session.conversation.order.customerName, "Fahad");
});

// ─── 3. confirm_order is structurally blocked in AWAITING_NAME ─────────────

test("3. AWAITING_NAME + 'confirm order' never confirms — asks for the name instead", async () => {
  const session = await reachAwaitingNameViaPickup();
  const result = await drive(
    session,
    "confirm order",
    scriptedFetch(plan({ reply: "Aapka order confirm ho gaya hai! Shukriya.", checkoutAction: { type: "confirm_order" } }))
  );
  assert.equal(result.session.conversation.order.state, "AWAITING_NAME", "state must not advance");
  assert.equal(result.session.conversation.order.customerName, undefined);
  assert.doesNotMatch(result.reply, /order confirm ho gaya|shukriya/i, "the model's premature success claim must not survive");
  assert.match(result.reply, /naam/i);
});

// ─── 4. Conversational text is never saved as a name ────────────────────────

test("4. AWAITING_NAME + 'help' does not save 'Help' as the customer's name", async () => {
  const session = await reachAwaitingNameViaPickup();
  const result = await drive(session, "help", scriptedFetch(plan({ reply: "Aapka naam Help save ho gaya!", checkoutAction: { type: "save_customer_name", name: "Help" } })));
  assert.equal(result.session.conversation.order.customerName, undefined);
  assert.equal(result.session.conversation.order.state, "AWAITING_NAME");
  assert.doesNotMatch(result.reply, /\bHelp\b.*save/i);
});

// ─── 5/6/7. AWAITING_ADDRESS capture rules ─────────────────────────────────

test("5. AWAITING_ADDRESS + a valid Karachi address saves it and moves to AWAITING_NAME", async () => {
  const session = await reachAwaitingAddressViaDelivery();
  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  const result = await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })));
  assert.equal(result.session.conversation.order.address, address);
  assert.equal(result.session.conversation.order.state, "AWAITING_NAME");
});

test("6. AWAITING_ADDRESS + 'yes' does not save 'yes' as the address", async () => {
  const session = await reachAwaitingAddressViaDelivery();
  const result = await drive(session, "yes", scriptedFetch(plan({ reply: "Address save ho gaya: yes", checkoutAction: { type: "save_address", address: "yes" } })));
  assert.equal(result.session.conversation.order.address, undefined);
  assert.equal(result.session.conversation.order.state, "AWAITING_ADDRESS");
});

test("7. AWAITING_ADDRESS + 'wait' pauses safely — no address saved, no rejection tone", async () => {
  const session = await reachAwaitingAddressViaDelivery();
  const result = await drive(session, "wait", scriptedFetch(plan({ reply: "Aapka address save ho gaya!", checkoutAction: { type: "save_address", address: "wait" } })));
  assert.equal(result.session.conversation.order.address, undefined);
  assert.equal(result.session.conversation.order.state, "AWAITING_ADDRESS");
  assert.match(result.reply, /intezar|wait/i);
});

// ─── 8. A rejected checkout action never produces a success reply ─────────

test("8. 'confirm order' attempted before an address is given (AWAITING_ADDRESS) is rejected without a success reply", async () => {
  const session = await reachAwaitingAddressViaDelivery();
  const result = await drive(
    session,
    "confirm order",
    scriptedFetch(plan({ reply: "Aapka order confirm ho gaya hai!", checkoutAction: { type: "confirm_order" } }))
  );
  assert.equal(result.session.conversation.order.state, "AWAITING_ADDRESS");
  assert.equal(result.session.conversation.order.address, undefined);
  assert.doesNotMatch(result.reply, /confirm ho gaya/i);
});

// ─── 9. Final reply always matches the real backend state ─────────────────

test("9. the full delivery -> address -> name flow: every reply matches the actual backend state at that point", async () => {
  let session = freshSession();
  const added = await drive(session, "ek zinger burger dedo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  session = added.session;

  const checkout = await drive(session, "checkout karo", scriptedFetch(plan({ reply: "Checkout shuru.", checkoutAction: { type: "start_checkout" } })));
  session = checkout.session;
  assert.equal(session.conversation.order.state, "ORDER_REVIEW");

  const confirmed = await drive(session, "confirm order", scriptedFetch(plan({ reply: "Confirm ho gaya, delivery ya pickup?", checkoutAction: { type: "confirm_order" } })));
  session = confirmed.session;
  assert.equal(session.conversation.order.state, "AWAITING_DELIVERY_PICKUP");

  const delivery = await drive(session, "delivery", scriptedFetch(plan({ reply: "Delivery select ho gaya, address batayein.", checkoutAction: { type: "select_delivery" } })));
  session = delivery.session;
  assert.equal(session.conversation.order.state, "AWAITING_ADDRESS");

  const address = "House 12, Street 5, Gulshan-e-Iqbal, Karachi";
  const addressGiven = await drive(session, address, scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_address", address } })));
  session = addressGiven.session;
  assert.equal(session.conversation.order.address, address);
  assert.equal(session.conversation.order.state, "AWAITING_NAME");
  assert.match(addressGiven.reply, /naam/i, "reply must ask for the name next, matching the real state");

  const nameGiven = await drive(session, "Fahad", scriptedFetch(plan({ reply: "Theek hai.", checkoutAction: { type: "save_customer_name", name: "Fahad" } })));
  session = nameGiven.session;
  assert.equal(session.conversation.order.customerName, "Fahad");
  assert.equal(session.conversation.order.state, "READY_TO_SUBMIT");
  assert.match(nameGiven.reply, /Fahad/);
  assert.match(nameGiven.reply, /confirm/i, "reply must point to the real final submission step");

  const finalConfirm = await drive(session, "confirm", scriptedFetch(plan({ reply: "Order submit ho gaya!", checkoutAction: { type: "confirm_order" } })));
  assert.equal(finalConfirm.session.conversation.order.state, "PENDING_VERIFICATION");
});
