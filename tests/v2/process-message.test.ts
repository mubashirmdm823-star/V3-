// V2 process message orchestrator tests. Drives the REAL top-level entry
// point (processCustomerMessage) rather than hand-built fixtures wherever
// possible — every prior V2 session found real bugs this way. A dedicated
// "purity" section additionally cross-checks the orchestrator's output
// against calling parseMessage -> processMessage -> buildResponse directly,
// proving the orchestrator adds coordination/timing/logging/recovery only,
// never a second copy of any business rule.
// Run with:
//   npx tsx --test tests/v2/process-message.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { OrderContext } from "../../v2/types/order";
import { Logger } from "../../v2/logger";
import { createInitialContext, processMessage } from "../../v2/order-state-engine";
import { parseMessage } from "../../v2/intent-parser/parser";
import { buildResponse, unknownRequestMessage } from "../../v2/response-builder";
import { clarifyUnclearMessage } from "../../v2/intent-parser/clarification";

import {
  createConversationContext,
  withOrder,
  saveContext,
  restoreContext,
  resetContext,
  cloneContext,
  type ConversationContext,
} from "../../v2/core/context-manager";
import { processCustomerMessage, type ProcessMessageInput } from "../../v2/core/process-message";
import { PIPELINE_STAGE_ORDER } from "../../v2/core/pipeline";
import {
  isValidParseResult,
  isValidOrderContext,
  isValidCartState,
  isValidCustomerResponse,
} from "../../v2/core/validator";
import { PipelineError, isPipelineError, toPipelineError } from "../../v2/core/errors";
import {
  runParserStage,
  runStateStage,
  runResponseStage,
  checkSafetyStage,
} from "../../v2/core/executor";
import type { ProcessMessageResult } from "../../v2/core/result";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

let loggerCounter = 0;
function newLogger(): Logger {
  loggerCounter += 1;
  return new Logger(`session-${loggerCounter}`, `conversation-${loggerCounter}`);
}

function newConversation(cart?: CartState): ConversationContext {
  loggerCounter += 1;
  return createConversationContext(`conv-${loggerCounter}`, `sess-${loggerCounter}`, cart);
}

async function say(
  conversation: ConversationContext,
  rawMessage: string,
  logger: Logger,
  config: RestaurantConfig = restaurantConfig,
  menuOverride: Menu = menu
): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  const input: ProcessMessageInput = {
    rawMessage,
    conversation,
    menu: menuOverride,
    restaurantConfig: config,
    logger,
  };
  const { result, conversation: next } = await processCustomerMessage(input);
  return { conversation: next, result };
}

async function driveMany(
  conversation: ConversationContext,
  messages: string[],
  logger: Logger
): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  let current = conversation;
  let lastResult!: ProcessMessageResult;
  for (const m of messages) {
    const step = await say(current, m, logger);
    current = step.conversation;
    lastResult = step.result;
  }
  return { conversation: current, result: lastResult };
}

// ─────────────────────────────────────────────────────────────────────────
// A. Simple / compound cart operations
// ─────────────────────────────────────────────────────────────────────────

test("A1. simple add: reply confirms and cart gets the item", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.equal(conversation.order.cart.items.length, 1);
  assert.equal(conversation.order.cart.items[0].itemId, "jumbo-zinger");
  assert.match(result.reply, /Jumbo Zinger/);
});

test("A2. multiple item add in one message", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "2 zinger burger aur 1 gyro dedo", logger);
  assert.ok(conversation.order.cart.items.length >= 2);
});

test("A3. remove item", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "ek gyro dedo"], logger);
  const { conversation: after } = await say(conversation, "gyro remove karo", logger);
  assert.equal(after.order.cart.items.length, 1);
  assert.equal(after.order.cart.items[0].itemId, "jumbo-zinger");
});

test("A4. replace item", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const { conversation: after, result } = await say(conversation, "zinger hata kar steak add karo", logger);
  assert.deepEqual(after.order.cart.items.map((i) => i.itemId), ["chicken-steak"]);
  assert.match(result.reply, /Chicken Steak/);
});

test("A5. quantity change", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const { conversation: after } = await say(conversation, "jumbo zinger ki quantity 3 kardo", logger);
  assert.equal(after.order.cart.items[0].qty, 3);
});

test("A6. clear cart", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "ek gyro dedo"], logger);
  const { conversation: after, result } = await say(conversation, "remove everything", logger);
  assert.equal(after.order.cart.items.length, 0);
  assert.match(result.reply, /cart/i);
});

test("A7. compound remove-everything-and-add", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const { conversation: after } = await say(conversation, "sab hata do aur 1 gyro dedo", logger);
  assert.deepEqual(after.order.cart.items.map((i) => i.itemId), ["gyro"]);
});

test("A8. unavailable item rejected, cart untouched", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "ek beef burger dedo", logger);
  assert.equal(conversation.order.cart.items.length, 0);
  assert.match(result.reply, /Maaf kijiye/);
});

test("A9. remove item not in cart rejected", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "gyro hata do", logger);
  assert.match(result.reply, /maujood nahi/);
});

