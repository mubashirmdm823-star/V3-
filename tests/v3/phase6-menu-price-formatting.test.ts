// V3 Phase 6 — Menu/Category/Clarification/Recommendation Price Formatting.
//
// Live bug: item prices were sometimes missing from category/menu/
// clarification/recommendation replies. Three real gaps, all fixed
// deterministically (backend/fact-verifier level, never trusting the LLM
// draft for pricing):
//
// 1. index.ts's `hadStructuredAction` judged "did something structural
//    happen this turn" off the model's RAW cartActions/checkoutAction
//    instead of the real outcome (`facts`) — a spurious/failed model
//    cartAction attached to an otherwise pure "pizza menu dikhao" browse
//    request could block the price-safe category-browse override entirely,
//    letting a price-less LLM draft through.
// 2. fact-verifier.ts's renderClarificationPromptIfApplicable only
//    deterministically rendered prices when the ambiguity spanned a WHOLE
//    menu category — a narrower family ambiguity (e.g. bare "zinger"
//    matching 3 of 6 burgers) got no price-safety net at all.
// 3. fact-verifier.ts's verifyRecommendation only checked whether the
//    recommended item's NAME was mentioned, never its price — a reply
//    naming every item correctly but with no "PKR" anywhere passed through
//    unmodified.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase6-menu-price-formatting.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import { renderClarificationPromptIfApplicable } from "../../v3/agent/fact-verifier";

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

// Every "• Name" bullet line in the reply must also carry "PKR <number>" on
// the SAME line — the exact required format, one item per line.
function assertEveryBulletHasPrice(reply: string) {
  const bulletLines = reply.split("\n").filter((line) => line.trim().startsWith("•"));
  assert.ok(bulletLines.length > 0, `expected at least one bulleted menu line in:\n${reply}`);
  for (const line of bulletLines) {
    assert.match(line, /PKR \d+/, `menu line missing a price: "${line}"`);
  }
}

function assertItemWithPrice(reply: string, name: string, price: number) {
  const line = reply.split("\n").find((l) => l.includes(name));
  assert.ok(line, `expected a line naming "${name}" in:\n${reply}`);
  assert.match(line!, new RegExp(`PKR ${price}\\b`), `"${name}" line missing its exact price PKR ${price}: "${line}"`);
}

// ─── 1. Category menu replies always include every item's price ───────────

test("pizza menu shows every pizza item with its exact price", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assertItemWithPrice(result.reply, item.name, item.price);
  }
  assertEveryBulletHasPrice(result.reply);
});

test("burger menu shows every burger item with its exact price", async () => {
  const result = await drive(freshSession(), "burgers dikhao", scriptedFetch(plan({ reply: "Burgers" })));
  for (const item of menu.categories.find((c) => c.key === "burgers")!.items) {
    assertItemWithPrice(result.reply, item.name, item.price);
  }
  assertEveryBulletHasPrice(result.reply);
});

// A spurious/no-op model cartAction attached to a pure browse request must
// never suppress the price-safe category override (root cause #1 above).
test("pizza menu still shows every item WITH price even if the model attaches a spurious, non-landing cartAction", async () => {
  const result = await drive(
    freshSession(),
    "pizza menu dikhao",
    scriptedFetch(plan({ reply: "Pizza Menu", cartActions: [{ type: "add_item", query: "asdkjaslkdj not a real item" }] }))
  );
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assertItemWithPrice(result.reply, item.name, item.price);
  }
});

// ─── 2. Full menu replies include prices for every category's items ───────

test("full menu ('or kia kia available hai') shows every category's items with prices", async () => {
  const result = await drive(freshSession(), "or kia kia available hai", scriptedFetch(plan({ reply: "Poora menu yeh hai" })));
  for (const category of menu.categories) {
    for (const item of category.items) {
      assertItemWithPrice(result.reply, item.name, item.price);
    }
  }
  assertEveryBulletHasPrice(result.reply);
});

