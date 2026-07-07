// V2 Action Planner + Clarification Queue — refactor tests.
//
// Covers the architectural fix requested: one customer message can contain
// multiple actions; one action can require clarification; multiple
// clarifications queue and resolve one at a time; an exact item is never
// dropped just because another item in the same message is ambiguous.
// Every test drives the REAL pipeline (processCustomerMessage), per this
// repo's standing lesson that hand-built fixtures miss real bugs.
// Run with: npx tsx --test tests/v2/action-planner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import { Logger } from "../../v2/logger";
import { parseMessage } from "../../v2/intent-parser/parser";
import { buildActionPlan } from "../../v2/action-planner";
import { executeActionPlan } from "../../v2/cart-engine";
import { createConversationContext, type ConversationContext } from "../../v2/core/context-manager";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { ProcessMessageResult } from "../../v2/core/result";
import { mapLLMResponseToParseResult } from "../../v2/llm/parse-result-mapper";
import { validateLLMResponse } from "../../v2/llm/json-validator";
import { getClarificationQueue } from "../../v2/order-state-engine/clarification";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const EMPTY_CART: CartState = { items: [] };

let counter = 0;
async function drive(messages: string[]): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  counter += 1;
  let conversation = createConversationContext(`ap-${counter}`, `ap-s-${counter}`);
  const logger = new Logger(`ap-s-${counter}`, `ap-${counter}`);
  let result!: ProcessMessageResult;
  for (const rawMessage of messages) {
    const out = await processCustomerMessage({ rawMessage, conversation, menu, restaurantConfig, logger });
    conversation = out.conversation;
    result = out.result;
  }
  return { conversation, result };
}

function cartOf(conversation: ConversationContext): Array<[string, number]> {
  return conversation.order.cart.items.map((i) => [i.itemId, i.qty]);
}

function cartMap(conversation: ConversationContext): Map<string, number> {
  return new Map(cartOf(conversation));
}

// ─── A. buildActionPlan (unit) ───────────────────────────────────────────────

test("A1. an exact single item becomes one ADD_ITEM action", () => {
  const parsed = parseMessage("2 Zinger Burger add karo", EMPTY_CART, menu);
  const plan = buildActionPlan(parsed, menu);
  assert.deepEqual(plan.actions, [{ type: "ADD_ITEM", itemId: "zinger-burger", quantity: 2, query: parsed.items[0].query }]);
});

test("A2. an ambiguous item becomes one ASK_CLARIFICATION action carrying every candidate", () => {
  const parsed = parseMessage("5 pasta", EMPTY_CART, menu);
  const plan = buildActionPlan(parsed, menu);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "ASK_CLARIFICATION");
  const action = plan.actions[0] as Extract<(typeof plan.actions)[number], { type: "ASK_CLARIFICATION" }>;
  assert.equal(action.quantity, 5);
  assert.equal(action.options.length, 5);
});

test("A3. an unavailable item becomes one REJECT_UNAVAILABLE action", () => {
  const parsed = parseMessage("ek beef burger dedo", EMPTY_CART, menu);
  const plan = buildActionPlan(parsed, menu);
  assert.ok(plan.actions.some((a) => a.type === "REJECT_UNAVAILABLE"));
});

test("A4. 'ek hotshot kardo ek pasta or 4 chowmein' plans one exact add and two independent clarifications, in order", () => {
  const parsed = parseMessage("ek hotshot kardo ek pasta or 4 chowmein", EMPTY_CART, menu);
  const plan = buildActionPlan(parsed, menu);
  assert.equal(plan.actions.filter((a) => a.type === "ADD_ITEM").length, 1);
  assert.equal(plan.actions.filter((a) => a.type === "ASK_CLARIFICATION").length, 2);
  const clarifications = plan.actions.filter((a) => a.type === "ASK_CLARIFICATION") as Extract<
    (typeof plan.actions)[number],
    { type: "ASK_CLARIFICATION" }
  >[];
  assert.equal(clarifications[0].category, "pasta");
  assert.equal(clarifications[1].category, "noodles");
});

test("A5. executeActionPlan adds only the ADD_ITEM entries, in order, never touching clarification/reject entries", () => {
  const parsed = parseMessage("ek hotshot kardo ek pasta or 4 chowmein", EMPTY_CART, menu);
  const plan = buildActionPlan(parsed, menu);
  const { cart } = executeActionPlan(plan, EMPTY_CART, menu);
  assert.deepEqual(cart.items.map((i) => [i.itemId, i.qty]), [["hot-shot-8-pcs-with-fries", 1]]);
});

