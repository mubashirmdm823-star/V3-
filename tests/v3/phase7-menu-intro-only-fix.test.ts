// V3 Phase 7 — Menu Request Must Always Include Menu Content.
//
// Live bug: "Menu please" got "Sure, here's our full menu for you!" — an
// intro line with ZERO actual items or prices. Two root causes, both fixed
// deterministically in fact-verifier.ts (never trusting the LLM draft for
// menu content):
//
// 1. FULL_MENU_PATTERN was anchored to end-of-string with only a narrow
//    set of allowed trailing words ("menu\s*(dikhao|dikha do|batao)?\s*$")
//    — any OTHER trailing filler ("menu please", "show menu please") broke
//    the `$` anchor, so the message matched neither this nor the outer
//    listing-intent gate's full-menu branch and fell through to the
//    model's own (sometimes intro-only) draft. Simplified to a bare "menu"
//    word check, safe because it only runs after the outer gate already
//    required a listing/availability signal and no specific category
//    matched. GENERAL_AVAILABILITY_PATTERN also gained a non-reduplicated
//    "kya/kia available" form ("kya available hai", not just "kya kya").
// 2. New `renderMenuIntroOnlyFallbackIfApplicable`: a last-resort backstop
//    for whatever phrasing gap remains — if the (fact-checked) draft reply
//    mentions "menu" anywhere but contains not one real, priced item line,
//    it's replaced outright with the real, fully-priced menu.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase7-menu-intro-only-fix.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import { renderMenuIntroOnlyFallbackIfApplicable } from "../../v3/agent/fact-verifier";

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

function bulletLines(reply: string): string[] {
  return reply.split("\n").filter((line) => line.trim().startsWith("•"));
}

function assertFullMenuWithPrices(reply: string) {
  const lines = bulletLines(reply);
  assert.ok(lines.length > 0, `expected real menu content, got:\n${reply}`);
  for (const line of lines) {
    assert.match(line, /PKR \d+/, `menu line missing a price: "${line}"`);
  }
  const totalRealItems = menu.categories.reduce((n, c) => n + c.items.length, 0);
  assert.equal(lines.length, totalRealItems, "expected every real menu item to be listed exactly once");
  for (const category of menu.categories) {
    for (const item of category.items) {
      assert.match(reply, new RegExp(`${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — PKR ${item.price}\\b`));
    }
  }
}

// ─── 1/2. Required trigger phrasings ───────────────────────────────────────

test("'Menu please' returns the full menu with prices, not just an intro line", async () => {
  const result = await drive(freshSession(), "Menu please", scriptedFetch(plan({ reply: "Sure, here's our full menu for you!" })));
  assertFullMenuWithPrices(result.reply);
});

test("'show menu please' returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "show menu please", scriptedFetch(plan({ reply: "Sure, here's our menu!" })));
  assertFullMenuWithPrices(result.reply);
});

test("bare 'menu' returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "menu", scriptedFetch(plan({ reply: "Here you go!" })));
  assertFullMenuWithPrices(result.reply);
});

test("'full menu' returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "full menu", scriptedFetch(plan({ reply: "Sure!" })));
  assertFullMenuWithPrices(result.reply);
});

test("'view menu' returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "view menu", scriptedFetch(plan({ reply: "Here's our menu." })));
  assertFullMenuWithPrices(result.reply);
});

test("'kya available hai' (single, non-reduplicated) returns the full menu with prices", async () => {
  const result = await drive(freshSession(), "kya available hai", scriptedFetch(plan({ reply: "Bohat kuch available hai!" })));
  assertFullMenuWithPrices(result.reply);
});

test("'kia kia available hai' still returns the full menu with prices (no regression)", async () => {
  const result = await drive(freshSession(), "kia kia available hai", scriptedFetch(plan({ reply: "Sure!" })));
  assertFullMenuWithPrices(result.reply);
});

// ─── 3. Intro-only LLM draft is replaced by the real full menu ────────────

test("an intro-only LLM draft mentioning 'menu' but listing zero items is replaced by the real full menu", async () => {
  const result = await drive(freshSession(), "Menu please", scriptedFetch(plan({ reply: "Sure, here's our full menu for you!" })));
  assert.doesNotMatch(result.reply, /^Sure, here's our full menu for you!$/);
  assertFullMenuWithPrices(result.reply);
});

test("the intro-only fallback fires even for a phrasing the trigger patterns don't explicitly recognize, as long as the draft says 'menu' with no items", async () => {
  const result = await drive(
    freshSession(),
    "hey what do you guys offer around here",
    scriptedFetch(plan({ reply: "We have a great menu! Let me know if you have questions." }))
  );
  assertFullMenuWithPrices(result.reply);
});

test("the intro-only fallback never fires once something structural already happened this turn", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo, hamara pura menu bhi bohat acha hai",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya! Hamara menu bohat acha hai.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  assert.match(result.reply, /Zinger Burger add ho gaya/);
  assert.equal(result.session.conversation.order.cart.items.length, 1);
});

test("renderMenuIntroOnlyFallbackIfApplicable unit: fires on an intro-only draft, not on a draft that already lists priced items", () => {
  const introOnly = renderMenuIntroOnlyFallbackIfApplicable("Menu please", "Sure, here's our full menu for you!", menu);
  assert.ok(introOnly);
  assertFullMenuWithPrices(introOnly!);

  const alreadyGood = "Burgers:\n• Zinger Burger — PKR 500";
  assert.equal(renderMenuIntroOnlyFallbackIfApplicable("Menu please", alreadyGood, menu), null);
});

test("renderMenuIntroOnlyFallbackIfApplicable never fires when the customer's own message is actually a restaurant-info ask", () => {
  // Regression guard: a location question's model draft hallucinating the
  // word "menu" while deflecting must never be mistaken for a failed menu
  // request — that's the reply-orchestrator's own bug-2 fix, and this
  // proves it at the unit level too, not just end to end.
  const reply = renderMenuIntroOnlyFallbackIfApplicable("kahan hai", "Hamare paas poora menu yeh hai:", menu);
  assert.equal(reply, null);
});

// ─── 4. No full-menu reply can have zero PKR item lines ────────────────────

test("no full-menu reply across every required trigger phrase can have zero priced item lines", async () => {
  const phrasings = ["Menu please", "show menu please", "menu", "full menu", "view menu", "kya available hai", "kia kia available hai"];
  for (const message of phrasings) {
    const result = await drive(freshSession(), message, scriptedFetch(plan({ reply: "Sure, here you go!" })));
    const lines = bulletLines(result.reply);
    assert.ok(lines.length > 0, `"${message}" produced zero menu item lines`);
    for (const line of lines) {
      assert.match(line, /PKR \d+/, `"${message}" produced a priceless menu line: "${line}"`);
    }
  }
});
