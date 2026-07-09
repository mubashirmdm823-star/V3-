// V3 Phase 16 — Unavailable-Item Reply Precedence Over Menu Backstop
// (Production Stabilization Mode bug fix).
//
// Golden-conversation failure fixed: add-unavailable-item.
//
// Reproduced bug: "ek dragon roll add karo" (a genuinely non-existent
// menu item) got the ENTIRE full priced menu dumped back instead of an
// honest "not available" message.
//
// Root cause: correct-reply.ts's correctUnavailable() produces "{names}
// hamare menu mein available nahi hai. Baqi items mein se kuch order
// karna chahenge?" — an honest, correct rejection that happens to contain
// the literal word "menu" with no priced bullet lines. fact-verifier.ts's
// renderMenuIntroOnlyFallbackIfApplicable (a last-resort backstop for a
// model draft that TALKS about the menu without actually listing it) had
// no way to distinguish this honest rejection from a genuinely failed
// menu request, so it wrongly replaced the correct "not available"
// message with the full menu dump.
//
// Fix: "available nahi" is the fixed, unique marker of correctUnavailable
// (and the sibling correctClarificationOutcome rejection) — the backstop
// now excludes any reply containing it, a narrow, content-based exclusion
// that never widens the backstop's own trigger condition.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase16-unavailable-item-precedence.test.ts

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

function bulletLines(reply: string): string[] {
  return reply.split("\n").filter((line) => line.trim().startsWith("•"));
}

// ─── 1/2/3. Unavailable item is honestly rejected, never the full menu ────

test("1. 'ek dragon roll add karo' returns 'available nahi'", async () => {
  const result = await drive(
    freshSession(),
    "ek dragon roll add karo",
    scriptedFetch(plan({ reply: "Ek Dragon Roll add kar raha hoon.", cartActions: [{ type: "add_item", query: "dragon roll", quantity: 1 }] }))
  );
  assert.match(result.reply, /available nahi/i);
});

test("2. 'ek dragon roll add karo' does not show the full menu", async () => {
  const result = await drive(
    freshSession(),
    "ek dragon roll add karo",
    scriptedFetch(plan({ reply: "Ek Dragon Roll add kar raha hoon.", cartActions: [{ type: "add_item", query: "dragon roll", quantity: 1 }] }))
  );
  assert.equal(bulletLines(result.reply).length, 0, `expected no menu bullet lines in:\n${result.reply}`);
  assert.doesNotMatch(result.reply, /Burgers:/);
  assert.doesNotMatch(result.reply, /Pizza:/);
});

// Live browser validation found a WIDER manifestation of the same bug: the
// real model doesn't always draft a structured add_item cartAction for an
// item it recognizes as fake — leaving correct-reply.ts's own "available
// nahi" correction never triggered — and instead explains the situation in
// its own free-text words, which can still happen to mention "menu" with
// no priced lines. EXPLICIT_ADD_ATTEMPT_PATTERN closes this: a customer
// message that explicitly says "X add karo" is never itself a menu-browse
// request, regardless of what cartActions (if any) the model drafted.
test("1b. 'ek dragon roll add karo' is never replaced with the full menu even when the model drafts NO cartAction at all", async () => {
  const result = await drive(
    freshSession(),
    "ek dragon roll add karo",
    scriptedFetch(plan({ reply: "Dragon Roll hamare paas nahi hai. Hamara menu dekh lein." }))
  );
  assert.equal(bulletLines(result.reply).length, 0, `expected no menu bullet lines in:\n${result.reply}`);
  assert.doesNotMatch(result.reply, /Burgers:/);
});

test("3. cart remains empty after an unavailable-item attempt", async () => {
  const result = await drive(
    freshSession(),
    "ek dragon roll add karo",
    scriptedFetch(plan({ reply: "Ek Dragon Roll add kar raha hoon.", cartActions: [{ type: "add_item", query: "dragon roll", quantity: 1 }] }))
  );
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

// ─── 4/5. Full menu still works for genuine menu requests ─────────────────

test("4. 'menu please' still shows the full menu with prices", async () => {
  const result = await drive(freshSession(), "menu please", scriptedFetch(plan({ reply: "Sure, here's our full menu for you!" })));
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(bulletLines(result.reply).length, totalRealItems);
  for (const line of bulletLines(result.reply)) assert.match(line, /PKR \d+/);
});

test("5. 'pizza menu' still shows the pizza menu with prices", async () => {
  const result = await drive(freshSession(), "pizza menu", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name));
    assert.match(result.reply, new RegExp(`PKR ${item.price}\\b`));
  }
});