// ─── 3. Clarification replies include prices, whole-category AND narrower

test("pasta clarification ('mujhe pasta chahiye') shows all 5 pasta options with prices", async () => {
  const result = await drive(freshSession(), "mujhe pasta chahiye", scriptedFetch(plan({ reply: "Kaunsa pasta?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  for (const item of menu.categories.find((c) => c.key === "pasta")!.items) {
    assertItemWithPrice(result.reply, item.name, item.price);
  }
  assertEveryBulletHasPrice(result.reply);
});

test("a narrower family clarification (bare 'zinger', 3 of 6 burgers) ALSO shows prices, not just the whole-category case", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger kardo",
    scriptedFetch(plan({ reply: "Kaunsa zinger?", cartActions: [{ type: "add_item", query: "zinger" }] }))
  );
  assertEveryBulletHasPrice(result.reply);
  assertItemWithPrice(result.reply, "Zinger Burger", 500);
  assertItemWithPrice(result.reply, "Zinger Burger W/C", 550);
  assertItemWithPrice(result.reply, "Jumbo Zinger", 750);
});

test("renderClarificationPromptIfApplicable renders a narrow family ambiguity with real prices and a title-cased label", () => {
  const menuFixture = menu;
  const zingerItems = menuFixture.categories.find((c) => c.key === "burgers")!.items.filter((i) => i.name.toLowerCase().includes("zinger"));
  const reply = renderClarificationPromptIfApplicable([{ category: "zinger", quantity: 1, options: zingerItems }], menuFixture);
  assert.ok(reply);
  assert.match(reply!, /Zinger/);
  for (const item of zingerItems) assertItemWithPrice(reply!, item.name, item.price);
});

// ─── 4. Recommendation replies include prices ──────────────────────────────

test("spicy recommendation ('kuch spicy suggest karo') shows items with prices", async () => {
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(plan({ reply: "Zaroor, spicy chahiye!", recommendationRequest: { theme: "spicy" } }))
  );
  assertEveryBulletHasPrice(result.reply);
});

test("a recommendation reply that names items but omits ANY price is replaced with a fully-priced list", async () => {
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(plan({ reply: "Spicy Stuff Burger aur Hot Shot try karein, dono acha hain.", recommendationRequest: { theme: "spicy" } }))
  );
  assertEveryBulletHasPrice(result.reply);
  assert.match(result.reply, /Spicy Stuff Burger/);
});

test("the raw-text theme-suggestion fallback (model failed to classify) also shows prices", async () => {
  const result = await drive(freshSession(), "hot and spicy ma kuch batao mujhe", scriptedFetch(plan({ reply: "Backend aapko dikha dega." })));
  assertEveryBulletHasPrice(result.reply);
});

// ─── 5. Blanket invariant: no menu/category/clarification/recommendation
// reply in this whole scenario set ever names an item without its price ───

test("no menu/category/clarification/recommendation reply contains a bulleted item line without a PKR price", async () => {
  const scenarios: [string, ReturnType<typeof plan>][] = [
    ["pizza menu dikhao", plan({ reply: "Pizza Menu" })],
    ["burgers dikhao", plan({ reply: "Burgers" })],
    ["mujhe pasta chahiye", plan({ reply: "Kaunsa pasta?", cartActions: [{ type: "add_item", query: "pasta" }] })],
    ["ek zinger kardo", plan({ reply: "Kaunsa zinger?", cartActions: [{ type: "add_item", query: "zinger" }] })],
    ["kuch spicy suggest karo", plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })],
    ["or kia kia available hai", plan({ reply: "Poora menu yeh hai" })],
  ];
  for (const [message, script] of scenarios) {
    const result = await drive(freshSession(), message, scriptedFetch(script));
    const bulletLines = result.reply.split("\n").filter((line) => line.trim().startsWith("•"));
    for (const line of bulletLines) {
      assert.match(line, /PKR \d+/, `"${message}" produced a priceless menu line: "${line}"`);
    }
  }
});