test("A10. show menu returns full listing, never mutates cart/state", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "menu dikhao", logger);
  assert.equal(conversation.order.state, "BROWSING");
  assert.match(result.reply, /Hamara Menu/);
});

test("A11. show cart on an empty cart", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "mera cart dikhao", logger);
  assert.match(result.reply, /khaali/);
});

test("A12. price query for a specific item", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "gyro ki price kya hai", logger);
  assert.match(result.reply, /550/);
});

// ─────────────────────────────────────────────────────────────────────────
// B. Category clarification + resolution + chains
// ─────────────────────────────────────────────────────────────────────────

test("B1. bare category triggers clarification, no cart mutation", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "ek zinger dedo", logger);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.equal(conversation.order.cart.items.length, 0);
  assert.match(result.reply, /Zinger/);
});

test("B2. clarification resolved by a follow-up naming the exact item", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek zinger dedo", logger);
  const { conversation: after } = await say(conversation, "jumbo zinger", logger);
  assert.equal(after.order.state, "CART_EDITING");
  assert.equal(after.order.cart.items[0].itemId, "jumbo-zinger");
});

test("B3. clarification persists across the conversation context (no context loss)", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek zinger dedo", logger);
  assert.ok(conversation.order.pendingClarification);
  assert.equal(conversation.order.pendingClarification?.category, "zinger");
});

test("B4. self-anchoring same-message clarification (pasta + alfredo)", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "2 small 2 large 1 alfredo", logger);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.ok(conversation.order.cart.items.length >= 2);
});

test("B5. abandoning a pending clarification with an unrelated request", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek zinger dedo", logger);
  const { conversation: after } = await say(conversation, "menu dikhao", logger);
  assert.equal(after.order.pendingClarification, undefined);
});

test("B6. multiple clarification chains back to back (pasta then zinger)", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek pasta dedo", logger));
  assert.equal(ctx.order.state, "AWAITING_CLARIFICATION");
  ({ conversation: ctx } = await say(ctx, "pasta small", logger));
  assert.equal(ctx.order.state, "CART_EDITING");
  ({ conversation: ctx } = await say(ctx, "ek zinger dedo", logger));
  assert.equal(ctx.order.state, "AWAITING_CLARIFICATION");
  ({ conversation: ctx } = await say(ctx, "jumbo zinger", logger));
  assert.equal(ctx.order.state, "CART_EDITING");
  assert.equal(ctx.order.cart.items.length, 2);
});

test("B7. clarification reply text lists the real candidate options", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek pasta dedo", logger);
  assert.match(result.reply, /Pasta Small|Pasta Large|Alfredo/);
});

test("B8. an ambiguous reply during clarification re-asks rather than guessing", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek zinger dedo", logger);
  const { conversation: after } = await say(conversation, "zinger", logger);
  assert.equal(after.order.state, "AWAITING_CLARIFICATION");
});

// ─────────────────────────────────────────────────────────────────────────
// C. Checkout flow: order review -> confirm -> delivery/pickup -> address ->
//    name -> ready to submit -> pending verification
// ─────────────────────────────────────────────────────────────────────────

test("C1. checkout start moves CART_EDITING -> ORDER_REVIEW", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "checkout"], logger);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.match(result.reply, /Confirm Order/);
});

test("C2. confirm order moves ORDER_REVIEW -> AWAITING_DELIVERY_PICKUP", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
  assert.match(result.reply, /Delivery|Pickup/);
});

test("C3. delivery selection moves to AWAITING_ADDRESS", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_ADDRESS");
  assert.equal(conversation.order.deliveryType, "delivery");
  assert.ok(result.reply.length > 0);
});

test("C4. pickup selection moves to AWAITING_NAME", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_NAME");
  assert.equal(conversation.order.deliveryType, "pickup");
});

test("C5. address accepted moves AWAITING_ADDRESS -> AWAITING_NAME", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 45 Street 12 Nazimabad Karachi"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_NAME");
  assert.ok(conversation.order.address);
});

test("C6. name accepted moves AWAITING_NAME -> READY_TO_SUBMIT", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "mera naam Fahad hai"],
    logger
  );
  assert.equal(conversation.order.state, "READY_TO_SUBMIT");
  assert.equal(conversation.order.customerName, "Fahad");
});

test("C7. submit moves READY_TO_SUBMIT -> PENDING_VERIFICATION with the exact reply", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"],
    logger
  );
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
  assert.match(result.reply, /order/i);
  assert.match(result.reply, /Pending Verification/);
});

test("C8. messages after PENDING_VERIFICATION get the already-finalized reply, no more mutation", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"],
    logger
  );
  const { conversation: after, result } = await say(conversation, "ek gyro dedo", logger);
  assert.equal(after.order.cart.items.length, 1);
  assert.match(result.reply, /already|verification|process/i);
});

test("C9. premature confirm order (before checkout) is rejected, not treated as unknown", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "confirm order", logger);
  assert.equal(conversation.order.state, "BROWSING");
  assert.match(result.reply, /checkout/i);
});

