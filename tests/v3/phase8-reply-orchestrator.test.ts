// V3 Phase 8 — Reply Orchestrator (production regression repair).
//
// Root cause: fact-verifier.ts had grown ~15 independent "replacing"
// overrides, each deciding FOR ITSELF (via a scattered mix of
// `hadStructuredAction` flags and an ad-hoc `looksLikeMenuOrOrderRequest`
// cross-check) whether it was safe to fire — there was no single place
// that decided precedence when more than one tier's pattern matched the
// same message. Two concrete production regressions came from that:
//   1. "order dikhao" — nothing in the file deterministically verified a
//      bare "show me my order/cart" request at all, so an intro-only LLM
//      draft ("Aapka current order yeh hai:" with no items) passed through
//      unmodified.
//   2. "kahan hai current order" — restaurant-info's own self-check for
//      "does this message also look like something else" didn't know
//      about order/cart requests, so "kahan" alone replaced the WHOLE
//      reply with just the address, discarding "current order."
//
// Fix: v3/agent/reply-orchestrator.ts is now the ONE place that decides
// which tier wins, via a fixed numbered priority list; every fact-verifier
// render function only ever answers "does this look like MY tier's
// request," nothing about precedence against any other tier.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase8-reply-orchestrator.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import { orchestrateReply, type ReplyOrchestratorInput } from "../../v3/agent/reply-orchestrator";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const FAKE_ENV = { LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "fake-key-for-tests" };

const INTERNAL_WORDS = ["backend", "tool", "json", "provider", "gateway", "internal", "system", "debug", "V2", "V3", "engine"];

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

function assertNoInternalTerms(reply: string) {
  for (const word of INTERNAL_WORDS) {
    assert.doesNotMatch(reply, new RegExp(`\\b${word}\\b`, "i"), `reply leaked "${word}": ${reply}`);
  }
}

// ─── 1. item added -> "order dikhao" returns item + quantity + PKR + total ─

test("1. after adding an item, 'order dikhao' returns the itemized cart with quantity, PKR line, and total", async () => {
  let session = freshSession();
  const added = await drive(
    session,
    "ek jumbo zinger dedo",
    scriptedFetch(plan({ reply: "Jumbo Zinger add ho gaya.", cartActions: [{ type: "add_item", query: "jumbo zinger" }] }))
  );
  session = added.session;

  const result = await drive(session, "order dikhao", scriptedFetch(plan({ reply: "Aapka current order yeh hai:" })));
  assert.match(result.reply, /Jumbo Zinger/);
  assert.match(result.reply, /×\s*1|x\s*1/i);
  assert.match(result.reply, /PKR 750/);
  assert.match(result.reply, /Total: PKR 750/);
});

// ─── 2. item added -> "kahan hai current order" returns the order, not the

