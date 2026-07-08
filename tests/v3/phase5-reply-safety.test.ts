// V3 Phase 5 — Reply Safety: internal-term leakage, availability/menu
// intent, and location-context bugs found via live browser testing.
//
// Three real bugs, each fixed with a deterministic, backend-driven
// override (same "backend facts override the LLM's narration" posture as
// every prior V3 phase) plus a hard blocklist as a last-resort net:
// 1. A themed-suggestion request ("hot and spicy ma kuch batao mujhe") the
//    model failed to classify (recommendationRequest stayed null) got a
//    bare, internal-sounding deflection ("Backend aapko menu se spicy
//    items dikha dega.") instead of real items.
// 2. A general-availability question using the "kia kia" (alternate
//    spelling of "kya kya") idiom matched neither the listing-intent gate
//    nor the full-menu pattern, so it fell through to the model's own
//    draft with nothing keeping it honest — live symptom was a menu
//    heading with no items under it.
// 3. A pure location question ("kahan hai") got a stray, unrelated menu
//    reference from the model, with only the real address appended AFTER
//    it (additive-only verifyRestaurantInfo was never meant to police the
//    REST of the sentence).
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase5-reply-safety.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import {
  renderThemeSuggestionIfApplicable,
  renderCategoryBrowseIfApplicable,
  renderRestaurantInfoIfApplicable,
} from "../../v3/agent/fact-verifier";
import { normalizeReply, containsInternalTerms } from "../../v3/agent/reply-normalizer";

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

// ─── Bug 1: internal-word leakage on a spicy suggestion request ────────────

test("1. 'hot and spicy ma kuch batao mujhe' never leaks internal words, even when the model drafts a bare deflection", async () => {
  const result = await drive(
    freshSession(),
    "hot and spicy ma kuch batao mujhe",
    scriptedFetch(plan({ reply: "Backend aapko menu se spicy items dikha dega." }))
  );
  assertNoInternalTerms(result.reply);
  assert.doesNotMatch(result.reply, /backend/i, "the exact reported leak must be gone");
});

test("2. the spicy suggestion reply names only real spicy menu items", async () => {
  const result = await drive(
    freshSession(),
    "hot and spicy ma kuch batao mujhe",
    scriptedFetch(plan({ reply: "Backend aapko menu se spicy items dikha dega." }))
  );
  assert.match(result.reply, /Spicy Stuff Burger|Hot Shot/i);
  // No cart mutation — this is a suggestion, not an order.
  assert.equal(result.session.conversation.order.cart.items.length, 0);
});

test("renderThemeSuggestionIfApplicable resolves 'spicy' straight from raw text, independent of the model's own classification", () => {
  const reply = renderThemeSuggestionIfApplicable("hot and spicy ma kuch batao mujhe", menu, false, undefined);
  assert.ok(reply, "expected a deterministic spicy suggestion");
  assert.match(reply!, /PKR/);
  assert.doesNotMatch(reply!, /backend/i);
});

test("theme suggestion override never fires when the model already classified the request correctly AND priced it", async () => {
  // recommendationRequest IS set — verifyRecommendation (not the raw-text
  // fallback) owns this turn; since the model's own draft already names
  // every recommended item WITH its exact real price, it's preserved as-is
  // (menu-price-formatting fix: a name mention alone is no longer enough).
  const result = await drive(
    freshSession(),
    "kuch spicy suggest karo",
    scriptedFetch(
      plan({
        reply: "Zaroor, yeh spicy hai: Spicy Stuff Burger (PKR 700) aur Hot Shot 8 pcs with fries (PKR 800).",
        recommendationRequest: { theme: "spicy" },
      })
    )
  );
  assert.match(result.reply, /Zaroor, yeh spicy hai/);
});

test("theme suggestion override never fires on a turn that already added/removed/checked out", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo, spicy chahiye",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya, spicy pasand hai aapko!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  assert.match(result.reply, /Zinger Burger add ho gaya/);
  assert.equal(result.session.conversation.order.cart.items.length, 1);
});