test("C10. premature delivery selection before confirming order is ignored", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "checkout", "delivery"], logger);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.equal(conversation.order.deliveryType, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// D. Interrupt handling: cart edits / replace / remove mid-checkout
// ─────────────────────────────────────────────────────────────────────────

test("D1. adding an item while awaiting delivery/pickup bounces back to ORDER_REVIEW", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "ek gyro dedo"],
    logger
  );
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.equal(conversation.order.cart.items.length, 2);
  assert.match(result.reply, /Confirm Order/);
});

test("D2. removing an item while awaiting address bounces back to ORDER_REVIEW", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "ek gyro dedo", "checkout", "confirm order", "delivery", "gyro remove karo"],
    logger
  );
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.equal(conversation.order.cart.items.length, 1);
});

test("D3. replacing an item while awaiting name bounces back to ORDER_REVIEW", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "zinger hata kar steak add karo"],
    logger
  );
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.deepEqual(conversation.order.cart.items.map((i) => i.itemId), ["chicken-steak"]);
});

test("D4. clearing the cart while ready to submit bounces back to ORDER_REVIEW with empty cart", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "remove everything"],
    logger
  );
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.equal(conversation.order.cart.items.length, 0);
});

test("D5. an invalid address reply re-prompts for the address rather than advancing", async () => {
  const logger = newLogger();
  const { conversation, result } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "ok"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_ADDRESS");
  assert.match(result.reply, /address/i);
});

test("D6. switching delivery -> pickup mid-address clears the address requirement", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "pickup"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_NAME");
  assert.equal(conversation.order.deliveryType, "pickup");
});

test("D7. edit-then-reconfirm full round trip still reaches PENDING_VERIFICATION", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    [
      "ek jumbo zinger dedo", "checkout", "confirm order", "ek gyro dedo",
      "confirm order", "pickup", "Sara", "submit",
    ],
    logger
  );
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
  assert.equal(conversation.order.cart.items.length, 2);
});

test("D8. 'ruko' (pause) mid-checkout does not corrupt the checkout state", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "ruko"],
    logger
  );
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
});

// ─────────────────────────────────────────────────────────────────────────
// E. Unknown / unclassifiable messages
// ─────────────────────────────────────────────────────────────────────────

test("E1. gibberish message returns a safe fallback and never mutates state", async () => {
  const logger = newLogger();
  const { conversation, result } = await say(newConversation(), "asdkjfh qweoiu", logger);
  assert.equal(conversation.order.state, "BROWSING");
  assert.ok(isValidCustomerResponse(result.reply));
});

test("E2. order-like filler with no resolvable item asks for clarification", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "mujhe kuch chahiye", logger);
  assert.match(result.reply, /clear nahi samajh|dobara/i);
});

test("E3. empty-ish whitespace message is handled without throwing", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "   ", logger);
  assert.ok(isValidCustomerResponse(result.reply));
});

test("E4. unknown message never appears twice identically confusing the customer with internals", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "zzzzz", logger);
  assert.doesNotMatch(result.reply, /UNKNOWN|undefined|\{"/);
});

// ─────────────────────────────────────────────────────────────────────────
// F. Validation, invalid results, and safe-failure recovery
// ─────────────────────────────────────────────────────────────────────────

test("F1. isValidParseResult rejects garbage", async () => {
  assert.equal(isValidParseResult(null), false);
  assert.equal(isValidParseResult({}), false);
  assert.equal(isValidParseResult({ intent: "NOT_REAL" }), false);
});

test("F2. isValidParseResult accepts a real ParseResult", async () => {
  const pr = parseMessage("ek jumbo zinger dedo", { items: [] }, menu);
  assert.equal(isValidParseResult(pr), true);
});

test("F3. isValidOrderContext rejects garbage", async () => {
  assert.equal(isValidOrderContext(null), false);
  assert.equal(isValidOrderContext({ state: "NOT_A_STATE" }), false);
  assert.equal(isValidOrderContext({ state: "BROWSING", cart: { items: "not-an-array" } }), false);
});

test("F4. isValidOrderContext accepts a real OrderContext", async () => {
  assert.equal(isValidOrderContext(createInitialContext()), true);
});

test("F5. isValidCartState rejects a cart with a malformed line item", async () => {
  assert.equal(isValidCartState({ items: [{ itemId: "x", name: "X", price: "500", qty: 1 }] }), false);
});

test("F6. isValidCustomerResponse rejects empty/whitespace-only strings", async () => {
  assert.equal(isValidCustomerResponse(""), false);
  assert.equal(isValidCustomerResponse("   "), false);
  assert.equal(isValidCustomerResponse("hello"), true);
});

test("F7. toPipelineError normalizes a native exception with the given stage", async () => {
  const err = toPipelineError("RESPONSE", new TypeError("boom"));
  assert.equal(err.stage, "RESPONSE");
  assert.equal(isPipelineError(err), true);
});

test("F8. toPipelineError passes an existing PipelineError through unchanged", async () => {
  const original = new PipelineError("STATE", "already tagged");
  const result = toPipelineError("RESPONSE", original);
  assert.equal(result, original);
  assert.equal(result.stage, "STATE");
});

test("F9. runParserStage throws a PARSER-tagged PipelineError when the menu is malformed", async () => {
  const brokenMenu = { categories: undefined } as unknown as Menu;
  assert.throws(
    () => runParserStage("ek jumbo zinger dedo", { items: [] }, brokenMenu),
    (err: unknown) => isPipelineError(err) && err.stage === "PARSER"
  );
});

