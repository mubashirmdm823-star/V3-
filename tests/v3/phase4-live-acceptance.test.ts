// V3 Phase 4 — Live Acceptance Testing regression tests.
//
// A 100-conversation live run against the real /api/chat path (AI_ENGINE=v3,
// real provider failover) found exactly one genuine bug: in a family-scoped
// clarification ("ek zinger dedo" -> which Zinger?), the model sometimes
// passes a raw, item-id-shaped query ("zinger-burger") instead of natural
// words ("zinger burger"). V2's `compact()` (v2/intent-parser/matching.ts)
// only strips whitespace, never hyphens, so the hyphenated query missed
// both the exact-match and substring-match tiers and fell through to
// token-scoring, which matched 2+ candidates (still ambiguous) instead of
// resolving uniquely — and nothing corrected the model's premature
// "added" claim. Fixed with two independent, complementary changes:
//   1. reference-resolver.ts#normalizeQueryText strips hyphens/underscores
//      before ANY query reaches V2's matching functions (actions.ts and
//      clarification-engine.ts both apply it now).
//   2. fact-verifier.ts#verifyClarificationStillAmbiguous corrects a false
//      claim even when a reply is genuinely still ambiguous (defense in
//      depth for any OTHER way this class of mismatch could occur).
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase4-live-acceptance.test.ts

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

// ─── Live-acceptance bug #1: hyphenated query fails a family clarification ─

test("1. a hyphenated query ('zinger-burger') answering a Zinger-family clarification still resolves correctly (live bug repro)", async () => {
  let session = freshSession();
  const asked = await drive(
    session,
    "ek zinger dedo",
    scriptedFetch(
      plan({
        reply: "Aapko kaunsa Zinger burger chahiye? Ye options hain: Zinger Burger, Zinger Burger W/C, Jumbo Zinger.",
        cartActions: [{ type: "add_item", query: "zinger" }],
      })
    )
  );
  session = asked.session;
  assert.equal(session.conversation.order.state, "AWAITING_CLARIFICATION");

  // The exact live-observed model behavior: the reply claims success, but
  // the query is the raw item-id shape, not natural words.
  const answered = await drive(
    session,
    "zinger burger",
    scriptedFetch(plan({ reply: "Aapka Zinger Burger add kar diya gaya hai. Aur kuch chahiye?", cartActions: [{ type: "add_item", query: "zinger-burger" }] }))
  );

  assert.equal(answered.session.conversation.order.cart.items.length, 1, "the item must actually be added, not left ambiguous");
  assert.equal(answered.session.conversation.order.cart.items[0].itemId, "zinger-burger");
  assert.equal(answered.session.conversation.order.state, "CART_EDITING", "must leave AWAITING_CLARIFICATION once resolved");
  assert.match(answered.reply, /Zinger Burger/);
});

// ─── Live-acceptance bug #2: a genuinely still-ambiguous reply must never
// let the model's premature "added" claim stand ─────────────────────────

test("2. a genuinely still-ambiguous clarification reply corrects a false 'added' claim instead of leaving it uncorrected", async () => {
  let session = freshSession();
  const asked = await drive(
    session,
    "ek zinger dedo",
    scriptedFetch(
      plan({
        reply: "Aapko kaunsa Zinger burger chahiye? Ye options hain: Zinger Burger, Zinger Burger W/C, Jumbo Zinger.",
        cartActions: [{ type: "add_item", query: "zinger" }],
      })
    )
  );
  session = asked.session;

  // Bare "zinger" still matches all 3 family options — genuinely ambiguous.
  const answered = await drive(
    session,
    "zinger",
    scriptedFetch(plan({ reply: "Aapka Zinger Burger add kar diya gaya hai!", cartActions: [{ type: "add_item", query: "zinger" }] }))
  );

  assert.equal(answered.session.conversation.order.cart.items.length, 0, "nothing should be added while still ambiguous");
  assert.equal(answered.session.conversation.order.state, "AWAITING_CLARIFICATION");
  assert.doesNotMatch(answered.reply, /add kar diya gaya hai/i, "the model's premature success claim must be corrected away");
  assert.match(answered.reply, /abhi bhi clear nahi/i);
  assert.match(answered.reply, /Zinger Burger W\/C/);
  assert.match(answered.reply, /Jumbo Zinger/);
});

// ─── Confirm the fix doesn't regress normal (non-hyphenated) resolution ───

test("3. a normal, already-correct clarification answer is unaffected by the normalization fix", async () => {
  let session = freshSession();
  const asked = await drive(session, "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Aap kaunsa pasta chahenge?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  session = asked.session;
  const answered = await drive(session, "alfredo", scriptedFetch(plan({ reply: "Alfredo add ho gaya.", cartActions: [{ type: "add_item", query: "alfredo" }] })));
  assert.equal(answered.session.conversation.order.cart.items[0]?.itemId, "alfredo-pasta-white-sauce");
});