test("A6. a validated LLM response also produces a sensible ActionPlan (buildActionPlan is pipeline-agnostic)", () => {
  const validation = validateLLMResponse(
    JSON.stringify({
      intent: "ADD_MULTIPLE_ITEMS",
      confidence: 0.95,
      items: [{ id: "zinger-burger", quantity: 2 }],
    }),
    menu
  );
  if (!validation.ok) throw new Error("expected the LLM JSON to validate");
  const parseResult = mapLLMResponseToParseResult(validation.response, "2 zinger burger", EMPTY_CART, menu);
  const plan = buildActionPlan(parseResult, menu);
  assert.deepEqual(plan.actions, [{ type: "ADD_ITEM", itemId: "zinger-burger", quantity: 2, query: parseResult.items[0].query }]);
});

// ─── B. Required scenario: "ek hotshot kardo ek pasta or 4 chowmin" ─────────

test("B1. the exact literal required message: hotshot lands immediately, pasta is queued, nothing crashes", async () => {
  const { conversation, result } = await drive(["ek hotshot kardo ek pasta or 4 chowmin"]);
  assert.equal(cartMap(conversation).get("hot-shot-8-pcs-with-fries"), 1);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
  assert.match(result.reply, /Hot Shot 8 pcs with fries/);
  assert.match(result.reply, /Pasta/);
});

test("B2. the reply confirms what was added AND asks the pending question in the same turn (rule 7)", async () => {
  const { result } = await drive(["ek hotshot kardo ek pasta or 4 chowmin"]);
  assert.match(result.reply, /cart mein add kar diye gaye hain/);
  assert.match(result.reply, /Aap kaunsa Pasta chahenge/);
});

test("B3. correctly-spelled chowmein queues a SECOND, independent clarification behind the first", async () => {
  const { conversation } = await drive(["ek hotshot kardo ek pasta or 4 chowmein"]);
  const queue = getClarificationQueue(conversation.order);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].category, "pasta");
  assert.equal(queue[1].category, "noodles");
});

test("B4. resolving pasta first surfaces the SECOND (chowmein) question, never both at once (rule 3)", async () => {
  const { conversation, result } = await drive(["ek hotshot kardo ek pasta or 4 chowmein", "pasta small"]);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "noodles");
  assert.match(result.reply, /Pasta Small/); // confirms what just landed
  assert.match(result.reply, /Aap kaunsa Noodles chahenge/); // then asks the next one
  assert.doesNotMatch(result.reply, /Pasta chahenge/); // never re-asks the resolved one
});

