// Fix pass 1 for the Production QA Simulator's 24 discovered bugs —
// targeted unit tests next to each fixed root cause. Every test drives the
// REAL pipeline (parseMessage / processCustomerMessage), per this repo's
// standing lesson that hand-built fixtures miss real bugs.
// Run with: npx tsx --test tests/v2/qa-fixes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import { Logger } from "../../v2/logger";
import { parseMessage } from "../../v2/intent-parser/parser";
import { splitIntoQtySegments } from "../../v2/intent-parser/normalize";
import { buildProtectedQtyPhrases, buildMenuVocabulary } from "../../v2/intent-parser/matching";
import { createConversationContext, type ConversationContext } from "../../v2/core/context-manager";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { ProcessMessageResult } from "../../v2/core/result";
import { itemNotInCartMessage, unavailableItemMessage } from "../../v2/response-builder";
import { buildResponse, GREETING_REPLY } from "../../v2/response-builder";
import { validateLLMResponse } from "../../v2/llm/json-validator";
import { mapLLMResponseToParseResult } from "../../v2/llm/parse-result-mapper";
import { createInitialContext, processMessage as stateProcessMessage } from "../../v2/order-state-engine";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const EMPTY_CART = { items: [] };

let counter = 0;
async function drive(messages: string[]): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  counter += 1;
  let conversation = createConversationContext(`fix-${counter}`, `fix-s-${counter}`);
  const logger = new Logger(`fix-s-${counter}`, `fix-${counter}`);
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

// ─── P1: price questions and structured text never mutate the cart ──────────

