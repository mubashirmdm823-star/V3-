// V3 Phase 12 — Backend/Reply Synchronization + Checkout Mutation Lock
// (Production Stabilization Mode bug class).
//
// Bug class: backend reply and cart state were not synchronized during
// ambiguous item handling and checkout/cart updates.
//
// Root causes fixed:
//
// 1. "Chowmein silently becomes Chicken Chowmein" — V2's own resolution
//    primitives already return every candidate for a bare, genuinely
//    ambiguous query ("chowmein" -> [chicken-chowmein, vegetable-chowmein]),
//    and buildActionPlan already asks for 2+ candidates — but nothing
//    verified the MODEL'S OWN query text was actually grounded in what the
//    customer said. When the model itself guesses a fully-specific variant
//    name ("chicken chowmein") instead of passing the ambiguous word
//    through, that guess resolves to exactly ONE candidate on its own
//    merits, completely bypassing the 0/1/2+ ambiguity design. Fixed in
//    actions.ts#widenUngroundedFamilyGuess: a single-candidate DIRECT
//    resolution is only trusted when the token(s) that distinguish it from
//    its same-category "family" siblings are themselves present in the
//    raw customer message; otherwise it widens back to the full family.
//    Once this is fixed, facts.newlyQueued is correctly populated, and the
//    ALREADY-EXISTING, already-tested reply-orchestrator clarification_new
//    tier (untouched by this fix) automatically replaces any false "added"
//    claim with the real clarification prompt — no orchestrator changes
//    needed.
//
// 2. No guard anywhere blocked cart mutations once the customer was past
//    ORDER_REVIEW into an actual checkout step (AWAITING_DELIVERY_PICKUP/
//    AWAITING_ADDRESS/AWAITING_NAME/READY_TO_SUBMIT/PENDING_VERIFICATION) —
//    checkout-guard.ts only ever overrode the CHECKOUT action, never
//    touched cartActions. Fixed via checkout-guard.ts#isCartMutationLocked
//    (new) + actions.ts#applyAgentActions skipping the cartActions loop
//    entirely while locked, surfaced via a new TurnFacts.cartMutationBlocked
//    fact and correct-reply.ts#correctCartMutationBlocked.
//
// 3. A reply that claims to show "current order"/"order ab kuch is tarah
//    hai"/"order review" but lists no priced items is exactly as dishonest
//    as a false "added" claim. Fixed via correct-reply.ts#
//    correctIncompleteOrderClaim.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase12-backend-sync-checkout-lock.test.ts

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

function cartItems(result: Awaited<ReturnType<typeof drive>>) {
  return result.session.conversation.order.cart.items;
}

// ─── 1/2. Bare "chowmein"/"chowmin" always asks Chicken/Vegetable ─────────

test("1. 'ek chowmein add karo' asks Chicken/Vegetable clarification, never auto-adds", async () => {
  const result = await drive(
    freshSession(),
    "ek chowmein add karo",
    scriptedFetch(plan({ reply: "Ek Chowmein add kar raha hoon.", cartActions: [{ type: "add_item", query: "chowmein" }] }))
  );
  assert.equal(cartItems(result).length, 0, "chowmein must never be auto-added");
  assert.match(result.reply, /Chicken Chowmein/);
  assert.match(result.reply, /Vegetable Chowmein/);
  assert.doesNotMatch(result.reply, /add kar raha hoon/i);
});

// NOTE: this test previously asserted "chowmin" (missing the final "e")
// triggers the same Chicken/Vegetable clarification as "chowmein" — that
// assertion was a false pass: it only ever worked because a separate,
// now-fixed bug (the menu-intro-only backstop firing on any "available
// nahi" reply mentioning "menu") accidentally replaced the honest
// "chowmin ... available nahi hai" rejection with the full menu dump,
// which happened to contain the words "Chicken Chowmein"/"Vegetable
// Chowmein" as an unrelated side effect. V2's own fuzzy matching does not
// actually resolve "chowmin" -> the chowmein family (a separate,
// pre-existing, out-of-scope limitation — confirmed directly via
// resolveItemQuery("chowmin", ...) returning zero candidates). What this
// test actually verifies now: the typo is honestly rejected as
// unavailable, never silently guessed, never invented, cart stays empty.
test("2. 'ek chowmin add karo' (typo) is honestly rejected as unavailable, never silently guessed", async () => {
  const result = await drive(
    freshSession(),
    "ek chowmin add karo",
    scriptedFetch(plan({ reply: "Ek Chowmin add kar raha hoon.", cartActions: [{ type: "add_item", query: "chowmin" }] }))
  );
  assert.equal(cartItems(result).length, 0, "chowmin must never be auto-added");
  assert.match(result.reply, /available nahi/i);
  assert.doesNotMatch(result.reply, /Chicken Chowmein add|Vegetable Chowmein add/i);
});

