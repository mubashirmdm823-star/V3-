// Critical clarification resolver bug (reported 2026-07-07): answers to a
// pending clarification question were sometimes resolved against the WRONG
// category. "mujhe ek pasta chahiye" -> "mexican" added Mexican Sandwich
// instead of Mexican Pasta white sauce (the confirmation text quoted the
// first of 3 menu-wide "mexican" candidates instead of the item that
// actually landed); "mujhe ek pasta chahiye" -> "club" added Club Sandwich
// even though Club isn't a Pasta option at all.
//
// Root causes fixed in v2/order-state-engine/clarification.ts,
// v2/intent-parser/matching.ts, and v2/response-builder/index.ts:
//   1. resolveClarificationReply had an "already resolved by the stateless
//      parser" fast path that trusted ANY confident menu-wide resolution as
//      an answer, even when it pointed at an item outside the pending
//      category entirely ("club" resolves unambiguously menu-wide to Club
//      Sandwich). Removed — every reply is now re-resolved strictly against
//      pending.options (the exact items the question offered), never the
//      whole menu.
//   2. pending.category was stored as the raw customer query text (e.g.
//      "sandwich", "chowmein") which doesn't always match the real menu
//      category key ("sandwiches", "noodles") — this broke the category
//      lookup used to scope resolution. Fixed by scoping directly against
//      pending.options instead of re-deriving a MenuCategory from the label.
//   3. The single-item ADD_ITEM confirmation text read
//      action.items[0].candidateItemIds[0] (the raw, pre-clarification,
//      menu-wide first candidate) instead of the real cart before/after
//      diff — so even when the CART got the right item, the CONFIRMATION
//      TEXT could name a different one. Fixed to read the actual diff.
//
// Run with: npx tsx --test tests/v2/clarification-category-scope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import { Logger } from "../../v2/logger";
import { createConversationContext, type ConversationContext } from "../../v2/core/context-manager";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { ProcessMessageResult } from "../../v2/core/result";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

let counter = 0;
async function drive(messages: string[]): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  counter += 1;
  let conversation = createConversationContext(`ccs-${counter}`, `ccs-s-${counter}`);
  const logger = new Logger(`ccs-s-${counter}`, `ccs-${counter}`);
  let result!: ProcessMessageResult;
  for (const rawMessage of messages) {
    // env: {} — never let this test attempt a real LLM call regardless of
    // what's configured in the local environment.
    const out = await processCustomerMessage({ rawMessage, conversation, menu, restaurantConfig, logger, env: {} });
    conversation = out.conversation;
    result = out.result;
  }
  return { conversation, result };
}

function cartOf(conversation: ConversationContext): Array<[string, number]> {
  return conversation.order.cart.items.map((i) => [i.itemId, i.qty]);
}

test("1. pasta -> mexican adds Mexican Pasta white sauce, not Mexican Sandwich", async () => {
  const { conversation, result } = await drive(["mujhe ek pasta chahiye", "mexican"]);
  assert.deepEqual(cartOf(conversation), [["mexican-pasta-white-sauce", 1]]);
  assert.match(result.reply, /Mexican Pasta white sauce/);
  assert.doesNotMatch(result.reply, /Mexican Sandwich/);
});

test("2. sandwich -> mexican adds Mexican Sandwich, not Mexican Pasta", async () => {
  const { conversation, result } = await drive(["mujhe ek sandwich chahiye", "mexican"]);
  assert.deepEqual(cartOf(conversation), [["mexican-sandwich", 1]]);
  assert.match(result.reply, /Mexican Sandwich/);
});

test("3. pasta -> small adds Pasta Small", async () => {
  const { conversation, result } = await drive(["mujhe ek pasta chahiye", "small"]);
  assert.deepEqual(cartOf(conversation), [["pasta-small", 1]]);
  assert.match(result.reply, /Pasta Small/);
});

test("4. pasta -> club does not add Club Sandwich, asks again", async () => {
  const { conversation, result } = await drive(["mujhe ek pasta chahiye", "club"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /Pasta mein available nahi hai/);
  assert.doesNotMatch(result.reply, /Club Sandwich cart mein add/);
});

test("5. chowmein -> chicken adds Chicken Chowmein", async () => {
  const { conversation, result } = await drive(["mujhe ek chowmein chahiye", "chicken"]);
  assert.deepEqual(cartOf(conversation), [["chicken-chowmein", 1]]);
  assert.match(result.reply, /Chicken Chowmein/);
});

test("6. pasta -> mexican -> total reports PKR 850", async () => {
  const { result } = await drive(["mujhe ek pasta chahiye", "mexican", "kitna total hua"]);
  assert.match(result.reply, /PKR 850/);
});

test("regression: multi-variant breakdown reply still works ('2 small 2 large 1 alfredo')", async () => {
  const { conversation } = await drive(["mere 5 pasta hain", "2 small 2 large 1 alfredo"]);
  assert.deepEqual(
    cartOf(conversation).sort(),
    [["alfredo-pasta-white-sauce", 1], ["pasta-large", 2], ["pasta-small", 2]].sort()
  );
});

test("regression: zinger family clarification still resolves within its own scope", async () => {
  const { conversation } = await drive(["ek zinger krdo", "jumbo"]);
  assert.deepEqual(cartOf(conversation), [["jumbo-zinger", 1]]);
});

test("regression: quantity is preserved across a resolved clarification", async () => {
  const { conversation } = await drive(["mujhe 3 pasta chahiye", "mexican"]);
  assert.deepEqual(cartOf(conversation), [["mexican-pasta-white-sauce", 3]]);
});

test("regression: clarification queue is preserved when the reply is unavailable in-category", async () => {
  const { conversation } = await drive(["ek hotshot kardo ek pasta", "club"]);
  // The pasta question must still be pending (not dropped) after "club"
  // fails to resolve within it.
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.ok(conversation.order.pendingClarification);
});