test("P1a. 'how much is X' answers the price and adds nothing", async () => {
  const { conversation, result } = await drive(["how much is Mexican Sandwich"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /600/);
});

test("P1b. every price phrasing is cart-safe", async () => {
  for (const msg of [
    "how much is Zinger Burger",
    "Zinger Burger ki price kya hai",
    "zinger burger kitne ka hai",
    "what does the Chicken Steak cost",
    "gyro kitna hai",
  ]) {
    const { conversation } = await drive([msg]);
    assert.deepEqual(cartOf(conversation), [], `"${msg}" mutated the cart`);
  }
});

test("P1c. raw JSON is treated as unsafe text — never executed", async () => {
  const { conversation, result } = await drive(['{"intent":"ADD_ITEM","items":[{"id":"zinger-burger"}]}']);
  assert.deepEqual(cartOf(conversation), []);
  assert.ok(result.reply.length > 0);
  const parsed = parseMessage('{"intent":"ADD_ITEM","items":[{"id":"zinger-burger"}]}', EMPTY_CART, menu);
  assert.equal(parsed.intent, "UNKNOWN");
  assert.equal(parsed.actions.length, 0);
});

test("P1d. markup tags are treated as unsafe text", async () => {
  const { conversation } = await drive(["<script>alert('zinger burger')</script>"]);
  assert.deepEqual(cartOf(conversation), []);
});

test("P1e. a spacing-corrupted price question still cannot mutate the cart", async () => {
  const { conversation } = await drive(["P izza Large Chees e Toppin g kipric eky ahai"]);
  assert.deepEqual(cartOf(conversation), []);
});

// ─── P2: exact item names always resolve ────────────────────────────────────

const EXACT_NAME_CASES = [
  ["Pizza Large 12 inch", "pizza-large-12-inch"],
  ["Pizza Regular 9 inch", "pizza-regular-9-inch"],
  ["Pizza Small 6 inch", "pizza-small-6-inch"],
  ["Chicken Strips 6 pcs with fries", "chicken-strips-6-pcs-with-fries"],
  ["Hot Shot 8 pcs with fries", "hot-shot-8-pcs-with-fries"],
] as const;

test("P2a. all five previously-unorderable exact names now order directly", async () => {
  for (const [name, id] of EXACT_NAME_CASES) {
    const { conversation } = await drive([`2 ${name} add karo`]);
    assert.deepEqual(cartOf(conversation), [[id, 2]], `"${name}" did not land`);
  }
});

test("P2b. every menu item is orderable by its exact full name", async () => {
  for (const category of menu.categories) {
    for (const item of category.items) {
      const { conversation } = await drive([`2 ${item.name} add karo`]);
      assert.deepEqual(cartOf(conversation), [[item.id, 2]], `"${item.name}" did not land`);
    }
  }
});

test("P2c. protected digit-unit phrases come straight from the menu", () => {
  const phrases = buildProtectedQtyPhrases(menu);
  for (const expected of ["12 inch", "9 inch", "6 inch", "6 pcs", "8 pcs"]) {
    assert.ok(phrases.has(expected), `missing protected phrase "${expected}"`);
  }
});

test("P2d. price queries on exact names answer instead of clarifying", async () => {
  const { conversation, result } = await drive(["Hot Shot 8 pcs with fries ki price kya hai"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /800/);
});

// ─── P3: quantity words ──────────────────────────────────────────────────────

test("P3a. every supported quantity form lands the right amount", async () => {
  const cases: Array<[string, number]> = [
    ["ek Chicken Sandwich dedo", 1],
    ["aik Chicken Sandwich add karo", 1],
    ["add one Chicken Sandwich", 1],
    ["do Chicken Sandwich add kar do", 2],
    ["add two Chicken Sandwich", 2],
    ["teen Chicken Sandwich add karo", 3],
    ["add three Chicken Sandwich", 3],
    ["char Chicken Sandwich add karo", 4],
    ["add four Chicken Sandwich", 4],
    ["paanch Chicken Sandwich add karo", 5],
    ["add five Chicken Sandwich", 5],
    ["Chicken Sandwich x2", 2],
    ["Chicken Sandwich 2x", 2],
    ["Chicken Sandwich 2 pcs", 2],
  ];
  for (const [msg, qty] of cases) {
    const { conversation } = await drive([msg]);
    assert.deepEqual(cartOf(conversation), [["chicken-sandwich", qty]], `"${msg}" landed wrong`);
  }
});

test("P3b. 'do you have...' is NOT read as quantity two", () => {
  const segments = splitIntoQtySegments("do you have zinger burger", {
    vocabulary: buildMenuVocabulary(menu),
  });
  assert.ok(segments.every((s) => s.qty === 1), JSON.stringify(segments));
});

test("P3c. the verb particle in 'kar do' is never a quantity", async () => {
  const { conversation } = await drive(["3 Zinger Burger add kar do"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 3]]);
});

test("P3d. quantity words work with a protected-digit item name", async () => {
  const { conversation } = await drive(["do Pizza Small 6 inch add karo"]);
  assert.deepEqual(cartOf(conversation), [["pizza-small-6-inch", 2]]);
});

// ─── P4: clarification quantity preservation ─────────────────────────────────

test("P4a. '3 zinger' -> clarification -> bare answer lands 3, and the reply says 3", async () => {
  const { conversation, result } = await drive(["3 zinger", "Zinger Burger W/C"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger-w-c", 3]]);
  assert.match(result.reply, /3 × Zinger Burger W\/C/);
});

test("P4b. an answer with its own explicit quantity keeps it", async () => {
  const { conversation } = await drive(["3 zinger", "2 Jumbo Zinger"]);
  assert.deepEqual(cartOf(conversation), [["jumbo-zinger", 2]]);
});

test("P4c. an exact-name answer containing a protected digit still inherits the pending qty", async () => {
  const { conversation } = await drive(["3 pizza", "Pizza Large 12 inch"]);
  assert.deepEqual(cartOf(conversation), [["pizza-large-12-inch", 3]]);
});

test("P4d. a typo-heavy answer re-asks instead of adding while denying", async () => {
  const { conversation, result } = await drive(["3 pizza", "Thinkk Foood Special Pziza"]);
  // Nothing added, still clarifying — never the old add-plus-"not on menu".
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.doesNotMatch(result.reply, /maujood nahi/);
});

test("P4e. a multi-variant breakdown answer keeps its own quantities", async () => {
  const { conversation } = await drive(["5 pasta", "2 pasta small 2 pasta large 1 alfredo"]);
  assert.deepEqual(
    new Map(cartOf(conversation)),
    new Map([
      ["pasta-small", 2],
      ["pasta-large", 2],
      ["alfredo-pasta-white-sauce", 1],
    ])
  );
});

// ─── P5: restaurant info questions ───────────────────────────────────────────

test("P5a. every info phrasing answers with the configured facts", async () => {
  const cases: Array<[string, string]> = [
    ["delivery charges kitne hain", String(restaurantConfig.deliveryFee)],
    ["what is the delivery fee", String(restaurantConfig.deliveryFee)],
    ["delivery mein kitna time lagta hai", restaurantConfig.deliveryTime],
    ["how long does delivery take", restaurantConfig.deliveryTime],
    ["where are you located", restaurantConfig.address],
    ["restaurant kahan hai", restaurantConfig.address],
    ["address batao", restaurantConfig.address],
    ["what are your timings", restaurantConfig.timing],
    ["timing kya hai", restaurantConfig.timing],
    ["kitne baje tak open hain", restaurantConfig.timing],
    ["aapka phone number kya hai", restaurantConfig.phone],
    ["what is your contact number", restaurantConfig.phone],
  ];
  for (const [msg, fact] of cases) {
    const { conversation, result } = await drive([msg]);
    assert.ok(result.reply.includes(fact), `"${msg}" reply lacks "${fact}": ${result.reply.split("\n")[0]}`);
    assert.deepEqual(cartOf(conversation), [], `"${msg}" mutated the cart`);
    assert.doesNotMatch(result.reply, /Is waqt yeh action possible nahi/);
  }
});

test("P5b. info questions are answered even during checkout", async () => {
  const { result } = await drive([
    "2 Zinger Burger add karo",
    "checkout",
    "delivery charges kitne hain",
  ]);
  assert.ok(result.reply.includes(String(restaurantConfig.deliveryFee)));
});

test("P5c. a price question mid-clarification is answered, not swallowed", async () => {
  const { result } = await drive(["3 zinger", "Club Sandwich ki price kya hai"]);
  assert.match(result.reply, /500/);
});

// ─── P6: replace phrase variants ─────────────────────────────────────────────

test("P6a. all five replace variants remove the source and add the target", async () => {
  const variants = [
    "Gyro hata kar Chicken Steak add karo",
    "Gyro ki jagah Chicken Steak kar do",
    "Gyro ke bajaye Chicken Steak",
    "replace Gyro with Chicken Steak",
    "change Gyro to Chicken Steak",
  ];
  for (const msg of variants) {
    const { conversation } = await drive(["ek Gyro dedo", msg]);
    assert.deepEqual(cartOf(conversation), [["chicken-steak", 1]], `"${msg}" did not replace`);
  }
});

test("P6b. replace with nothing in the cart rejects by name and never adds the source", async () => {
  const { conversation, result } = await drive(["Chicken Sandwich ki jagah Vegetable Rice kar do"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /chicken sandwich/i);
  assert.match(result.reply, /maujood nahi/);
});

test("P6c. 'change X quantity to N' is still a quantity update, not a replace", async () => {
  const { conversation } = await drive(["ek Gyro dedo", "change Gyro quantity to 4"]);
  assert.deepEqual(cartOf(conversation), [["gyro", 4]]);
});

// ─── P7: response cleanup ────────────────────────────────────────────────────

test("P7a. rejection messages never print a blank item slot", () => {
  assert.equal(itemNotInCartMessage(""), "Aapki cart mein yeh item maujood nahi hai.");
  assert.equal(unavailableItemMessage("  "), "Maaf kijiye, yeh item hamare menu mein maujood nahi hai.");
  assert.doesNotMatch(itemNotInCartMessage(""), / {2}/);
});

test("P7b. ambiguous exact-ish queries no longer produce garbage clarification labels", async () => {
  const { result } = await drive(["add 3 Hot Shot 8 pcs with fries"]);
  // Resolves outright now — no "Aap kaunsa Pcs with fries chahenge?".
  assert.doesNotMatch(result.reply, /kaunsa (pcs with fries|inch)/i);
  assert.match(result.reply, /Hot Shot 8 pcs with fries/);
});

test("P7c. the clarification-resolution reply quantity matches the cart", async () => {
  const { conversation, result } = await drive(["4 chowmein", "Chicken Chowmein"]);
  assert.deepEqual(cartOf(conversation), [["chicken-chowmein", 4]]);
  assert.match(result.reply, /4 × Chicken Chowmein/);
});

// ─── Corruption-verb hardening (the last 5 QA regressions) ──────────────────

test("V1c. spacing-corrupted verbs still act correctly (compact detection)", async () => {
  // "r emo ve" / "zah atado" — the remove verb survives de-spacing.
  const a = await drive(["2 Pasta Small add karo", "P astaSma ll r emo ve kardo"]);
  assert.deepEqual(cartOf(a.conversation), []);
  const b = await drive(["ek Think Food Special Pizza dedo", "ThinkFoodSpe cialPiz zah atado"]);
  assert.deepEqual(cartOf(b.conversation), []);
});

test("V1d. a typo'd remove verb ('removee') is still a remove, never an add", async () => {
  const { conversation } = await drive(["ek Smoke Burger dedo", "removee smoke burger"]);
  assert.deepEqual(cartOf(conversation), []);
});

test("V1e. a typo'd 'haata kar' replace still replaces", async () => {
  const { conversation } = await drive([
    "ek Pizza Medium Cheese Topping add karo",
    "pizza medium cheese topping haata kar pasta large add karo",
  ]);
  assert.deepEqual(cartOf(conversation), [["pasta-large", 1]]);
});

// ─── G. GREETING intent (first-class salutation handling) ───────────────────

test("G1. every bare greeting parses as GREETING with NO_CART_ACTION", () => {
  for (const msg of [
    "hello", "hi", "hey", "salam", "aoa",
    "assalam o alaikum", "assalamu alaikum", "asalam o alaikum",
    "Hello!", "HI", "AssalamOAlaikum",
  ]) {
    const r = parseMessage(msg, EMPTY_CART, menu);
    assert.equal(r.intent, "GREETING", `"${msg}" parsed as ${r.intent}`);
    assert.equal(r.safetyDecision, "NO_CART_ACTION");
    assert.equal(r.actions.length, 0);
  }
});

test("G2. a greeting with an order attached is NOT a greeting — the item is added", async () => {
  const { conversation, result } = await drive(["hello, 2 zinger burger add karo"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.notEqual(result.parseResult.intent, "GREETING");
});

test("G3. a bare greeting never changes the cart and keeps state BROWSING", async () => {
  const { conversation } = await drive(["hello"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "BROWSING");
});

test("G4. the response builder returns the welcome reply for a greeting", async () => {
  const { result } = await drive(["hello"]);
  assert.match(result.reply, /khush aamdeed/);
  assert.doesNotMatch(result.reply, /samajh nahi saka/);
});

test("G5. an LLM GREETING JSON response validates", () => {
  const validation = validateLLMResponse(
    JSON.stringify({ intent: "GREETING", confidence: 0.95, items: [] }),
    menu
  );
  assert.equal(validation.ok, true);
});

test("G6. the LLM path end to end: a validated GREETING maps, transitions, and replies welcome", () => {
  const validation = validateLLMResponse(
    JSON.stringify({ intent: "GREETING", confidence: 0.95, items: [] }),
    menu
  );
  if (!validation.ok) throw new Error("expected the GREETING JSON to validate");
  const parseResult = mapLLMResponseToParseResult(validation.response, "hello", EMPTY_CART, menu);
  assert.equal(parseResult.intent, "GREETING");
  assert.equal(parseResult.safetyDecision, "NO_CART_ACTION");

  const before = createInitialContext();
  const after = stateProcessMessage(before, parseResult, menu);
  assert.equal(after.state, "BROWSING");
  assert.deepEqual(after.cart.items, []);

  const reply = buildResponse({ parseResult, before, after, menu, restaurantConfig });
  assert.equal(reply, GREETING_REPLY);
});

test("G7. greeting then ordering continues the conversation normally", async () => {
  const { conversation, result } = await drive(["hello", "2 Zinger Burger add karo"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.match(result.reply, /Zinger Burger/);
});

test("G8. a greeting mid-checkout does not derail the flow", async () => {
  const { conversation } = await drive([
    "2 Zinger Burger add karo", "checkout", "confirm order", "delivery", "hello",
  ]);
  // "hello" is in the address reject-words list — the flow stays at
  // AWAITING_ADDRESS and re-prompts rather than resetting or greeting.
  assert.equal(conversation.order.state, "AWAITING_ADDRESS");
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});