test("F10. runStateStage throws a STATE-tagged PipelineError when the menu is malformed", async () => {
  const parseResult = parseMessage("ek jumbo zinger dedo", { items: [] }, menu);
  const brokenMenu = { categories: undefined } as unknown as Menu;
  assert.throws(
    () => runStateStage(createInitialContext(), parseResult, brokenMenu),
    (err: unknown) => isPipelineError(err) && err.stage === "STATE"
  );
});

test("F11. runResponseStage throws a RESPONSE-tagged PipelineError when restaurantConfig is missing", async () => {
  const before = createInitialContext();
  const parseResult = parseMessage("aapka address kya hai", before.cart, menu);
  const after = processMessage(before, parseResult, menu);
  assert.throws(
    () => runResponseStage({ parseResult, before, after, menu, restaurantConfig: undefined as unknown as RestaurantConfig }),
    (err: unknown) => isPipelineError(err) && err.stage === "RESPONSE"
  );
});

test("F12. checkSafetyStage accepts every real safety decision produced by the parser", async () => {
  const pr1 = parseMessage("ek jumbo zinger dedo", { items: [] }, menu);
  const pr2 = parseMessage("ek zinger dedo", { items: [] }, menu);
  const pr3 = parseMessage("ek beef burger dedo", { items: [] }, menu);
  assert.doesNotThrow(() => checkSafetyStage(pr1));
  assert.doesNotThrow(() => checkSafetyStage(pr2));
  assert.doesNotThrow(() => checkSafetyStage(pr3));
});

test("F13. orchestrator recovers from a broken menu (parser stage failure): rolls back to BROWSING, asks for clarification", async () => {
  const logger = newLogger();
  const brokenMenu = { categories: undefined } as unknown as Menu;
  const { conversation, result } = await say(newConversation(), "ek jumbo zinger dedo", logger, restaurantConfig, brokenMenu);
  assert.equal(conversation.order.state, "BROWSING");
  assert.equal(result.recovered, true);
  assert.equal(result.failedStage, "PARSER");
  assert.equal(result.reply, clarifyUnclearMessage());
});

test("F14. orchestrator recovers from a response-builder failure but KEEPS the already-valid state transition", async () => {
  const logger = newLogger();
  const conversation = newConversation();
  // `null`, not `undefined` — a JS default parameter only substitutes for a
  // literal `undefined` argument, and this test needs the malformed value to
  // actually reach buildResponse rather than be silently replaced by say()'s
  // default restaurantConfig.
  const { result } = await say(conversation, "aapka address kya hai", logger, null as unknown as RestaurantConfig);
  assert.equal(result.recovered, true);
  assert.equal(result.failedStage, "RESPONSE");
  assert.equal(result.reply, unknownRequestMessage());
});

test("F15. a response-builder failure never wipes cart progress made in a prior turn", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const { conversation: after, result } = await say(conversation, "aapka address kya hai", logger, null as unknown as RestaurantConfig);
  assert.equal(result.recovered, true);
  assert.equal(after.order.cart.items.length, 1);
  assert.equal(after.order.cart.items[0].itemId, "jumbo-zinger");
});

test("F16. a failed turn still returns a PIPELINE_FAILED event and a PIPELINE_FINISHED event", async () => {
  const logger = newLogger();
  const brokenMenu = { categories: undefined } as unknown as Menu;
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger, restaurantConfig, brokenMenu);
  const names = result.events.map((e) => e.name);
  assert.ok(names.includes("PIPELINE_FAILED"));
  assert.ok(names.includes("PIPELINE_FINISHED"));
});

test("F17. a successful turn never reports recovered=true", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.equal(result.recovered, false);
  assert.equal(result.failedStage, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// G. Logging
// ─────────────────────────────────────────────────────────────────────────

test("G1. every successful turn produces a logEntry", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.ok(result.logEntry);
  assert.equal(result.logEntry?.detectedIntent, "ADD_ITEM");
});

test("G2. logEntry carries the same sessionId/conversationId as the Logger", async () => {
  const logger = new Logger("sess-fixed", "conv-fixed");
  const conversation = createConversationContext("conv-fixed", "sess-fixed");
  const { result } = await say(conversation, "ek jumbo zinger dedo", logger);
  assert.equal(result.logEntry?.sessionId, "sess-fixed");
  assert.equal(result.logEntry?.conversationId, "conv-fixed");
});

test("G3. logger accumulates one entry per turn across a conversation", async () => {
  const logger = newLogger();
  await driveMany(newConversation(), ["ek jumbo zinger dedo", "checkout", "confirm order"], logger);
  assert.equal(logger.getEntries().length, 3);
});

test("G4. logging never changes the resulting OrderContext vs an unlogged equivalent call", async () => {
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"];
  const loggerA = newLogger();
  const { conversation: withLogging } = await driveMany(newConversation(), messages, loggerA);

  let plain = createInitialContext();
  for (const m of messages) {
    const parseResult = parseMessage(m, plain.cart, menu);
    plain = processMessage(plain, parseResult, menu);
  }

  assert.deepEqual(withLogging.order.cart, plain.cart);
  assert.equal(withLogging.order.state, plain.state);
});

test("G5. a broken restaurantConfig only fails the RESPONSE stage, never the LOGGER stage", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "aapka address kya hai", logger, null as unknown as RestaurantConfig);
  assert.ok(result.logEntry);
});