// ─── Bug 2: general-availability / full-menu question ──────────────────────

test("3. 'or kia kia available hai hamre pass' includes real menu/category content, never a blank heading", async () => {
  const result = await drive(
    freshSession(),
    "or kia kia available hai hamre pass",
    scriptedFetch(plan({ reply: "Hamare paas poora menu yeh hai:" }))
  );
  assert.match(result.reply, /•/, "must contain at least one real menu line, not just a heading");
  assert.match(result.reply, /PKR/);
});

test("renderCategoryBrowseIfApplicable recognizes 'kia kia' (alternate spelling of 'kya kya') as a full-menu request", () => {
  const reply = renderCategoryBrowseIfApplicable("or kia kia available hai hamre pass", menu, false);
  assert.ok(reply, "expected the full menu to render");
  assert.match(reply!, /•/);
});

test("6. no blank menu heading ever ships without menu content, across every full-menu phrasing", () => {
  const phrasings = ["kya kya available hai", "kia kia available hai", "poora menu dikhao", "full menu batao", "menu"];
  for (const message of phrasings) {
    const reply = renderCategoryBrowseIfApplicable(message, menu, false);
    assert.ok(reply, `expected menu content for "${message}"`);
    assert.match(reply!, /•/, `"${message}" produced a heading with no items`);
  }
});

// ─── Bug 3: location/address question must never mention the menu ─────────

test("4. 'kahan hai' returns the restaurant address only, never menu content", async () => {
  const result = await drive(freshSession(), "kahan hai", scriptedFetch(plan({ reply: "Hamare paas poora menu yeh hai:" })));
  assert.match(result.reply, new RegExp(restaurantConfig.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.reply, /poora menu/i);
  assert.doesNotMatch(result.reply, /•/, "a pure location question must not list menu items");
});

test("renderRestaurantInfoIfApplicable replaces (not appends to) a pure info-only question", () => {
  const reply = renderRestaurantInfoIfApplicable("kahan hai", restaurantConfig, false);
  assert.equal(reply, `Address: ${restaurantConfig.address}`);
});

test("renderRestaurantInfoIfApplicable never fires on a combined menu+info ask, leaving it to the additive-only checker", () => {
  const reply = renderRestaurantInfoIfApplicable("menu dikhao aur yeh bhi batao aap kahan hain", restaurantConfig, false);
  assert.equal(reply, null);
});

test("restaurant-info override never fires on a turn that already did something structural", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  assert.match(result.reply, /Zinger Burger add ho gaya/);
});

// ─── Context memory must not confuse a menu question with a location one ──

test("5. a location question right after a menu question answers ONLY the location, never re-showing the menu", async () => {
  let session = freshSession();
  const menuTurn = await drive(session, "or kia kia available hai hamre pass", scriptedFetch(plan({ reply: "Hamare paas poora menu yeh hai:" })));
  session = menuTurn.session;
  assert.match(menuTurn.reply, /•/);

  const locationTurn = await drive(session, "kahan hai", scriptedFetch(plan({ reply: "Hamare paas poora menu yeh hai:" })));
  assert.match(locationTurn.reply, new RegExp(restaurantConfig.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(locationTurn.reply, /poora menu/i);
  assert.doesNotMatch(locationTurn.reply, /•/);
});

// ─── Hard blocklist end-to-end, across the whole reported bug set ─────────

test("every scenario in this file is free of every required blocklisted word after normalizeReply", () => {
  const rawReplies = [
    "Backend aapko menu se spicy items dikha dega.",
    "System is busy right now, humara internal tool JSON return kar raha hai.",
    "V2 aur V3 engine dono provider gateway use karte hain internal tarike se.",
  ];
  for (const raw of rawReplies) {
    assert.equal(containsInternalTerms(raw), true, "sanity: the raw text should trip the detector");
    const cleaned = normalizeReply(raw);
    for (const word of INTERNAL_WORDS) {
      assert.doesNotMatch(cleaned, new RegExp(`\\b${word}\\b`, "i"), `"${raw}" -> leaked "${word}"`);
    }
  }
});
