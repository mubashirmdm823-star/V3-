// V3 Phase 14 — Restaurant Info: Timing & Delivery-Time Pattern Coverage
// (Production Stabilization Mode bug fix).
//
// Golden-conversation failures fixed:
//   1. restaurant-info-timing: "aap kitne baje tak khule hain" wasn't
//      recognized — INFO_TOPICS' timing pattern only matched "khulte",
//      not the equally common "khule"/"khula" conjugations.
//   2. restaurant-info-delivery-time: "delivery mein kitna time lagta hai"
//      fell through to the GENERIC timing pattern (matching the bare word
//      "time") instead of the delivery-time pattern, because that pattern
//      required "delivery" to be immediately followed by "time"/"kitni der"
//      with only whitespace in between — filler words broke the match.
//
// Root cause fixed in v3/agent/fact-verifier.ts's INFO_TOPICS array only:
//   - timing pattern widened to khule/khula/khulte.
//   - delivery-time pattern widened to a bounded, order-flexible gap
//     (same "[\s\S]{0,20}" technique already used by ORDER_REVIEW_PATTERN
//     elsewhere in this file), covering "delivery mein/me kitna time",
//     "delivery mein/me kitni der".
//   - matchingInfoTopics() now excludes the generic "timing" topic
//     whenever "deliveryTime" also matched, so a delivery-time question
//     never also surfaces the restaurant's opening hours.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase14-restaurant-info-timing-delivery.test.ts

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

// ─── 1. Opening-timing phrasing ("khule") is recognized ───────────────────

test("1. 'aap kitne baje tak khule hain' returns the real opening/timing info", async () => {
  const result = await drive(freshSession(), "aap kitne baje tak khule hain", scriptedFetch(plan({ reply: "Yeh hamari timing hai." })));
  assert.match(result.reply, /6 PM to 3 AM/);
});

// ─── 2/3. Delivery-time phrasing with filler words is recognized ──────────

test("2. 'delivery mein kitna time lagta hai' returns the real delivery time, not opening hours", async () => {
  const result = await drive(freshSession(), "delivery mein kitna time lagta hai", scriptedFetch(plan({ reply: "Timing: 6 PM to 3 AM" })));
  assert.match(result.reply, /35 to 45 minutes/);
  assert.doesNotMatch(result.reply, /6 PM to 3 AM/);
});

test("3. 'delivery me kitni der lagegi' returns the real delivery time", async () => {
  const result = await drive(freshSession(), "delivery me kitni der lagegi", scriptedFetch(plan({ reply: "Dekhte hain." })));
  assert.match(result.reply, /35 to 45 minutes/);
});

// ─── 4. Order/cart intent still beats restaurant info ──────────────────────

test("4. 'kahan hai current order' still shows the order, not the address or timing", async () => {
  const session = freshSession();
  const addResult = await drive(
    session,
    "ek zinger burger add karo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  const result = await drive(addResult.session, "kahan hai current order", scriptedFetch(plan({ reply: "Hamara address yeh hai." })));
  assert.match(result.reply, /current order/i);
  assert.match(result.reply, /Zinger Burger/);
  assert.doesNotMatch(result.reply, /Nazimabad/);
  assert.doesNotMatch(result.reply, /6 PM to 3 AM/);
});

// ─── 5. Menu request still unaffected ──────────────────────────────────────

test("5. 'pizza menu' still shows the pizza menu with prices", async () => {
  const result = await drive(freshSession(), "pizza menu", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name), `expected "${item.name}" in:\n${result.reply}`);
    assert.match(result.reply, new RegExp(`PKR ${item.price}\\b`));
  }
});

// ─── Extra: delivery-time question never also shows opening hours (direct
// unit check on the additive verifier too) ─────────────────────────────────

test("delivery-time question never also surfaces the generic opening-hours line", async () => {
  const result = await drive(freshSession(), "delivery mein kitna time lagta hai", scriptedFetch(plan({ reply: "Dekhte hain." })));
  const deliveryMentions = (result.reply.match(/Delivery time:/g) ?? []).length;
  const timingMentions = (result.reply.match(/Timing:/g) ?? []).length;
  assert.equal(deliveryMentions > 0 || /35 to 45 minutes/.test(result.reply), true);
  assert.equal(timingMentions, 0, "must not also show the generic 'Timing:' line");
});