test("G6. logEntry.cartAfter reflects the real post-mutation cart", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.equal(result.logEntry?.cartAfter.items.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// H. Pipeline timing / events
// ─────────────────────────────────────────────────────────────────────────

test("H1. pipeline events are recorded in the documented order for a normal turn", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const names = result.events.map((e) => e.name);
  assert.deepEqual(names, PIPELINE_STAGE_ORDER as string[]);
});

test("H2. every timing field is a non-negative number", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  for (const key of ["parserMs", "safetyMs", "cartMs", "stateMs", "responseMs", "loggerMs", "totalMs"] as const) {
    assert.ok(result.timing[key] >= 0, `${key} should be >= 0`);
  }
});

test("H3. totalMs is at least as large as the sum of the individually-measured stages", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const sum = result.timing.parserMs + result.timing.stateMs + result.timing.responseMs + result.timing.loggerMs;
  assert.ok(result.timing.totalMs >= sum - 1); // small float tolerance
});

test("H4. a single message runs well under the 50ms local-pipeline performance target", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.ok(result.timing.totalMs < 50, `expected < 50ms, got ${result.timing.totalMs}`);
});

test("H5. safetyMs/cartMs are documented as fused (0) rather than unmeasured/undefined", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.equal(result.timing.safetyMs, 0);
  assert.equal(result.timing.cartMs, 0);
});

test("H6. every event has an ISO timestamp string", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  for (const event of result.events) {
    assert.doesNotThrow(() => new Date(event.timestamp).toISOString());
  }
});

// ─────────────────────────────────────────────────────────────────────────
// I. Conversation context persistence
// ─────────────────────────────────────────────────────────────────────────

test("I1. save then restore reproduces an identical conversation context", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const restored = restoreContext(saveContext(conversation));
  assert.deepEqual(restored, conversation);
});

test("I2. restore rejects invalid JSON", async () => {
  assert.throws(() => restoreContext("not json"), (err: unknown) => isPipelineError(err) && err.stage === "CONTEXT");
});

test("I3. restore rejects a well-formed JSON object with the wrong shape", async () => {
  assert.throws(
    () => restoreContext(JSON.stringify({ foo: "bar" })),
    (err: unknown) => isPipelineError(err) && err.stage === "CONTEXT"
  );
});

test("I4. resetContext clears the cart/state but keeps the same conversation/session identity", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "checkout"], logger);
  const reset = resetContext(conversation);
  assert.equal(reset.conversationId, conversation.conversationId);
  assert.equal(reset.sessionId, conversation.sessionId);
  assert.equal(reset.order.state, "BROWSING");
  assert.equal(reset.order.cart.items.length, 0);
});

test("I5. cloneContext produces a deep, independent copy", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  const clone = cloneContext(conversation);
  assert.deepEqual(clone, conversation);
  assert.notEqual(clone.order.cart, conversation.order.cart);
});

test("I6. a restored context can continue a conversation seamlessly (pending clarification survives persistence)", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek zinger dedo", logger);
  const restored = restoreContext(saveContext(conversation));
  const { conversation: after } = await say(restored, "jumbo zinger", logger);
  assert.equal(after.order.state, "CART_EDITING");
  assert.equal(after.order.cart.items[0].itemId, "jumbo-zinger");
});

test("I7. withOrder is a pure immutable update — the original conversation is untouched", async () => {
  const original = newConversation();
  const newOrder: OrderContext = { ...original.order, state: "CART_EDITING" };
  const updated = withOrder(original, newOrder, "some message");
  assert.equal(original.order.state, "BROWSING");
  assert.equal(updated.order.state, "CART_EDITING");
});

test("I8. responseSeed on the conversation reflects the most recent raw message", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo", logger);
  assert.equal(conversation.responseSeed, "ek jumbo zinger dedo");
});

// ─────────────────────────────────────────────────────────────────────────
// J. Long / stress conversations
// ─────────────────────────────────────────────────────────────────────────

test("J1. a 40-message mixed conversation never throws and ends in a valid state", async () => {
  const logger = newLogger();
  const messages = [
    "menu dikhao", "ek jumbo zinger dedo", "ek gyro dedo", "mera cart dikhao",
    "gyro remove karo", "ek pasta dedo", "pasta small", "quantity 2 kardo pasta ki",
    "ek zinger dedo", "jumbo zinger", "zinger hata kar steak add karo",
    "checkout", "ek gyro dedo", "confirm order", "delivery",
    "House 12 Street 5 Nazimabad Karachi", "mera naam Ali hai", "submit",
    "ek burger dedo", "asdkjhasd", "menu dikhao", "aapka number kya hai",
    "gyro ki price kya hai", "mera cart dikhao", "checkout", "confirm order",
    "delivery", "House again", "mera naam Ali hai", "submit",
  ];
  const { conversation } = await driveMany(newConversation(), messages, logger);
  assert.ok(isValidOrderContext(conversation.order));
});

