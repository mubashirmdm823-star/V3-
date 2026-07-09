// V3 Phase 17 — Multi-Variant Clarification Resolution & Conversational
// Context Grounding (Production Stabilization Mode bug fix).
//
// Reproduced bug (two symptoms from the SAME turn, plus a related second
// bug):
//   1. "or mujhe 6 chowmin bhi chahiye" -> "dono flavour 3 kardo" (both
//      flavors, 3 each): the backend cart correctly ended up with Chicken
//      Chowmein x3 and Vegetable Chowmein x3, but the REPLY wrongly said
//      "3 Vegetable Chowmein aur 3 Vegetable Chowmein" (Vegetable named
//      twice), AND the assistant asked "Aap kaunsa Noodles chahenge?"
//      again even though both variants were already resolved.
//   2. Separately: "alfredo hota hai aapke pass" (pure availability
//      question, no cart action) -> "g" (yes) -> "2" (quantity) wrongly
//      re-asked "kaunsa Pasta chahenge?" instead of preserving the Alfredo
//      context and adding Alfredo Pasta white sauce x2.
//
// Root causes, all fixed within the clarification/reply lifecycle only
// (cart logic itself was already correct per the bug report):
//   - v3/agent/actions.ts#applyAgentActions: the model sometimes splits
//     "add both variants" into TWO SEPARATE add_item cartActions instead
//     of one add_multiple_items action. Applying them one at a time meant
//     the FIRST action correctly resolved+cleared the pending queue entry,
//     but the SECOND then ran against an already-empty queue, fell
//     through to runFreshAdd, and widenUngroundedFamilyGuess (correctly,
//     by its own rule) widened it back into a brand-new clarification
//     since the raw turn text never literally said "vegetable". Fixed by
//     safely combining a run of consecutive add-shaped actions into ONE
//     resolvePendingAddMulti call — but ONLY when every mention in the
//     run is provably an answer to the CURRENT queue, so a run that mixes
//     a clarification answer with an unrelated new item is never
//     combined (see allMentionsAnswerQueue's own header for why).
//   - v3/agent/actions.ts#widenUngroundedFamilyGuess: grounding was
//     checked only against the CURRENT turn's raw message — now also
//     grounded when conversation-memory's lastMentionedItemName already
//     names this exact item (established memory, e.g. from an earlier
//     add — not the raw message repeating the name).
//   - v3/agent/conversation-memory.ts#deriveLastMentionName: a pure
//     availability Q&A turn ("alfredo hota hai aapke pass") that mutates
//     nothing left lastMentionedItemName completely unset, so a later "g"
//     had no established context to fall back on. Now also derives it
//     from the CUSTOMER's own message when exactly one real menu item is
//     unambiguously named there, even if nothing was added that turn.
//   - v3/agent/correct-reply.ts#correctMultiVariantResolution: when 2+
//     resolvedAmbiguities entries are MUTUAL siblings (both came from
//     resolving the SAME originally-ambiguous option set together),
//     Gemini's own wording is unreliable — replaced with a real,
//     backend-verified itemized cart summary.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase17-multi-variant-clarification.test.ts

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

function cartMap(result: Awaited<ReturnType<typeof drive>>) {
  return new Map(result.session.conversation.order.cart.items.map((l) => [l.itemId, l.qty]));
}

// ─── 1. Alfredo availability -> "g" -> "2" preserves context, no re-ask ────

test("1. Alfredo availability -> 'g' -> '2' adds Alfredo Pasta white sauce x2 without asking pasta clarification again", async () => {
  const session = freshSession();
  const asked = await drive(
    session,
    "alfredo hota hai aapke pass",
    scriptedFetch(plan({ reply: "Ji haan, Alfredo Pasta white sauce hai, PKR 850. Add karoon?" }))
  );
  const confirmed = await drive(
    asked.session,
    "g",
    scriptedFetch(plan({ reply: "Kitne chahiye?", cartActions: [{ type: "add_item", query: "Alfredo Pasta white sauce", quantity: 1 }] }))
  );
  assert.doesNotMatch(confirmed.reply, /kaunsa Pasta chahenge/i);
  const quantified = await drive(
    confirmed.session,
    "2",
    scriptedFetch(plan({ reply: "2 Alfredo add ho gaye!", cartActions: [{ type: "change_quantity", query: "Alfredo Pasta white sauce", quantity: 2 }] }))
  );
  assert.doesNotMatch(quantified.reply, /kaunsa Pasta chahenge/i);
  assert.equal(cartMap(quantified).get("alfredo-pasta-white-sauce"), 2);
});

// ─── 2/3/4/5/6/7. "dono flavour 3 kardo" resolves both chowmein variants ───

