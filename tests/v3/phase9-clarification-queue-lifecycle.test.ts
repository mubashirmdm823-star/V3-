// V3 Phase 9 — Clarification Queue Lifecycle (production regression repair).
//
// Root cause: actions.ts#runAdd only ever attempted to resolve a pending
// clarification queue when the customer's reply carried EXACTLY ONE item
// mention (`mentions.length === 1`). A multi-question queue (e.g. "5 pasta
// ek chowmein" queues a pasta ambiguity AND a chowmein ambiguity) is often
// answered with a multi-item reply in one message ("do small ek mexican ek
// macaroni ek vegetable" — 3 mentions answer pasta, 1 answers chowmein).
// That multi-mention reply bypassed queue resolution ENTIRELY and fell
// through to runFreshAdd, which treats it as a brand-new, independent add
// — the right items happened to land in the cart, but the ORIGINAL queue
// entries were never consumed/removed. The clarificationQueue stayed
// non-empty even though the customer had just answered it.
//
// Why the replay happened: with a stale, never-cleared queue still sitting
// in OrderContext, the model's own prompt context kept showing "you still
// have a pending clarification" turn after turn — so even a bare "ok"
// could make the model redraft the exact same add_multiple_items action,
// landing every item a second time (duplicating quantities).
//
// Why it can't happen again:
//   1. clarification-engine.ts#resolvePendingAddMulti resolves EVERY
//      mention against whichever queue entry's own option list it matches
//      (never the whole menu) and removes EVERY queue entry that got at
//      least one mention resolved against it — a multi-mention answer can
//      now fully drain a multi-entry queue in one turn, exactly like the
//      single-mention path already did for a single-entry queue.
//   2. actions.ts#applyAgentActions now takes the raw customer message and
//      strips cartActions entirely whenever it's a bare acknowledgment
//      (conversation-memory.ts#isBareAcknowledgment — an EXACT, case-
//      insensitive match to the whole trimmed message, never a substring)
//      — a deterministic backstop independent of whether the model
//      "behaves," so "ok"/"thanks"/"theek hai" can never mutate the cart
//      or replay a prior mutation, even if the model drafts a cartAction.
//
// Same scripted-fetch convention as the rest of tests/v3/ — no network
// call, no flakiness.
//
// Run with: npx tsx --test tests/v3/phase9-clarification-queue-lifecycle.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";
import { isBareAcknowledgment } from "../../v3/agent/conversation-memory";
import { resolvePendingAddMulti } from "../../v3/agent/clarification-engine";
import { getClarificationQueue } from "../../v2/order-state-engine/clarification";
import { createConversationContext } from "../../v2/core/context-manager";

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

function cartMap(session: AgentSession): Map<string, number> {
  return new Map(session.conversation.order.cart.items.map((l) => [l.itemId, l.qty]));
}

// ─── Full bug-reproduction flow, exactly as reported ───────────────────────