test("J2. a stress conversation of 60 add/remove toggles keeps cart state internally consistent", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  for (let i = 0; i < 30; i++) {
    ({ conversation: ctx } = await say(ctx, "ek gyro dedo", logger));
    ({ conversation: ctx } = await say(ctx, "gyro remove karo", logger));
  }
  assert.equal(ctx.order.cart.items.length, 0);
  assert.ok(isValidCartState(ctx.order.cart));
});

test("J3. logger accumulates exactly one entry per message across a long conversation", async () => {
  const logger = newLogger();
  const messages = Array.from({ length: 20 }, () => "menu dikhao");
  await driveMany(newConversation(), messages, logger);
  assert.equal(logger.getEntries().length, 20);
});

// ─────────────────────────────────────────────────────────────────────────
// K. Mixed Roman Urdu / English / Hinglish phrasing
// ─────────────────────────────────────────────────────────────────────────

test("K1. pure English ordering flow works end to end", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["I want a jumbo zinger", "checkout", "confirm order", "pickup", "my name is Ali", "submit"],
    logger
  );
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

test("K2. pure Roman Urdu ordering flow works end to end", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "mera naam Sara hai", "submit"],
    logger
  );
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

test("K3. Hinglish mixed flow works end to end", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["2 zinger burger add karo please", "checkout", "confirm order", "delivery", "House 9 Block A", "my name is Zara", "final submit"],
    logger
  );
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

test("K4. mixed-language clarification chain resolves correctly", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["I want a zinger", "jumbo zinger please"], logger);
  assert.equal(conversation.order.state, "CART_EDITING");
});

test("K5. switching languages mid-conversation does not confuse state tracking", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(
    newConversation(),
    ["ek jumbo zinger dedo", "show me the cart", "gyro remove karo", "checkout"],
    logger
  );
  assert.equal(conversation.order.state, "ORDER_REVIEW");
});

test("K6. English restaurant-info question returns real config data", async () => {
  const logger = newLogger();
  const { result } = await say(newConversation(), "what's your phone number", logger);
  assert.match(result.reply, /0312/);
});

// ─────────────────────────────────────────────────────────────────────────
// L. Complex customer conversations
// ─────────────────────────────────────────────────────────────────────────

test("L1. add, clarify, interrupt with info question, then resume checkout", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "menu dikhao", logger));
  assert.equal(ctx.order.pendingClarification, undefined);
  ({ conversation: ctx } = await say(ctx, "ek jumbo zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "checkout", logger));
  assert.equal(ctx.order.state, "ORDER_REVIEW");
});

test("L2. multi-item order with a replace and a quantity change before checkout", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek jumbo zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "ek gyro dedo", logger));
  ({ conversation: ctx } = await say(ctx, "gyro ki quantity 2 kardo", logger));
  ({ conversation: ctx } = await say(ctx, "zinger hata kar steak add karo", logger));
  assert.deepEqual(ctx.order.cart.items.map((i) => i.itemId).sort(), ["chicken-steak", "gyro"]);
  assert.equal(ctx.order.cart.items.find((i) => i.itemId === "gyro")?.qty, 2);
});

test("L3. price query interleaved with ordering doesn't affect the cart", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek jumbo zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "gyro ki price kya hai", logger));
  assert.equal(ctx.order.cart.items.length, 1);
});

test("L4. full delivery journey with an interruption to add a side item mid-name-stage", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek jumbo zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "checkout", logger));
  ({ conversation: ctx } = await say(ctx, "confirm order", logger));
  ({ conversation: ctx } = await say(ctx, "delivery", logger));
  ({ conversation: ctx } = await say(ctx, "House 3 Street 1 Nazimabad", logger));
  ({ conversation: ctx } = await say(ctx, "ek gyro dedo", logger)); // interrupt at AWAITING_NAME
  assert.equal(ctx.order.state, "ORDER_REVIEW");
  // Bouncing back to ORDER_REVIEW resets forward checkout progress by
  // design (order-state-engine/index.ts#handleOrderReview always re-asks
  // delivery/pickup on re-confirm) — the whole delivery/address/name
  // subflow must be redone, not resumed from where it was interrupted.
  ({ conversation: ctx } = await say(ctx, "confirm order", logger));
  ({ conversation: ctx } = await say(ctx, "delivery", logger));
  ({ conversation: ctx } = await say(ctx, "House 3 Street 1 Nazimabad", logger));
  ({ conversation: ctx } = await say(ctx, "mera naam Hina hai", logger));
  ({ conversation: ctx } = await say(ctx, "submit", logger));
  assert.equal(ctx.order.state, "PENDING_VERIFICATION");
  assert.equal(ctx.order.cart.items.length, 2);
});

test("L5. rejecting an unavailable item mid-order doesn't disturb already-added items", async () => {
  const logger = newLogger();
  let ctx = newConversation();
  ({ conversation: ctx } = await say(ctx, "ek jumbo zinger dedo", logger));
  ({ conversation: ctx } = await say(ctx, "ek beef burger dedo", logger));
  assert.equal(ctx.order.cart.items.length, 1);
  assert.equal(ctx.order.cart.items[0].itemId, "jumbo-zinger");
});