test("B5. resolving both clarifications in sequence empties the queue and lands every item", async () => {
  const { conversation } = await drive([
    "ek hotshot kardo ek pasta or 4 chowmein",
    "pasta small",
    "chicken chowmein",
  ]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(getClarificationQueue(conversation.order).length, 0);
  assert.equal(conversation.order.pendingClarification, undefined);
  assert.deepEqual(
    cartMap(conversation),
    new Map([
      ["hot-shot-8-pcs-with-fries", 1],
      ["pasta-small", 1],
      ["chicken-chowmein", 4],
    ])
  );
});

// ─── C. Bare ambiguous / category messages ──────────────────────────────────

test("C1. 'small' asks a cross-category clarification listing every 'small' item, cart untouched", async () => {
  const { conversation, result } = await drive(["small"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  for (const name of ["Pizza Small 6 inch", "Pizza Fries Small Box", "Pasta Small", "Pizza Small Cheese Topping", "Extra Chicken Small"]) {
    assert.match(result.reply, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("C2. 'chicken' asks a cross-category clarification listing every 'chicken' item, cart untouched", async () => {
  const { conversation, result } = await drive(["chicken"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.match(result.reply, /Chicken Sandwich/);
  assert.match(result.reply, /Chicken Steak/);
});

test("C3. 'burger' (bare, no verb) BROWSES the whole Burgers category — not an ambiguous add attempt", async () => {
  const { conversation, result } = await drive(["burger"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "BROWSING");
  for (const name of ["Zinger Burger", "Zinger Burger W/C", "Jumbo Zinger", "Think Food SP Burger", "Smoke Burger", "Spicy Stuff Burger"]) {
    assert.match(result.reply, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing ${name}`);
  }
  assert.doesNotMatch(result.reply, /kaunsa/i); // browsing, never a question
});

test("C4. 'burger menu' shows the SAME whole category, never the full menu", async () => {
  const { conversation, result } = await drive(["burger menu"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /Jumbo Zinger/);
  assert.doesNotMatch(result.reply, /Hamara Menu:/); // that's the FULL menu heading
});

test("C5. 'burger add karo' (has an order verb) is NOT a browse — it's an ambiguous add attempt", async () => {
  const { conversation, result } = await drive(["burger add karo"]);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.match(result.reply, /kaunsa/i);
});

test("C6. bare 'pizza' also browses its whole category (general rule, not a burger-only special case)", async () => {
  const { conversation, result } = await drive(["pizza"]);
  assert.equal(conversation.order.state, "BROWSING");
  for (const name of ["Pizza Large 12 inch", "Pizza Regular 9 inch", "Pizza Small 6 inch", "Think Food Special Pizza", "Mexican Pizza"]) {
    assert.match(result.reply, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// ─── D. "2 pasta 3 pizza 1 burger" — three independent ambiguities ──────────

test("D1. '2 pasta 3 pizza 1 burger' queues three clarifications, asks only the first", async () => {
  const { conversation, result } = await drive(["2 pasta 3 pizza 1 burger"]);
  assert.deepEqual(cartOf(conversation), []);
  const queue = getClarificationQueue(conversation.order);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].category, "pasta");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
  assert.match(result.reply, /Pasta chahenge/);
  assert.doesNotMatch(result.reply, /Pizza chahenge|Burgers chahenge/);
});

test("D2. resolving all three in sequence lands every item with its own quantity", async () => {
  const { conversation } = await drive([
    "2 pasta 3 pizza 1 burger",
    "pasta small",
    "pizza regular",
    "zinger burger",
  ]);
  assert.equal(getClarificationQueue(conversation.order).length, 0);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.deepEqual(
    cartMap(conversation),
    new Map([
      ["pasta-small", 2],
      ["pizza-regular-9-inch", 3],
      ["zinger-burger", 1],
    ])
  );
});

// ─── E. "5 pasta then 2 small 2 large 1 alfredo" (same-message self-anchor) ─

test("E1. '5 pasta' then '2 small 2 large 1 alfredo' resolves via same-message category anchoring — still works after the refactor", async () => {
  const { conversation, result } = await drive(["5 pasta", "2 small 2 large 1 alfredo"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(conversation.order.pendingClarification, undefined);
  assert.deepEqual(
    cartMap(conversation),
    new Map([
      ["pasta-small", 2],
      ["pasta-large", 2],
      ["alfredo-pasta-white-sauce", 1],
    ])
  );
  assert.match(result.reply, /Pasta Small/);
});

// ─── F. Replace item while clarification queue exists ──────────────────────

test("F1. replacing an item already in the cart while a clarification is pending: replace executes, clarification is PRESERVED", async () => {
  const { conversation, result } = await drive(["ek gyro dedo", "5 pasta", "gyro hata kar steak add karo"]);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
  assert.deepEqual(cartMap(conversation), new Map([["chicken-steak", 1]]));
  assert.doesNotMatch(cartMap(conversation).has("gyro") ? "has gyro" : "", /has gyro/);
  assert.match(result.reply, /Chicken Steak/);
  assert.match(result.reply, /Pasta chahenge/);
});

test("F2. after the preserved replace, answering the clarification still resolves it correctly", async () => {
  const { conversation } = await drive([
    "ek gyro dedo",
    "5 pasta",
    "gyro hata kar steak add karo",
    "pasta small",
  ]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(conversation.order.pendingClarification, undefined);
  assert.deepEqual(
    cartMap(conversation),
    new Map([
      ["chicken-steak", 1],
      ["pasta-small", 5],
    ])
  );
});

// ─── G. Clear cart while clarification queue exists ─────────────────────────

test("G1. clearing the cart while a clarification is pending DROPS the entire queue (the one explicit exception)", async () => {
  const { conversation, result } = await drive(["ek gyro dedo", "5 pasta", "clear cart"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(getClarificationQueue(conversation.order).length, 0);
  assert.match(result.reply, /clear kar di gayi hai/);
});

test("G2. after clearing during clarification, a fresh order works normally (queue doesn't resurrect)", async () => {
  const { conversation } = await drive(["ek gyro dedo", "5 pasta", "clear cart", "ek wrap dedo"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.deepEqual(cartMap(conversation), new Map([["wrap", 1]]));
});

// ─── H. Checkout while clarification queue exists ───────────────────────────

test("H1. checkout is BLOCKED while a clarification is pending — never silently finalizes an incomplete order", async () => {
  const { conversation, result } = await drive(["ek gyro dedo", "5 pasta", "checkout"]);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
  assert.match(result.reply, /pehle/i);
  assert.match(result.reply, /Pasta chahenge/);
});

test("H2. confirm/delivery/pickup/address/name are ALL blocked the same way while a clarification is pending", async () => {
  for (const msg of ["confirm order", "delivery", "pickup", "House 12 Street 5", "Ahmed"]) {
    const { conversation } = await drive(["ek gyro dedo", "5 pasta", msg]);
    assert.equal(conversation.order.state, "AWAITING_CLARIFICATION", `"${msg}" should not advance checkout`);
  }
});

test("H3. after resolving the clarification, checkout proceeds normally", async () => {
  const { conversation } = await drive(["ek gyro dedo", "5 pasta", "pasta small", "checkout"]);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
});

// ─── I. Informational / conversational messages during clarification ───────

test("I1. a price question mid-clarification is answered AND the clarification is preserved (not swallowed)", async () => {
  const { conversation, result } = await drive(["5 pasta", "Zinger Burger ki price kya hai"]);
  assert.match(result.reply, /500/);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
});

test("I2. a thanks/human-support/complaint message mid-clarification is answered AND preserves the queue", async () => {
  const { conversation: c1, result: r1 } = await drive(["5 pasta", "shukriya"]);
  assert.match(r1.reply, /shukriya/i);
  assert.equal(c1.order.state, "AWAITING_CLARIFICATION");

  const { conversation: c2, result: r2 } = await drive(["5 pasta", "manager se baat karni hai"]);
  assert.match(r2.reply, /call/i);
  assert.equal(c2.order.state, "AWAITING_CLARIFICATION");
});

test("I3. 'menu dikhao' mid-clarification is the one case that still abandons the queue entirely", async () => {
  const { conversation } = await drive(["5 pasta", "menu dikhao"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(conversation.order.pendingClarification, undefined);
});

// ─── J. Order continuation after WAIT / pause ───────────────────────────────

test("J1. WAIT pauses safely mid-clarification — nothing changes, the queue survives", async () => {
  const { conversation, result } = await drive(["5 pasta", "ruko"]);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.pendingClarification?.category, "pasta");
  assert.match(result.reply, /aaram se|zaroor|theek/i);
});

test("J2. after WAIT, the customer can resume and correctly answer the pending clarification", async () => {
  const { conversation } = await drive(["5 pasta", "ruko", "pasta small"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.deepEqual(cartMap(conversation), new Map([["pasta-small", 5]]));
});

test("J3. WAIT mid-checkout (cart already has items, no clarification) preserves the cart exactly", async () => {
  const { conversation } = await drive(["2 Zinger Burger add karo", "checkout", "ruko", "confirm order"]);
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
  assert.deepEqual(cartMap(conversation), new Map([["zinger-burger", 2]]));
});

// ─── K. NO declines the current question and advances the queue ────────────

test("K1. 'no' declines the pending question and moves to the NEXT one in the queue", async () => {
  const { conversation: beforeDecline } = await drive(["2 pasta 1 burger"]);
  assert.equal(getClarificationQueue(beforeDecline.order).length, 2);

  const { conversation, result } = await drive(["2 pasta 1 burger", "no"]);
  assert.equal(getClarificationQueue(conversation.order).length, 1);
  assert.equal(conversation.order.pendingClarification?.category, "burgers");
  assert.match(result.reply, /kaunsa/i);
});

test("K2. 'no' on the LAST remaining question empties the queue and returns to CART_EDITING", async () => {
  const { conversation } = await drive(["5 pasta", "no"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(getClarificationQueue(conversation.order).length, 0);
  assert.deepEqual(cartOf(conversation), []);
});

// ─── L. Never drop items — invariant sweep ──────────────────────────────────

test("L1. an exact item is NEVER dropped by an ambiguous item elsewhere in the same message (randomized order pairs)", async () => {
  const pairs: Array<[string, string]> = [
    ["2 Zinger Burger add karo aur 3 pasta", "zinger-burger"],
    ["3 pasta aur 2 Zinger Burger add karo", "zinger-burger"],
    ["1 Gyro dedo aur 5 chicken chowmein add karo", "gyro"],
  ];
  for (const [msg, exactId] of pairs) {
    const { conversation } = await drive([msg]);
    assert.ok(cartMap(conversation).has(exactId), `"${msg}" dropped the exact item ${exactId}`);
  }
});

test("L2. the cart's item COUNT only ever grows or stays the same across a clarification chain — never shrinks unexpectedly", async () => {
  const { conversation: afterFirst } = await drive(["ek hotshot kardo ek pasta or 4 chowmein"]);
  const countAfterFirst = afterFirst.order.cart.items.length;
  const { conversation: afterSecond } = await drive(["ek hotshot kardo ek pasta or 4 chowmein", "pasta small"]);
  assert.ok(afterSecond.order.cart.items.length >= countAfterFirst);
});