// ─── 3/4. Answering the chowmein clarification adds the right variant ─────

test("3. 'chicken' after the chowmein clarification adds Chicken Chowmein", async () => {
  const session = freshSession();
  const asked = await drive(
    session,
    "ek chowmein add karo",
    scriptedFetch(plan({ reply: "Kaunsa chowmein?", cartActions: [{ type: "add_item", query: "chowmein" }] }))
  );
  const result = await drive(asked.session, "chicken", scriptedFetch(plan({ reply: "Chicken Chowmein add ho gaya!", cartActions: [{ type: "add_item", query: "chicken" }] })));
  const line = cartItems(result).find((i) => i.name === "Chicken Chowmein");
  assert.ok(line, "Chicken Chowmein should be in the cart");
  assert.equal(line!.qty, 1);
});

test("4. 'vegetable' after the chowmein clarification adds Vegetable Chowmein", async () => {
  const session = freshSession();
  const asked = await drive(
    session,
    "ek chowmein add karo",
    scriptedFetch(plan({ reply: "Kaunsa chowmein?", cartActions: [{ type: "add_item", query: "chowmein" }] }))
  );
  const result = await drive(asked.session, "vegetable", scriptedFetch(plan({ reply: "Vegetable Chowmein add ho gaya!", cartActions: [{ type: "add_item", query: "vegetable" }] })));
  const line = cartItems(result).find((i) => i.name === "Vegetable Chowmein");
  assert.ok(line, "Vegetable Chowmein should be in the cart");
  assert.equal(line!.qty, 1);
});

// ─── 5. The exact reported bug: model guesses "Chicken Chowmein" itself and
// claims it was added — backend must still ask, never claim added ─────────

test("5. LLM draft claims Chicken Chowmein added but the query is ungrounded -> final reply asks clarification, not a false 'added' claim", async () => {
  const result = await drive(
    freshSession(),
    "ek chowmein add karo",
    scriptedFetch(
      plan({
        reply: "Ek Chicken Chowmein add kar raha hoon. Aapka order ab kuch is tarah hai:",
        cartActions: [{ type: "add_item", query: "chicken chowmein" }],
      })
    )
  );
  assert.equal(cartItems(result).length, 0, "nothing should have been added — the customer never said which variant");
  assert.doesNotMatch(result.reply, /add kar raha hoon|add ho gaya|add ho chuka/i);
  assert.match(result.reply, /Chicken Chowmein/);
  assert.match(result.reply, /Vegetable Chowmein/);
});

// ─── 6. Any reply claiming "current order"/"order review" must include the
// real itemized cart + total ─────────────────────────────────────────────

test("6. a reply claiming 'order ab kuch is tarah hai' with no items is replaced with the real itemized cart + total", async () => {
  const result = await drive(
    freshSession(),
    "ek zinger burger add karo",
    scriptedFetch(
      plan({
        reply: "Ek Zinger Burger add kar raha hoon. Aapka order ab kuch is tarah hai:",
        cartActions: [{ type: "add_item", query: "zinger burger" }],
      })
    )
  );
  assert.match(result.reply, /Zinger Burger/);
  assert.match(result.reply, /PKR \d+/);
  assert.match(result.reply, /Total: PKR \d+/);
});

// ─── 7/8. Checkout mutation lock ───────────────────────────────────────────
//
// AWAITING_DELIVERY_PICKUP (not AWAITING_NAME/AWAITING_ADDRESS) is the
// clean state to prove the NEW lock's exact wording: checkout-guard.ts
// already has its own deterministic, honest re-prompt for AWAITING_NAME/
// AWAITING_ADDRESS ("please tell me your name/address" — never a lie
// either, just different wording, and untouched by this fix), which wins
// the tier race there. AWAITING_DELIVERY_PICKUP has no such existing
// special-case, so it's where the new "checkout stage" message actually
// surfaces.