async function driveToDonoFlavourResolution() {
  const session = freshSession();
  const queued = await drive(
    session,
    "or mujhe 6 chowmin bhi chahiye",
    scriptedFetch(plan({ reply: "Kaunsa chowmein?", cartActions: [{ type: "add_item", query: "chowmein", quantity: 6 }] }))
  );
  const resolved = await drive(
    queued.session,
    "dono flavour 3 kardo",
    scriptedFetch(
      plan({
        reply: "Aapka order mein 3 Vegetable Chowmein aur 3 Vegetable Chowmein add kar raha hoon.",
        cartActions: [
          { type: "add_item", query: "chicken chowmein", quantity: 3 },
          { type: "add_item", query: "vegetable chowmein", quantity: 3 },
        ],
      })
    )
  );
  return resolved;
}

test("2. 'dono flavour 3 kardo' adds Chicken Chowmein x3 and Vegetable Chowmein x3", async () => {
  const resolved = await driveToDonoFlavourResolution();
  const cart = cartMap(resolved);
  assert.equal(cart.get("chicken-chowmein"), 3);
  assert.equal(cart.get("vegetable-chowmein"), 3);
});

test("3. reply must contain Chicken Chowmein x3", async () => {
  const resolved = await driveToDonoFlavourResolution();
  assert.match(resolved.reply, /Chicken Chowmein ×3/);
});

test("4. reply must contain Vegetable Chowmein x3", async () => {
  const resolved = await driveToDonoFlavourResolution();
  assert.match(resolved.reply, /Vegetable Chowmein ×3/);
});

test("5. reply must not contain 'Vegetable Chowmein aur 3 Vegetable Chowmein'", async () => {
  const resolved = await driveToDonoFlavourResolution();
  assert.doesNotMatch(resolved.reply, /Vegetable Chowmein aur 3 Vegetable Chowmein/);
});

test("6. clarification queue clears after both variants resolve", async () => {
  const resolved = await driveToDonoFlavourResolution();
  assert.equal(resolved.session.conversation.order.state, "CART_EDITING");
});

test("7. assistant must not ask 'Aap kaunsa Noodles chahenge?' again", async () => {
  const resolved = await driveToDonoFlavourResolution();
  assert.doesNotMatch(resolved.reply, /Aap kaunsa Noodles chahenge/i);
});

test("8. final cart total is PKR 5450 (with the pre-existing Alfredo x2)", async () => {
  const session = freshSession();
  const alfredo = await drive(
    session,
    "ek alfredo pasta white sauce add karo",
    scriptedFetch(plan({ reply: "Alfredo add ho gaya!", cartActions: [{ type: "add_item", query: "Alfredo Pasta white sauce", quantity: 2 }] }))
  );
  const queued = await drive(
    alfredo.session,
    "or mujhe 6 chowmin bhi chahiye",
    scriptedFetch(plan({ reply: "Kaunsa chowmein?", cartActions: [{ type: "add_item", query: "chowmein", quantity: 6 }] }))
  );
  const resolved = await drive(
    queued.session,
    "dono flavour 3 kardo",
    scriptedFetch(
      plan({
        reply: "Aapka order mein 3 Vegetable Chowmein aur 3 Vegetable Chowmein add kar raha hoon.",
        cartActions: [
          { type: "add_item", query: "chicken chowmein", quantity: 3 },
          { type: "add_item", query: "vegetable chowmein", quantity: 3 },
        ],
      })
    )
  );
  assert.match(resolved.reply, /Total: PKR 5450/);
});

// ─── 9/10. Existing single-mention clarifications still work ──────────────

test("9. existing single chowmein clarification still works", async () => {
  const asked = await drive(freshSession(), "ek chowmein add karo", scriptedFetch(plan({ reply: "Kaunsa chowmein?", cartActions: [{ type: "add_item", query: "chowmein" }] })));
  const result = await drive(asked.session, "chicken", scriptedFetch(plan({ reply: "Chicken Chowmein add ho gaya!", cartActions: [{ type: "add_item", query: "chicken" }] })));
  const cart = cartMap(result);
  assert.equal(cart.get("chicken-chowmein"), 1);
  assert.equal(cart.get("vegetable-chowmein"), undefined);
});

test("10. existing single pasta clarification still works", async () => {
  const asked = await drive(freshSession(), "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Kaunsa pasta?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  const result = await drive(asked.session, "alfredo", scriptedFetch(plan({ reply: "Alfredo add ho gaya.", cartActions: [{ type: "add_item", query: "alfredo" }] })));
  const cart = cartMap(result);
  assert.equal(cart.get("alfredo-pasta-white-sauce"), 1);
});