test("full reproduction: 5-pasta + chowmein + burger clarification, answered burger-first then multi-item, never duplicates, then 'ok' replays nothing", async () => {
  let session = freshSession();

  // Turn 1: queues 3 independent ambiguities. Mentions ordered [burger,
  // pasta, chowmein] to reproduce the live model's own choice to ask about
  // burger first (this project's tests script the model's plan directly —
  // the ORDER a real model lists items in is its own choice, not something
  // this fix controls or needs to).
  const queued = await drive(
    session,
    "mujhe 5 pasta ek chowmein or ek burger chahiye",
    scriptedFetch(
      plan({
        reply: "Aap kaunsa burger chahenge?",
        cartActions: [
          {
            type: "add_multiple_items",
            items: [
              { query: "burger", quantity: 1 },
              { query: "pasta", quantity: 5 },
              { query: "chowmein", quantity: 1 },
            ],
          },
        ],
      })
    )
  );
  session = queued.session;
  assert.equal(session.conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(getClarificationQueue(session.conversation.order).length, 3);

  // Turn 2: single-mention answer resolves the FIRST queued question
  // (burger) — the pre-existing, unmodified single-mention path.
  const afterBurger = await drive(
    session,
    "smoke",
    scriptedFetch(plan({ reply: "Smoke Burger add ho gaya.", cartActions: [{ type: "add_item", query: "smoke" }] }))
  );
  session = afterBurger.session;
  assert.equal(session.conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(getClarificationQueue(session.conversation.order).length, 2, "pasta and chowmein still pending");
  assert.equal(cartMap(session).get("smoke-burger"), 1);

  // Turn 3: ONE multi-mention message answers BOTH remaining questions —
  // this is the exact shape that used to bypass queue resolution entirely.
  const resolved = await drive(
    session,
    "do small ek mexican or ek macaroni or ek vegetable",
    scriptedFetch(
      plan({
        reply: "Aapka order confirm ho gaya hai. Main 2 Pasta Small, 1 Mexican Pasta, 1 Macaroni Pasta, aur 1 Vegetable Chowmein add kar raha hoon.",
        cartActions: [
          {
            type: "add_multiple_items",
            items: [
              { query: "small", quantity: 2 },
              { query: "mexican", quantity: 1 },
              { query: "macaroni", quantity: 1 },
              { query: "vegetable", quantity: 1 },
            ],
          },
        ],
      })
    )
  );
  session = resolved.session;

  // 1/2. The queue executed exactly once and is now fully empty.
  assert.equal(getClarificationQueue(session.conversation.order).length, 0, "queue must be fully drained after the multi-item answer");
  assert.equal(session.conversation.order.state, "CART_EDITING");

  // 7. No duplicate quantities — each item landed exactly once.
  const cart = cartMap(session);
  assert.equal(cart.get("smoke-burger"), 1);
  assert.equal(cart.get("pasta-small"), 2);
  assert.equal(cart.get("mexican-pasta-white-sauce"), 1);
  assert.equal(cart.get("macaroni-pasta-red-sauce"), 1);
  assert.equal(cart.get("vegetable-chowmein"), 1);

  // Wording fix: "order confirm ho gaya" is false (no checkout happened) —
  // must be replaced with an honest cart-mutation confirmation. This turn
  // resolves 3 mutual pasta-family siblings (small/mexican/macaroni) from
  // the same original 5-option ambiguity together, so it also qualifies
  // for the multi-variant-sibling-resolution correction (see
  // correct-reply.ts#correctMultiVariantResolution) — an even more
  // accurate, fully-itemized real-cart summary than the older generic
  // fallback lines, so both are accepted here.
  assert.doesNotMatch(resolved.reply, /order confirm ho gaya/i);
  assert.match(resolved.reply, /cart mein add kar diye gaye hain|cart update kar diya gaya hai|Cart update ho gaya/);

  // Turn 4: "ok" must NEVER replay the mutation, even if the model
  // (confused by its own prior turn) redrafts the exact same action.
  const afterOk = await drive(
    session,
    "ok",
    scriptedFetch(
      plan({
        reply: "Aapka order confirm ho gaya hai. Main 2 Pasta Small, 1 Mexican Pasta, 1 Macaroni Pasta, aur 1 Vegetable Chowmein add kar raha hoon.",
        cartActions: [
          {
            type: "add_multiple_items",
            items: [
              { query: "small", quantity: 2 },
              { query: "mexican", quantity: 1 },
              { query: "macaroni", quantity: 1 },
              { query: "vegetable", quantity: 1 },
            ],
          },
        ],
      })
    )
  );
  session = afterOk.session;
  const cartAfterOk = cartMap(session);
  assert.equal(cartAfterOk.get("smoke-burger"), 1, "no replay: still exactly 1");
  assert.equal(cartAfterOk.get("pasta-small"), 2, "no replay: still exactly 2");
  assert.equal(cartAfterOk.get("mexican-pasta-white-sauce"), 1, "no replay: still exactly 1");
  assert.equal(cartAfterOk.get("macaroni-pasta-red-sauce"), 1, "no replay: still exactly 1");
  assert.equal(cartAfterOk.get("vegetable-chowmein"), 1, "no replay: still exactly 1");

  // 6. Order review after clarification shows the correct final quantities.
  // Uses "order dikhao" (already recognized by the existing, untouched
  // order-review pattern in fact-verifier.ts) rather than the exact
  // "order bataen" phrasing from the live bug report — "bataen" is a verb
  // conjugation that pattern doesn't happen to recognize, a separate,
  // pre-existing gap unrelated to the queue-lifecycle bug and explicitly
  // out of scope here (fact-verifier.ts is off-limits for this fix);
  // verified instead via live browser validation in the final report.
  const review = await drive(session, "order dikhao", scriptedFetch(plan({ reply: "Aapka current order yeh hai:" })));
  assert.match(review.reply, /Smoke Burger.*1|1.*Smoke Burger/i);
  assert.match(review.reply, /Pasta Small.*2|2.*Pasta Small/i);
  assert.match(review.reply, /PKR 550/); // Smoke Burger
  assert.match(review.reply, /PKR 1000|PKR 500/); // Pasta Small line (500 x2=1000) or unit price present
  const expectedTotal = 550 + 500 * 2 + 850 + 750 + 600;
  assert.match(review.reply, new RegExp(`Total: PKR ${expectedTotal}`));
});

// ─── 3/4/5. Bare acknowledgments never mutate the cart ─────────────────────

for (const ack of ["ok", "thanks", "theek hai"]) {
  test(`'${ack}' never mutates the cart, even if the model drafts a cartAction for it`, async () => {
    let session = freshSession();
    const added = await drive(
      session,
      "ek zinger burger dedo",
      scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
    );
    session = added.session;
    assert.equal(cartMap(session).get("zinger-burger"), 1);

    const result = await drive(
      session,
      ack,
      scriptedFetch(plan({ reply: "Theek hai!", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
    );
    assert.equal(cartMap(result.session).get("zinger-burger"), 1, `"${ack}" must not add another Zinger Burger`);
    assert.equal(result.session.conversation.order.cart.items.length, 1);
  });
}

test("isBareAcknowledgment unit: matches only the documented exact words, never a longer sentence", () => {
  for (const word of ["ok", "okay", "thanks", "thank you", "theek hai", "acha", "done", "haan", "👍"]) {
    assert.equal(isBareAcknowledgment(word), true, `"${word}" should be a bare acknowledgment`);
    assert.equal(isBareAcknowledgment(` ${word.toUpperCase()} `), true, "case/whitespace-insensitive");
  }
  assert.equal(isBareAcknowledgment("haan ye wala add kar do"), false, "a longer sentence must never be treated as a bare acknowledgment");
  assert.equal(isBareAcknowledgment("haan confirm"), false, "checkout confirmation phrasing must be unaffected");
});

// ─── 8. Checkout flow still works ───────────────────────────────────────────

test("8. checkout flow still works end to end after the queue-lifecycle fix", async () => {
  let session = freshSession();
  const added = await drive(
    session,
    "ek zinger burger dedo",
    scriptedFetch(plan({ reply: "Zinger Burger add ho gaya.", cartActions: [{ type: "add_item", query: "zinger burger" }] }))
  );
  session = added.session;
  const checkout = await drive(session, "checkout", scriptedFetch(plan({ reply: "Delivery ya pickup?", checkoutAction: { type: "start_checkout" } })));
  assert.match(checkout.reply, /Order Review/i);
  assert.match(checkout.reply, /Zinger Burger/);
  assert.equal(checkout.session.conversation.order.state, "ORDER_REVIEW");
});

// ─── Unit test: resolvePendingAddMulti drains every matched queue entry ────

test("resolvePendingAddMulti unit: drains both queue entries in one call and leaves nothing behind", () => {
  const context = createConversationContext("c", "s").order;
  const pastaOptions = menu.categories.find((c) => c.key === "pasta")!.items;
  const chowmeinOptions = menu.categories.find((c) => c.key === "noodles")!.items;
  const queue = [
    { category: "pasta", quantity: 5, options: pastaOptions, question: "Aap kaunsa Pasta chahenge?", previousMessage: "" },
    { category: "noodles", quantity: 1, options: chowmeinOptions, question: "Aap kaunsa Noodles chahenge?", previousMessage: "" },
  ];
  const result = resolvePendingAddMulti(
    context,
    queue,
    [
      { query: "small", quantity: 2 },
      { query: "mexican", quantity: 1 },
      { query: "macaroni", quantity: 1 },
      { query: "vegetable", quantity: 1 },
    ],
    menu
  );
  assert.ok(result);
  assert.equal(getClarificationQueue(result!.context).length, 0);
  const cart = new Map(result!.context.cart.items.map((l) => [l.itemId, l.qty]));
  assert.equal(cart.get("pasta-small"), 2);
  assert.equal(cart.get("mexican-pasta-white-sauce"), 1);
  assert.equal(cart.get("macaroni-pasta-red-sauce"), 1);
  assert.equal(cart.get("vegetable-chowmein"), 1);
});

test("resolvePendingAddMulti unit: returns null when no mention matches any queue entry (caller falls through to a fresh add)", () => {
  const context = createConversationContext("c", "s").order;
  const pastaOptions = menu.categories.find((c) => c.key === "pasta")!.items;
  const queue = [{ category: "pasta", quantity: 5, options: pastaOptions, question: "Aap kaunsa Pasta chahenge?", previousMessage: "" }];
  const result = resolvePendingAddMulti(context, queue, [{ query: "zinger burger", quantity: 1 }, { query: "gyro", quantity: 1 }], menu);
  assert.equal(result, null);
});