test("2. after adding an item, 'kahan hai current order' returns the current order, never the restaurant address", async () => {
  let session = freshSession();
  const added = await drive(
    session,
    "ek jumbo zinger dedo",
    scriptedFetch(plan({ reply: "Jumbo Zinger add ho gaya.", cartActions: [{ type: "add_item", query: "jumbo zinger" }] }))
  );
  session = added.session;

  const result = await drive(session, "kahan hai current order", scriptedFetch(plan({ reply: "Hamara address yeh hai." })));
  assert.match(result.reply, /Jumbo Zinger/);
  assert.match(result.reply, /PKR 750/);
  assert.doesNotMatch(result.reply, new RegExp(restaurantConfig.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ─── 3. empty cart -> "order dikhao" gives a friendly empty-cart reply ────

test("3. an empty cart + 'order dikhao' gives a friendly empty-cart reply, never a blank/broken one", async () => {
  const result = await drive(freshSession(), "order dikhao", scriptedFetch(plan({ reply: "Aapka current order yeh hai:" })));
  assert.match(result.reply, /khali/i);
  assert.doesNotMatch(result.reply, /PKR \d/);
});

test("'cart dikhao', 'mera order', and 'kya order hai' all trigger the same order-review tier", async () => {
  for (const message of ["cart dikhao", "mera order", "kya order hai"]) {
    const result = await drive(freshSession(), message, scriptedFetch(plan({ reply: "Filler reply with no real content." })));
    assert.match(result.reply, /khali/i, `"${message}" should give the empty-cart reply on a fresh session`);
  }
});

// ─── 4. "kahan hai" alone (no order/cart word) returns the address ────────

test("4. 'kahan hai' alone (pure location question) returns the restaurant address", async () => {
  const result = await drive(freshSession(), "kahan hai", scriptedFetch(plan({ reply: "Hamare paas poora menu yeh hai:" })));
  assert.match(result.reply, new RegExp(restaurantConfig.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.reply, /•/);
});

// ─── 5. "pizza menu" still returns the priced pizza menu ──────────────────

test("5. 'pizza menu' still returns every pizza item with its price (existing menu fix preserved)", async () => {
  const result = await drive(freshSession(), "pizza menu", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.match(result.reply, new RegExp(`${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — PKR ${item.price}\\b`));
  }
});

// ─── 6. "kuch spicy suggest karo" still returns priced suggestions, no add ─

test("6. 'kuch spicy suggest karo' still returns priced suggestions and never adds anything (existing recommendation fix preserved)", async () => {
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(plan({ reply: "Zaroor, spicy chahiye!", recommendationRequest: { theme: "spicy" } }))
  );
  assert.match(result.reply, /Spicy Stuff Burger|Hot Shot/i);
  assert.match(result.reply, /PKR/);
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

// ─── 7. "kitna total hua" still returns the exact backend total ───────────

test("7. 'kitna total hua' still returns the exact backend total (existing total fix preserved)", async () => {
  let session = freshSession();
  const added = await drive(
    session,
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  session = added.session;
  const result = await drive(session, "kitna total hua", scriptedFetch(plan({ reply: "Abhi calculate kar raha hoon..." })));
  assert.match(result.reply, /Total: PKR 500/);
});

// ─── 8. Checkout review-before-delivery still works ────────────────────────

test("8. checkout still opens with the full order review before ever asking delivery/pickup (Phase 3C preserved)", async () => {
  let session = freshSession();
  const added = await drive(
    session,
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  session = added.session;
  const result = await drive(session, "checkout", scriptedFetch(plan({ reply: "Delivery ya pickup?", checkoutAction: { type: "start_checkout" } })));
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Zinger Burger/);
  assert.match(result.reply, /PKR 500/);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});

// ─── 9. No reply anywhere in this file's scenarios leaks internal words ───

test("9. none of the above scenarios ever leak an internal/implementation word", async () => {
  const scenarios: [string, ReturnType<typeof plan>][] = [
    ["order dikhao", plan({ reply: "Aapka current order yeh hai:" })],
    ["kahan hai current order", plan({ reply: "Backend se address milega." })],
    ["kahan hai", plan({ reply: "System se location milegi." })],
    ["pizza menu", plan({ reply: "Provider se menu milega." })],
    ["kuch spicy suggest karo", plan({ reply: "Internal tool se suggest hoga.", recommendationRequest: { theme: "spicy" } })],
    ["kitna total hua", plan({ reply: "Gateway se total milega." })],
  ];
  for (const [message, script] of scenarios) {
    const result = await drive(freshSession(), message, scriptedFetch(script));
    assertNoInternalTerms(result.reply);
  }
});

// ─── 10. Exactly one final reply source wins per turn (testable) ─────────

function baseOrchestratorInput(): ReplyOrchestratorInput {
  return {
    postOrderAckReply: null,
    finalSubmitOverride: null,
    captureReply: null,
    deliverySelectionOverride: null,
    checkoutReviewOverride: null,
    rejectionOverride: null,
    orderReviewOverride: null,
    noMoreItemsOverride: null,
    totalOverride: null,
    clarificationOverride: null,
    pendingRemovalOverride: null,
    stillAmbiguousOverride: null,
    recommendationOverride: null,
    cartActuallyChanged: false,
    browseOverride: null,
    menuIntroOnlyOverride: null,
    themeOverride: null,
    restaurantInfoOverride: null,
    correctedDraft: "general fallback reply",
  };
}

test("10a. orchestrateReply reports exactly one winning source, even when multiple tiers have a value", () => {
  const result = orchestrateReply({
    ...baseOrchestratorInput(),
    orderReviewOverride: "Aapka current order yeh hai:\n• Jumbo Zinger x1 — PKR 750\n\nTotal: PKR 750",
    totalOverride: "• Jumbo Zinger x1 — PKR 750\n\nTotal: PKR 750",
    restaurantInfoOverride: "Address: Nazimabad No. 5",
    browseOverride: "Burgers:\n• Zinger Burger — PKR 500",
  });
  assert.equal(result.source, "order_review");
  assert.match(result.reply, /Jumbo Zinger/);
});

test("10b. orchestrateReply falls all the way to the general AI reply when every tier declines", () => {
  const result = orchestrateReply(baseOrchestratorInput());
  assert.equal(result.source, "general_ai_reply");
  assert.equal(result.reply, "general fallback reply");
});

test("10c. restaurant info never wins when a higher tier (order review) also has a candidate — proves rule 3 structurally, not by inspection", () => {
  const result = orchestrateReply({
    ...baseOrchestratorInput(),
    orderReviewOverride: "Aapka current order yeh hai:\n• Jumbo Zinger x1 — PKR 750\n\nTotal: PKR 750",
    restaurantInfoOverride: "Address: Nazimabad No. 5",
  });
  assert.notEqual(result.source, "restaurant_info");
  assert.equal(result.source, "order_review");
});

test("10d. menu never wins over a real cart mutation — proves rule 4 structurally", () => {
  const result = orchestrateReply({
    ...baseOrchestratorInput(),
    cartActuallyChanged: true,
    correctedDraft: "Zinger Burger add ho gaya.",
    browseOverride: "Burgers:\n• Zinger Burger — PKR 500",
  });
  assert.equal(result.source, "cart_mutation");
  assert.match(result.reply, /add ho gaya/);
});

test("10e. the raw-text recommendation fallback never wins over a real cart mutation — proves rule 5 structurally", () => {
  const result = orchestrateReply({
    ...baseOrchestratorInput(),
    cartActuallyChanged: true,
    correctedDraft: "Zinger Burger add ho gaya.",
    themeOverride: "Ji, spicy options mein aap ye try kar sakte hain:\n• Spicy Stuff Burger — PKR 700",
  });
  assert.equal(result.source, "cart_mutation");
});