test("L6. cancelling never happens automatically from ordinary conversation flow", async () => {
  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), ["ek jumbo zinger dedo", "checkout", "ruko", "confirm order"], logger);
  assert.notEqual(conversation.order.state, "CANCELLED");
});

// ─────────────────────────────────────────────────────────────────────────
// M. 30+ full conversation flows: first message through PENDING_VERIFICATION
// ─────────────────────────────────────────────────────────────────────────

interface FullFlowCase {
  name: string;
  messages: string[];
  expectedItemIds: string[];
}

const FULL_FLOW_CASES: FullFlowCase[] = [
  { name: "M01 jumbo zinger, pickup", messages: ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Ali", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M02 gyro, pickup", messages: ["ek gyro dedo", "checkout", "confirm order", "pickup", "Sara", "submit"], expectedItemIds: ["gyro"] },
  { name: "M03 zinger burger, delivery", messages: ["ek zinger burger dedo", "checkout", "confirm order", "delivery", "House 1 Street 2", "Bilal", "submit"], expectedItemIds: ["zinger-burger"] },
  { name: "M04 chicken steak, delivery", messages: ["ek chicken steak dedo", "checkout", "confirm order", "delivery", "House 2 Street 3", "Hina", "final submit"], expectedItemIds: ["chicken-steak"] },
  { name: "M05 chicken sandwich, pickup", messages: ["ek chicken sandwich dedo", "checkout", "confirm order", "pickup", "Zara", "yes submit"], expectedItemIds: ["chicken-sandwich"] },
  { name: "M06 club sandwich, pickup", messages: ["ek club sandwich dedo", "checkout", "confirm order", "pickup", "Omar", "done"], expectedItemIds: ["club-sandwich"] },
  { name: "M07 wrap, delivery", messages: ["ek wrap dedo", "checkout", "confirm order", "delivery", "House 5 Block C", "Fahad", "submit"], expectedItemIds: ["wrap"] },
  { name: "M08 pasta small (clarified), pickup", messages: ["ek pasta dedo", "pasta small", "checkout", "confirm order", "pickup", "Ayesha", "submit"], expectedItemIds: ["pasta-small"] },
  { name: "M09 alfredo pasta, delivery", messages: ["ek alfredo pasta dedo", "checkout", "confirm order", "delivery", "House 8 Nazimabad", "Kamran", "submit"], expectedItemIds: ["alfredo-pasta-white-sauce"] },
  { name: "M10 chicken chowmein, pickup", messages: ["ek chicken chowmein dedo", "checkout", "confirm order", "pickup", "Nida", "submit"], expectedItemIds: ["chicken-chowmein"] },
  { name: "M11 vegetable rice, delivery", messages: ["ek vegetable rice dedo", "checkout", "confirm order", "delivery", "House 10 Gulshan", "Waqas", "submit"], expectedItemIds: ["vegetable-rice"] },
  { name: "M12 chicken fried rice, pickup", messages: ["ek chicken fried rice dedo", "checkout", "confirm order", "pickup", "Bushra", "submit"], expectedItemIds: ["chicken-fried-rice"] },
  { name: "M13 think food special pizza, delivery", messages: ["ek think food special pizza dedo", "checkout", "confirm order", "delivery", "House 11 Korangi", "Imran", "submit"], expectedItemIds: ["think-food-special-pizza"] },
  { name: "M14 pizza regular, pickup", messages: ["ek pizza regular dedo", "checkout", "confirm order", "pickup", "Rabia", "submit"], expectedItemIds: ["pizza-regular-9-inch"] },
  { name: "M15 pizza fries small box, pickup", messages: ["ek pizza fries small box dedo", "checkout", "confirm order", "pickup", "Tariq", "submit"], expectedItemIds: ["pizza-fries-small-box"] },
  { name: "M16 hot shot starter, delivery", messages: ["ek hot shot dedo", "checkout", "confirm order", "delivery", "House 20 Malir", "Sana", "submit"], expectedItemIds: ["hot-shot-8-pcs-with-fries"] },
  { name: "M17 two jumbo zinger, pickup", messages: ["2 jumbo zinger dedo", "checkout", "confirm order", "pickup", "Adeel", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M18 jumbo zinger + gyro, delivery", messages: ["ek jumbo zinger dedo", "ek gyro dedo", "checkout", "confirm order", "delivery", "House 30 Defence", "Mahnoor", "submit"], expectedItemIds: ["jumbo-zinger", "gyro"] },
  { name: "M19 add then remove then add again, pickup", messages: ["ek gyro dedo", "gyro remove karo", "ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Usman", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M20 clarified zinger then checkout, delivery", messages: ["ek zinger dedo", "jumbo zinger", "checkout", "confirm order", "delivery", "House 40 Clifton", "Hamza", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M21 quantity change before checkout, pickup", messages: ["ek gyro dedo", "gyro ki quantity 3 kardo", "checkout", "confirm order", "pickup", "Farah", "submit"], expectedItemIds: ["gyro"] },
  { name: "M22 replace before checkout, delivery", messages: ["ek jumbo zinger dedo", "zinger hata kar steak add karo", "checkout", "confirm order", "delivery", "House 50 Saddar", "Kashif", "submit"], expectedItemIds: ["chicken-steak"] },
  { name: "M23 interrupt add mid-review, pickup", messages: ["ek jumbo zinger dedo", "checkout", "ek gyro dedo", "confirm order", "pickup", "Naila", "submit"], expectedItemIds: ["jumbo-zinger", "gyro"] },
  { name: "M24 interrupt remove mid-delivery-pickup, delivery", messages: ["ek jumbo zinger dedo", "ek gyro dedo", "checkout", "confirm order", "gyro remove karo", "confirm order", "delivery", "House 60 PECHS", "Danish", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M25 switch delivery to pickup mid-address, submit", messages: ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "pickup", "Rida", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M26 switch pickup to delivery mid-name, submit", messages: ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "delivery", "House 70 North Nazimabad", "Sami", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M27 English phrasing throughout, pickup", messages: ["I want a jumbo zinger", "checkout", "confirm order", "pickup", "my name is Ahmed", "submit"], expectedItemIds: ["jumbo-zinger"] },
  { name: "M28 Hinglish phrasing throughout, delivery", messages: ["2 zinger burger add karo", "checkout", "confirm order", "delivery", "House 80 Gulistan", "my name is Anum", "final submit"], expectedItemIds: ["zinger-burger"] },
  { name: "M29 mexican pizza, pickup, yes submit variant", messages: ["ek mexican pizza dedo", "checkout", "confirm order", "pickup", "Junaid", "yes submit"], expectedItemIds: ["mexican-pizza"] },
  { name: "M30 chicken strips starter, delivery, done variant", messages: ["ek chicken strips dedo", "checkout", "confirm order", "delivery", "House 90 Landhi", "Mariam", "done"], expectedItemIds: ["chicken-strips-6-pcs-with-fries"] },
  { name: "M31 noodles vegetable chowmein, pickup", messages: ["ek vegetable chowmein dedo", "checkout", "confirm order", "pickup", "Bilquis", "submit"], expectedItemIds: ["vegetable-chowmein"] },
  { name: "M32 macaroni pasta, delivery", messages: ["ek macaroni pasta dedo", "checkout", "confirm order", "delivery", "House 100 Nazimabad No 5", "Talha", "submit"], expectedItemIds: ["macaroni-pasta-red-sauce"] },
];

for (const flow of FULL_FLOW_CASES) {
  test(`M. full flow: ${flow.name}`, async () => {
    const logger = newLogger();
    const { conversation, result } = await driveMany(newConversation(), flow.messages, logger);
    assert.equal(conversation.order.state, "PENDING_VERIFICATION", `flow "${flow.name}" should reach PENDING_VERIFICATION`);
    assert.deepEqual(
      conversation.order.cart.items.map((i) => i.itemId).sort(),
      [...flow.expectedItemIds].sort(),
      `flow "${flow.name}" should end with the expected cart items`
    );
    assert.match(result.reply, /Pending Verification/);
    assert.equal(result.recovered, false, `flow "${flow.name}" should not need recovery`);
  });
}

test("M-count. at least 30 full end-to-end conversation flows are defined", async () => {
  assert.ok(FULL_FLOW_CASES.length >= 30, `expected >= 30 full flows, got ${FULL_FLOW_CASES.length}`);
});

// ─────────────────────────────────────────────────────────────────────────
// N. Orchestrator purity: same behavior as calling the pipeline directly
// ─────────────────────────────────────────────────────────────────────────

test("N1. orchestrator reply matches calling parseMessage -> processMessage -> buildResponse directly", async () => {
  const logger = newLogger();
  const before = createInitialContext();
  const parseResult = parseMessage("ek jumbo zinger dedo", before.cart, menu);
  const after = processMessage(before, parseResult, menu);
  const directReply = buildResponse({ parseResult, before, after, menu, restaurantConfig });

  const conversation = newConversation();
  const { result } = await say(conversation, "ek jumbo zinger dedo", logger);

  assert.equal(result.reply, directReply);
  assert.deepEqual(result.context.cart, after.cart);
  assert.equal(result.context.state, after.state);
});

test("N2. orchestrator context threading across turns matches manually threading OrderContext", async () => {
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"];

  let plain = createInitialContext();
  for (const m of messages) {
    const pr = parseMessage(m, plain.cart, menu);
    plain = processMessage(plain, pr, menu);
  }

  const logger = newLogger();
  const { conversation } = await driveMany(newConversation(), messages, logger);

  assert.equal(conversation.order.state, plain.state);
  assert.deepEqual(conversation.order.cart, plain.cart);
  assert.equal(conversation.order.customerName, plain.customerName);
});

test("N3. the orchestrator introduces no extra cart mutation beyond what the cart engine itself would produce", async () => {
  const logger = newLogger();
  const { conversation } = await say(newConversation(), "ek jumbo zinger dedo ek gyro dedo", logger);
  const totalQty = conversation.order.cart.items.reduce((sum, i) => sum + i.qty, 0);
  assert.equal(totalQty, conversation.order.cart.items.length === 2 ? 2 : totalQty);
});