async function driveToAwaitingDeliveryPickup(): Promise<AgentSession> {
  let session = freshSession();
  session = (
    await drive(session, "ek zinger burger add karo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] })))
  ).session;
  session = (await drive(session, "checkout karo", scriptedFetch(plan({ reply: "Checkout shuru.", checkoutAction: { type: "start_checkout" } })))).session;
  session = (await drive(session, "confirm order", scriptedFetch(plan({ reply: "Confirm ho gaya.", checkoutAction: { type: "confirm_order" } })))).session;
  assert.equal(session.conversation.order.state, "AWAITING_DELIVERY_PICKUP");
  return session;
}

test("7. after checkout starts (AWAITING_DELIVERY_PICKUP), 'ek chowmein bhi add karo' does not mutate the cart", async () => {
  const session = await driveToAwaitingDeliveryPickup();
  const before = cartItems({ session } as Awaited<ReturnType<typeof drive>>);
  const result = await drive(
    session,
    "ek chowmein bhi add karo",
    scriptedFetch(plan({ reply: "Chowmein bhi add kar diya!", cartActions: [{ type: "add_item", query: "chowmein" }] }))
  );
  assert.deepEqual(cartItems(result), before, "cart must be completely unchanged");
  assert.equal(result.session.conversation.order.state, "AWAITING_DELIVERY_PICKUP", "state must not change either");
  assert.match(result.reply, /checkout stage/i);
  assert.doesNotMatch(result.reply, /add kar diya|add ho gaya/i);
});

test("8. checkout continues normally after a blocked edit", async () => {
  const session = await driveToAwaitingDeliveryPickup();
  await drive(session, "ek chowmein bhi add karo", scriptedFetch(plan({ reply: "Chowmein add kar diya!", cartActions: [{ type: "add_item", query: "chowmein" }] })));
  // The blocked attempt must not have corrupted state — selecting pickup
  // now must still work exactly as it would have without the interruption.
  const result = await drive(session, "pickup", scriptedFetch(plan({ reply: "Pickup select ho gaya.", checkoutAction: { type: "select_pickup" } })));
  assert.equal(result.session.conversation.order.state, "AWAITING_NAME");
});

// ─── 9/10. Existing pasta/burger clarification still work ─────────────────

test("9. existing pasta clarification still works", async () => {
  const asked = await drive(freshSession(), "mujhe ek pasta chahiye", scriptedFetch(plan({ reply: "Kaunsa pasta?", cartActions: [{ type: "add_item", query: "pasta" }] })));
  for (const item of menu.categories.find((c) => c.key === "pasta")!.items) {
    assert.ok(asked.reply.includes(item.name), `expected "${item.name}" in:\n${asked.reply}`);
  }
  const result = await drive(asked.session, "alfredo", scriptedFetch(plan({ reply: "Theek hai!", cartActions: [{ type: "add_item", query: "alfredo" }] })));
  assert.ok(cartItems(result).length > 0, "pasta clarification should still resolve to a real add");
});

test("10. existing burger family clarification still works", async () => {
  const asked = await drive(freshSession(), "ek zinger kardo", scriptedFetch(plan({ reply: "Kaunsa zinger?", cartActions: [{ type: "add_item", query: "zinger" }] })));
  assert.match(asked.reply, /Zinger Burger/);
  assert.match(asked.reply, /Jumbo Zinger/);
  const result = await drive(asked.session, "jumbo", scriptedFetch(plan({ reply: "Jumbo Zinger add ho gaya!", cartActions: [{ type: "add_item", query: "jumbo" }] })));
  const line = cartItems(result).find((i) => i.name === "Jumbo Zinger");
  assert.ok(line, "Jumbo Zinger should be in the cart");
});

// ─── 11. Smoke: menu, recommendation, checkout still pass ─────────────────

test("11a. smoke: menu request still works", async () => {
  const result = await drive(freshSession(), "pizza menu dikhao", scriptedFetch(plan({ reply: "Pizza Menu" })));
  for (const item of menu.categories.find((c) => c.key === "pizza")!.items) {
    assert.ok(result.reply.includes(item.name));
  }
});

test("11b. smoke: recommendation still works and never auto-adds", async () => {
  const result = await drive(freshSession(), "kuch spicy suggest karo", scriptedFetch(plan({ reply: "Zaroor!", recommendationRequest: { theme: "spicy" } })));
  assert.match(result.reply, /PKR \d+/);
  assert.equal(cartItems(result).length, 0);
});

test("11c. smoke: checkout review-before-delivery still works", async () => {
  const session = freshSession();
  const addResult = await drive(session, "ek zinger burger add karo", scriptedFetch(plan({ reply: "Zinger Burger add ho gaya!", cartActions: [{ type: "add_item", query: "zinger burger" }] })));
  const result = await drive(addResult.session, "checkout", scriptedFetch(plan({ reply: "Chaliye!", checkoutAction: { type: "start_checkout" } })));
  assert.match(result.reply, /Order Review/i);
  assert.match(result.reply, /Delivery chahiye ya pickup/i);
});
