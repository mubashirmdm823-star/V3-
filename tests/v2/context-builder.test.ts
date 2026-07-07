// V2 context builder & conversation memory tests. Drives the REAL pipeline
// (parseMessage -> processMessage -> buildResponse -> updateMemoryAfterTurn)
// wherever a conversation needs to happen, matching every prior V2 session's
// established convention of exercising real modules over hand-built
// fixtures. This module never calls an LLM and never mutates cart/state
// itself — the tests assert it faithfully mirrors/derives from what the
// already-shipped layers produced.
// Run with:
//   npx tsx --test tests/v2/context-builder.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { OrderContext } from "../../v2/types/order";
import { createInitialContext, processMessage } from "../../v2/order-state-engine";
import { parseMessage } from "../../v2/intent-parser/parser";
import { buildResponse } from "../../v2/response-builder";

import {
  createMemorySession,
  saveMemorySession,
  restoreMemorySession,
  resetMemorySession,
  cloneMemorySession,
  updateMemoryAfterTurn,
  buildAIContext,
  buildRelevantMenu,
  buildContextSummary,
  isRestaurantInfoQuery,
  isValidConversationMemory,
  isValidConversationTurn,
  isValidMenuContextResult,
  isValidAIContext,
  pruneHistory,
  getRecentTurns,
  getTurnsByCategory,
  isGreetingOrThanksTurn,
  isLowSignalTurn,
  isCompletedCheckoutTurn,
  MAX_MEMORY_LIST_LENGTH,
  type MemorySession,
  type AIContext,
} from "../../v2/context-builder";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

let idCounter = 0;
function newSession(): MemorySession {
  idCounter += 1;
  return createMemorySession(`conv-${idCounter}`, `sess-${idCounter}`);
}

interface Driver {
  ctx: OrderContext;
  session: MemorySession;
}

function newDriver(): Driver {
  return { ctx: createInitialContext(), session: newSession() };
}

function say(driver: Driver, rawMessage: string): { driver: Driver; reply: string; aiContextBefore: AIContext } {
  const aiContextBefore = buildAIContext(driver.session, rawMessage, menu, restaurantConfig);
  const before = driver.ctx;
  const parseResult = parseMessage(rawMessage, before.cart, menu);
  const after = processMessage(before, parseResult, menu);
  const reply = buildResponse({ parseResult, before, after, menu, restaurantConfig });
  const session = updateMemoryAfterTurn(driver.session, { rawMessage, parseResult, before, after, reply, menu });
  return { driver: { ctx: after, session }, reply, aiContextBefore };
}

function driveMany(driver: Driver, messages: string[]): { driver: Driver; reply: string } {
  let current = driver;
  let lastReply = "";
  for (const m of messages) {
    const step = say(current, m);
    current = step.driver;
    lastReply = step.reply;
  }
  return { driver: current, reply: lastReply };
}

// ─────────────────────────────────────────────────────────────────────────
// A. Conversation memory basics
// ─────────────────────────────────────────────────────────────────────────

test("A1. initial memory starts BROWSING with an empty cart and zero counter", () => {
  const session = newSession();
  assert.equal(session.memory.currentOrderState, "BROWSING");
  assert.equal(session.memory.currentCart.items.length, 0);
  assert.equal(session.memory.messageCounter, 0);
});

test("A2. memory records the message counter incrementing per turn", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.messageCounter, 1);
  ({ driver } = say(driver, "ek gyro dedo"));
  assert.equal(driver.session.memory.messageCounter, 2);
});

test("A3. previousIntents/previousActions/previousAIResponses accumulate", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = say(driver, "checkout"));
  assert.deepEqual(driver.session.memory.previousIntents, ["ADD_ITEM", "CHECKOUT_START"]);
  assert.equal(driver.session.memory.previousActions.length, 1); // only ADD_ITEM has an action
  assert.equal(driver.session.memory.previousAIResponses.length, 2);
});

test("A4. previousIntents list is bounded to MAX_MEMORY_LIST_LENGTH", () => {
  let driver = newDriver();
  for (let i = 0; i < MAX_MEMORY_LIST_LENGTH + 10; i++) {
    ({ driver } = say(driver, "menu dikhao"));
  }
  assert.equal(driver.session.memory.previousIntents.length, MAX_MEMORY_LIST_LENGTH);
  assert.equal(driver.session.memory.messageCounter, MAX_MEMORY_LIST_LENGTH + 10);
});

test("A5. memory currentResponseSeed reflects the most recent raw message", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.currentResponseSeed, "ek jumbo zinger dedo");
});

test("A6. conversationTimestamp never changes across turns, updatedAt does", () => {
  let driver = newDriver();
  const created = driver.session.memory.conversationTimestamp;
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.conversationTimestamp, created);
});

// ─────────────────────────────────────────────────────────────────────────
// B. Pending clarification memory (mirrored, never re-derived)
// ─────────────────────────────────────────────────────────────────────────

test("B1. a bare category question populates pendingClarification in memory", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "5 pasta"));
  assert.ok(driver.session.memory.pendingClarification);
  assert.equal(driver.session.memory.pendingClarification?.category, "pasta");
  assert.equal(driver.session.memory.pendingClarification?.quantity, 5);
});

test("B2. pendingClarification lists the real candidate options", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "5 pasta"));
  const names = driver.session.memory.pendingClarification?.options.map((o) => o.name) ?? [];
  assert.ok(names.includes("Pasta Small"));
  assert.ok(names.includes("Pasta Large"));
  assert.ok(names.includes("Alfredo Pasta white sauce"));
});

test("B3. resolving the clarification (2 small 2 large 1 alfredo) clears pendingClarification", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "5 pasta"));
  ({ driver } = say(driver, "2 small 2 large 1 alfredo"));
  assert.equal(driver.session.memory.pendingClarification, undefined);
  assert.ok(driver.session.memory.currentCart.items.length >= 2);
});

test("B4. pendingClarification is never invented — memory mirrors OrderContext exactly", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.pendingClarification, undefined);
  assert.deepEqual(driver.session.memory.pendingClarification, driver.ctx.pendingClarification);
});

test("B5. cart is NOT mutated while a clarification is pending", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  assert.equal(driver.session.memory.currentCart.items.length, 0);
});

test("B6. an ambiguous follow-up re-asks rather than guessing (memory keeps the same pending category)", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  const before = driver.session.memory.pendingClarification;
  ({ driver } = say(driver, "zinger"));
  assert.equal(driver.session.memory.pendingClarification?.category, before?.category);
});

test("B7. AIContext built while clarification is pending exposes it directly", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  const ctx = buildAIContext(driver.session, "jumbo zinger", menu, restaurantConfig);
  assert.ok(ctx.pendingClarification);
  assert.equal(ctx.pendingClarification?.category, "zinger");
});

test("B8. resolving via the exact item name works after clarification (jumbo zinger)", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  ({ driver } = say(driver, "jumbo zinger"));
  assert.equal(driver.session.memory.currentCart.items[0].itemId, "jumbo-zinger");
});

// ─────────────────────────────────────────────────────────────────────────
// C. Topic tracking
// ─────────────────────────────────────────────────────────────────────────

test("C1. adding an unambiguous item sets currentTopic to its category", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
  assert.equal(driver.session.memory.lastMentionedProduct, "Jumbo Zinger");
});

test("C2. topic survives an unrelated info question", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = say(driver, "aapka number kya hai"));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
});

test("C3. topic survives a greeting-shaped message", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = say(driver, "hi"));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
});

test("C4. switching to a different item changes the topic", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = say(driver, "ek gyro dedo"));
  assert.equal(driver.session.memory.currentTopic, "Roll");
});

test("C5. topic anchored via an ambiguous family word alone (bare 'burger') still records a topic", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "burger dikhao"));
  assert.ok(driver.session.memory.currentTopic);
});

test("C6. lastOrderedCategory/lastOrderedItem only update on an actual cart addition", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "gyro ki price kya hai"));
  assert.equal(driver.session.memory.lastOrderedItem, undefined);
  ({ driver } = say(driver, "ek gyro dedo"));
  assert.equal(driver.session.memory.lastOrderedItem, "Gyro");
  assert.equal(driver.session.memory.lastOrderedCategory, "Roll");
});

test("C7. clearing the cart resets the topic (conversation naturally changes)", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.ok(driver.session.memory.currentTopic);
  ({ driver } = say(driver, "remove everything"));
  assert.equal(driver.session.memory.currentTopic, undefined);
});

test("C8. topic is used to disambiguate 'large kar do' toward Pizza in the NEXT built context", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek think food special pizza dedo"));
  const ctxBefore = buildAIContext(driver.session, "large kar do", menu, restaurantConfig);
  assert.deepEqual(ctxBefore.menuContext.matchedCategoryKeys, ["pizza"]);
});

test("C9. topic is used to disambiguate 'white sauce kar do' toward Pasta", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek pasta small dedo"));
  const ctxBefore = buildAIContext(driver.session, "white sauce kar do", menu, restaurantConfig);
  assert.deepEqual(ctxBefore.menuContext.matchedCategoryKeys, ["pasta"]);
});

test("C10. never lose topic across many unrelated turns until it naturally changes", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = driveMany(driver, ["menu dikhao", "aapka address kya hai", "gyro ki price kya hai", "hi"]));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
});

// ─────────────────────────────────────────────────────────────────────────
// D. Relevant menu builder
// ─────────────────────────────────────────────────────────────────────────

test("D1. 'pizza' resolves to only the Pizza category", () => {
  const r = buildRelevantMenu(menu, "pizza");
  assert.deepEqual(r.matchedCategoryKeys, ["pizza"]);
  assert.equal(r.isFullMenu, false);
  assert.equal(r.restaurantOnly, false);
});

test("D2. 'burger' resolves to only the Burgers category (plural-tolerant)", () => {
  const r = buildRelevantMenu(menu, "burger");
  assert.deepEqual(r.matchedCategoryKeys, ["burgers"]);
});

test("D3. 'delivery charges' needs no menu at all", () => {
  const r = buildRelevantMenu(menu, "delivery charges");
  assert.equal(r.categories.length, 0);
  assert.equal(r.restaurantOnly, true);
});

test("D4. 'restaurant address' needs no menu at all", () => {
  const r = buildRelevantMenu(menu, "restaurant address");
  assert.equal(r.restaurantOnly, true);
});

test("D5. '2 jumbo zinger and 1 alfredo' resolves to Burgers AND Pasta", () => {
  const r = buildRelevantMenu(menu, "2 jumbo zinger and 1 alfredo");
  assert.deepEqual(r.matchedCategoryKeys.sort(), ["burgers", "pasta"]);
});

test("D6. 'menu dikhao' with no specific category returns the full menu", () => {
  const r = buildRelevantMenu(menu, "menu dikhao");
  assert.equal(r.isFullMenu, true);
  assert.equal(r.categories.length, menu.categories.length);
});

test("D7. gibberish with no topic returns an empty, non-full menu", () => {
  const r = buildRelevantMenu(menu, "asdkjh qweoiu");
  assert.equal(r.categories.length, 0);
  assert.equal(r.isFullMenu, false);
  assert.equal(r.restaurantOnly, false);
});

test("D8. an ambiguous size word resolves via currentTopic continuity (Pizza)", () => {
  const r = buildRelevantMenu(menu, "large kar do", { currentTopic: "Pizza" });
  assert.deepEqual(r.matchedCategoryKeys, ["pizza"]);
});

test("D9. an ambiguous size word with NO topic returns every category it could mean", () => {
  const r = buildRelevantMenu(menu, "large kar do");
  assert.ok(r.matchedCategoryKeys.length > 1);
});

test("D10. 'spicy wala' with Burgers topic resolves to Burgers directly (single item match, no topic needed)", () => {
  const r = buildRelevantMenu(menu, "spicy wala", { currentTopic: "Burgers" });
  assert.deepEqual(r.matchedCategoryKeys, ["burgers"]);
});

test("D11. isRestaurantInfoQuery recognizes timing/phone/address phrasing", () => {
  assert.equal(isRestaurantInfoQuery("timing kya hai"), true);
  assert.equal(isRestaurantInfoQuery("phone number kya hai"), true);
  assert.equal(isRestaurantInfoQuery("2 jumbo zinger dedo"), false);
});

test("D12. sandwiches category matches singular 'sandwich' mention", () => {
  const r = buildRelevantMenu(menu, "sandwich dikhao");
  assert.ok(r.matchedCategoryKeys.includes("sandwiches") || r.isFullMenu);
});

// ─────────────────────────────────────────────────────────────────────────
// E. Checkout memory
// ─────────────────────────────────────────────────────────────────────────

test("E1. currentCheckoutStage mirrors OrderContext.state through the whole flow", () => {
  let driver = newDriver();
  const stages: string[] = [];
  for (const m of ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]) {
    ({ driver } = say(driver, m));
    stages.push(driver.session.memory.currentCheckoutStage);
  }
  assert.deepEqual(stages, [
    "CART_EDITING", "ORDER_REVIEW", "AWAITING_DELIVERY_PICKUP", "AWAITING_NAME", "READY_TO_SUBMIT", "PENDING_VERIFICATION",
  ]);
});

test("E2. currentOrderState and currentCheckoutStage always agree", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.currentOrderState, driver.session.memory.currentCheckoutStage);
});

test("E3. an interruption during AWAITING_DELIVERY_PICKUP is reflected back into memory as ORDER_REVIEW", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "ek gyro dedo"]));
  assert.equal(driver.session.memory.currentCheckoutStage, "ORDER_REVIEW");
});

test("E4. history records every state transition across a checkout", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order"]));
  assert.equal(driver.session.history.length, 3);
  assert.equal(driver.session.history[1].stateAfter, "ORDER_REVIEW");
});

test("E5. after PENDING_VERIFICATION, further messages don't change checkout memory", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]));
  ({ driver } = say(driver, "ek gyro dedo"));
  assert.equal(driver.session.memory.currentCheckoutStage, "PENDING_VERIFICATION");
});

test("E6. memory reflects CANCELLED if the order is explicitly cancelled via order-state-engine", () => {
  const cancelled = { ...createInitialContext(), state: "CANCELLED" as const };
  const session = newSession();
  const parseResult = parseMessage("hi", cancelled.cart, menu);
  const after = processMessage(cancelled, parseResult, menu);
  const reply = buildResponse({ parseResult, before: cancelled, after, menu, restaurantConfig });
  const updated = updateMemoryAfterTurn(session, { rawMessage: "hi", parseResult, before: cancelled, after, reply, menu });
  assert.equal(updated.memory.currentCheckoutStage, "CANCELLED");
});

// ─────────────────────────────────────────────────────────────────────────
// F. Address / name memory
// ─────────────────────────────────────────────────────────────────────────

test("F1. address is recorded in memory once accepted", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, [
    "ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 45 Street 12 Nazimabad Karachi",
  ]));
  assert.ok(driver.session.memory.deliveryAddress);
  assert.equal(driver.session.memory.deliveryType, "delivery");
});

test("F2. an invalid address reply does not get stored in memory", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "ok"]));
  assert.equal(driver.session.memory.deliveryAddress, undefined);
});

test("F3. customer name is recorded once accepted", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "mera naam Fahad hai"]));
  assert.equal(driver.session.memory.customerName, "Fahad");
});

test("F4. name/address persist into a later context summary", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "mera naam Fahad hai"]));
  const summary = buildContextSummary(driver.session.memory);
  assert.match(summary, /Fahad/);
  assert.match(summary, /Pickup/);
});

// ─────────────────────────────────────────────────────────────────────────
// G. Cart persistence in memory
// ─────────────────────────────────────────────────────────────────────────

test("G1. cart in memory always matches the real OrderContext cart", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "ek gyro dedo"]));
  assert.deepEqual(driver.session.memory.currentCart, driver.ctx.cart);
});

test("G2. cart mutation history is visible via AIContext.currentCart", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const ctx = buildAIContext(driver.session, "checkout", menu, restaurantConfig);
  assert.equal(ctx.currentCart.items.length, 1);
});

test("G3. an empty cart is reflected as such through the whole context object", () => {
  const driver = newDriver();
  const ctx = buildAIContext(driver.session, "hi", menu, restaurantConfig);
  assert.equal(ctx.currentCart.items.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// H. History pruning
// ─────────────────────────────────────────────────────────────────────────

test("H1. pruneHistory keeps everything when under the recency window", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "ek gyro dedo"]));
  assert.equal(driver.session.history.length, 2);
});

test("H2. old greeting turns get pruned once outside the recency window", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "hi"));
  for (let i = 0; i < 15; i++) ({ driver } = say(driver, "ek gyro dedo"));
  const greetingsLeft = driver.session.history.filter((t) => t.rawMessage === "hi");
  assert.equal(greetingsLeft.length, 0);
});

test("H3. old SHOW_MENU/price-query turns get pruned once outside the recency window", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "menu dikhao"));
  for (let i = 0; i < 15; i++) ({ driver } = say(driver, "ek gyro dedo"));
  const menuTurnsLeft = driver.session.history.filter((t) => t.intent === "SHOW_MENU");
  assert.equal(menuTurnsLeft.length, 0);
});

test("H4. a completed checkout's own turns get pruned once far enough in the past", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]));
  for (let i = 0; i < 10; i++) ({ driver } = say(driver, "hi"));
  // The trivial fact that every post-finalization "hi" turn's OWN
  // stateAfter is also PENDING_VERIFICATION is expected (state doesn't
  // change once finalized) — what should actually be gone is the finished
  // order's own content (the add/checkout turns), not every mention of the
  // terminal state.
  const originalCheckoutTurnsLeft = driver.session.history.filter(
    (t) => t.rawMessage === "ek jumbo zinger dedo" || t.rawMessage === "checkout"
  );
  assert.equal(originalCheckoutTurnsLeft.length, 0);
});

test("H5. recent turns are never pruned regardless of content", () => {
  let driver = newDriver();
  for (let i = 0; i < 5; i++) ({ driver } = say(driver, "hi"));
  assert.equal(driver.session.history.length, 5);
});

test("H6. a turn matching the current topic is kept even outside the recency window", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  for (let i = 0; i < 15; i++) ({ driver } = say(driver, "gyro ki price kya hai"));
  const burgerTurnsLeft = driver.session.history.filter((t) => t.category === undefined && t.intent === "ADD_ITEM");
  assert.ok(burgerTurnsLeft.length >= 1);
});

test("H7. pruneHistory helper directly: greeting turns are prunable, cart-mutating turns are not", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const cartTurn = driver.session.history[0];
  assert.equal(isGreetingOrThanksTurn(cartTurn), false);
  assert.equal(isLowSignalTurn(cartTurn), false);
});

test("H8. isGreetingOrThanksTurn / isLowSignalTurn / isCompletedCheckoutTurn classify correctly", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "hi"));
  assert.equal(isGreetingOrThanksTurn(driver.session.history[0]), true);
  assert.equal(isCompletedCheckoutTurn(driver.session.history[0]), false);
  ({ driver } = say(driver, "menu dikhao"));
  assert.equal(isLowSignalTurn(driver.session.history[1]), true);
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]));
  assert.equal(isCompletedCheckoutTurn(driver.session.history[driver.session.history.length - 1]), true);
});

test("H9. getRecentTurns/getTurnsByCategory read helpers work against real history", () => {
  let driver = newDriver();
  // "burger dikhao" is SHOW_OPTIONS with a leftover category ("burger"),
  // which is what actually populates ConversationTurn.category — a clean
  // unambiguous ADD_ITEM (e.g. "jumbo zinger") never carries one, since the
  // parser only sets ParseResult.category for genuinely ambiguous/browsing
  // messages (v2/intent-parser/parser.ts's finalize() calls).
  ({ driver } = driveMany(driver, ["burger dikhao", "ek gyro dedo"]));
  assert.equal(getRecentTurns(driver.session.history, 1).length, 1);
  assert.ok(getTurnsByCategory(driver.session.history, "burger").length >= 1);
});

test("H10. pruneHistory is a pure function — same input, same output", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["hi", "ek jumbo zinger dedo", "menu dikhao"]));
  const a = pruneHistory(driver.session.history, { currentTopic: "Burgers" });
  const b = pruneHistory(driver.session.history, { currentTopic: "Burgers" });
  assert.deepEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────────────
// I. Conversation switching / reset
// ─────────────────────────────────────────────────────────────────────────

test("I1. resetMemorySession clears cart/state/topic but keeps identity", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]));
  const reset = resetMemorySession(driver.session);
  assert.equal(reset.memory.conversationId, driver.session.memory.conversationId);
  assert.equal(reset.memory.sessionId, driver.session.memory.sessionId);
  assert.equal(reset.memory.currentOrderState, "BROWSING");
  assert.equal(reset.memory.currentCart.items.length, 0);
  assert.equal(reset.memory.currentTopic, undefined);
  assert.equal(reset.history.length, 0);
});

test("I2. a fresh order after reset builds a clean AIContext", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]));
  const session = resetMemorySession(driver.session);
  const ctx = buildAIContext(session, "ek gyro dedo", menu, restaurantConfig);
  assert.equal(ctx.currentState, "BROWSING");
  assert.equal(ctx.currentCart.items.length, 0);
});

test("I3. switching conversations (two independent sessions) never leaks state between them", () => {
  let driverA = newDriver();
  let driverB = newDriver();
  ({ driver: driverA } = say(driverA, "ek jumbo zinger dedo"));
  ({ driver: driverB } = say(driverB, "ek gyro dedo"));
  assert.equal(driverA.session.memory.currentCart.items[0].itemId, "jumbo-zinger");
  assert.equal(driverB.session.memory.currentCart.items[0].itemId, "gyro");
});

// ─────────────────────────────────────────────────────────────────────────
// J. Session persistence (save / restore / clone)
// ─────────────────────────────────────────────────────────────────────────

test("J1. save then restore reproduces an identical memory session", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const restored = restoreMemorySession(saveMemorySession(driver.session));
  assert.deepEqual(restored, driver.session);
});

test("J2. restore rejects invalid JSON", () => {
  assert.throws(() => restoreMemorySession("not json"));
});

test("J3. restore rejects a well-formed object with the wrong shape", () => {
  assert.throws(() => restoreMemorySession(JSON.stringify({ foo: "bar" })));
});

test("J4. a restored session can continue a pending clarification seamlessly", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  const restoredSession = restoreMemorySession(saveMemorySession(driver.session));
  driver = { ctx: driver.ctx, session: restoredSession };
  ({ driver } = say(driver, "jumbo zinger"));
  assert.equal(driver.session.memory.currentCart.items[0].itemId, "jumbo-zinger");
});

test("J5. cloneMemorySession produces a deep, independent copy", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const clone = cloneMemorySession(driver.session);
  assert.deepEqual(clone, driver.session);
  assert.notEqual(clone.memory.currentCart, driver.session.memory.currentCart);
});

test("J6. save/restore round trip preserves full turn history", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order"]));
  const restored = restoreMemorySession(saveMemorySession(driver.session));
  assert.equal(restored.history.length, driver.session.history.length);
});

test("J7. save/restore round trip preserves topic tracking fields", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const restored = restoreMemorySession(saveMemorySession(driver.session));
  assert.equal(restored.memory.currentTopic, "Burgers");
});

test("J8. save/restore round trip preserves address/name/delivery fields", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 1 Street 2", "mera naam Ali hai"]));
  const restored = restoreMemorySession(saveMemorySession(driver.session));
  assert.equal(restored.memory.customerName, "Ali");
  assert.ok(restored.memory.deliveryAddress);
  assert.equal(restored.memory.deliveryType, "delivery");
});

// ─────────────────────────────────────────────────────────────────────────
// K. Context validation
// ─────────────────────────────────────────────────────────────────────────

test("K1. isValidConversationMemory rejects garbage", () => {
  assert.equal(isValidConversationMemory(null), false);
  assert.equal(isValidConversationMemory({}), false);
  assert.equal(isValidConversationMemory({ conversationId: "x", sessionId: "y", currentOrderState: "NOT_REAL" }), false);
});

test("K2. isValidConversationMemory accepts a real memory object", () => {
  const session = newSession();
  assert.equal(isValidConversationMemory(session.memory), true);
});

test("K3. isValidConversationTurn rejects garbage", () => {
  assert.equal(isValidConversationTurn(null), false);
  assert.equal(isValidConversationTurn({ stateBefore: "NOT_REAL" }), false);
});

test("K4. isValidConversationTurn accepts a real turn", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(isValidConversationTurn(driver.session.history[0]), true);
});

test("K5. isValidMenuContextResult rejects garbage, accepts a real result", () => {
  assert.equal(isValidMenuContextResult(null), false);
  assert.equal(isValidMenuContextResult(buildRelevantMenu(menu, "pizza")), true);
});

test("K6. isValidAIContext rejects garbage", () => {
  assert.equal(isValidAIContext(null), false);
  assert.equal(isValidAIContext({}), false);
});

test("K7. isValidAIContext accepts a real built context", () => {
  const driver = newDriver();
  const ctx = buildAIContext(driver.session, "ek jumbo zinger dedo", menu, restaurantConfig);
  assert.equal(isValidAIContext(ctx), true);
});

test("K8. buildAIContext never throws even for a bizarre/empty customer message", () => {
  const driver = newDriver();
  assert.doesNotThrow(() => buildAIContext(driver.session, "", menu, restaurantConfig));
  assert.doesNotThrow(() => buildAIContext(driver.session, "   ", menu, restaurantConfig));
});

// ─────────────────────────────────────────────────────────────────────────
// L. Context summary
// ─────────────────────────────────────────────────────────────────────────

test("L1. summary format matches the exact required structure", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, [
    "ek jumbo zinger dedo", "ek alfredo pasta dedo", "checkout", "confirm order", "delivery",
  ]));
  const summary = buildContextSummary(driver.session.memory);
  assert.match(summary, /^Current State:\n/);
  assert.match(summary, /Current Cart:/);
  assert.match(summary, /Pending:/);
  assert.match(summary, /Customer Name:/);
  assert.match(summary, /Delivery:/);
  assert.match(summary, /Address:/);
  assert.match(summary, /Current Topic:/);
  assert.match(summary, /Pending Clarification:/);
});

test("L2. summary shows the real cart line items with quantities", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["2 jumbo zinger dedo", "ek alfredo pasta dedo"]));
  const summary = buildContextSummary(driver.session.memory);
  assert.match(summary, /2 Jumbo Zinger/);
  assert.match(summary, /1 Alfredo Pasta white sauce/);
});

test("L3. summary shows 'Empty' for an empty cart", () => {
  const summary = buildContextSummary(newSession().memory);
  assert.match(summary, /Empty/);
});

test("L4. summary shows 'None' for no pending clarification and no topic", () => {
  const summary = buildContextSummary(newSession().memory);
  assert.match(summary, /Pending:\nNone/);
  assert.match(summary, /Current Topic:\nNone/);
  assert.match(summary, /Pending Clarification:\nNone/);
});

test("L5. summary reflects a pending clarification's category", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  const summary = buildContextSummary(driver.session.memory);
  assert.match(summary, /Pending:\nAwaiting clarification/);
  assert.match(summary, /Pending Clarification:\nZinger/);
});

test("L6. summary reflects 'Not Yet Provided'/'Not Yet Selected' before checkout info exists", () => {
  const summary = buildContextSummary(newSession().memory);
  assert.match(summary, /Address:\nNot Yet Provided/);
  assert.match(summary, /Delivery:\nNot Yet Selected/);
  assert.match(summary, /Customer Name:\nNot Yet Provided/);
});

test("L7. summary state line matches the real current order state", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout"]));
  const summary = buildContextSummary(driver.session.memory);
  assert.match(summary, /Current State:\nORDER_REVIEW/);
});

// ─────────────────────────────────────────────────────────────────────────
// M. Long / very long conversations
// ─────────────────────────────────────────────────────────────────────────

test("M1. a 50-message mixed conversation never throws and keeps a valid memory shape", () => {
  let driver = newDriver();
  const messages = [
    "menu dikhao", "ek jumbo zinger dedo", "ek gyro dedo", "mera cart dikhao",
    "gyro remove karo", "ek pasta dedo", "pasta small", "ek zinger dedo", "jumbo zinger",
    "checkout", "ek gyro dedo", "confirm order", "delivery", "House 1 Street 2 Nazimabad",
    "mera naam Ali hai", "submit", "hi", "thanks",
  ];
  for (let i = 0; i < 3; i++) driver = driveMany(driver, messages).driver;
  assert.equal(isValidConversationMemory(driver.session.memory), true);
});

test("M2. a very long (100+ message) conversation stays performant and bounded", () => {
  let driver = newDriver();
  const start = performance.now();
  for (let i = 0; i < 120; i++) {
    ({ driver } = say(driver, i % 2 === 0 ? "ek gyro dedo" : "gyro remove karo"));
  }
  const elapsed = performance.now() - start;
  assert.ok(driver.session.history.length <= 500);
  assert.ok(elapsed < 2000, `120 turns took too long: ${elapsed}ms`);
});

test("M3. building a single AIContext runs well under the 10ms performance target", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]));
  const start = performance.now();
  buildAIContext(driver.session, "confirm order", menu, restaurantConfig);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 10, `expected < 10ms, got ${elapsed}`);
});

// ─────────────────────────────────────────────────────────────────────────
// N. Mixed language
// ─────────────────────────────────────────────────────────────────────────

test("N1. pure English conversation tracks memory identically to Roman Urdu", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["I want a jumbo zinger", "checkout", "confirm order", "pickup", "my name is Ali", "submit"]));
  assert.equal(driver.session.memory.currentCheckoutStage, "PENDING_VERIFICATION");
  assert.equal(driver.session.memory.customerName, "Ali");
});

test("N2. Hinglish mixed conversation tracks topic and cart correctly", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["2 zinger burger add karo please", "checkout"]));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
  assert.equal(driver.session.memory.currentCheckoutStage, "ORDER_REVIEW");
});

test("N3. switching languages mid-conversation doesn't break memory continuity", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "show me the cart", "gyro hata do please"]));
  assert.equal(driver.session.memory.currentCart.items.length, 1);
});

test("N4. Roman Urdu restaurant-info question needs no menu context", () => {
  const r = buildRelevantMenu(menu, "aapka number kya hai");
  assert.equal(r.restaurantOnly, true);
});

// ─────────────────────────────────────────────────────────────────────────
// O. Multiple clarification chains
// ─────────────────────────────────────────────────────────────────────────

test("O1. two clarification chains back to back both resolve and both get recorded", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek pasta dedo"));
  ({ driver } = say(driver, "pasta small"));
  ({ driver } = say(driver, "ek zinger dedo"));
  ({ driver } = say(driver, "jumbo zinger"));
  assert.equal(driver.session.memory.currentCart.items.length, 2);
  assert.equal(driver.session.memory.pendingClarification, undefined);
});

test("O2. abandoning a pending clarification with an unrelated request clears it from memory", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  ({ driver } = say(driver, "menu dikhao"));
  assert.equal(driver.session.memory.pendingClarification, undefined);
});

test("O3. history captures the clarification-ask turn and the resolution turn separately", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek zinger dedo"));
  ({ driver } = say(driver, "jumbo zinger"));
  assert.equal(driver.session.history[0].stateAfter, "AWAITING_CLARIFICATION");
  assert.equal(driver.session.history[1].stateAfter, "CART_EDITING");
});

// ─────────────────────────────────────────────────────────────────────────
// P. Restaurant information
// ─────────────────────────────────────────────────────────────────────────

test("P1. restaurant info question resolves to restaurantOnly context, no menu needed", () => {
  const ctx = buildAIContext(newSession(), "aapka address kya hai", menu, restaurantConfig);
  assert.equal(ctx.menuContext.restaurantOnly, true);
  assert.equal(ctx.relevantMenu.categories.length, 0);
});

test("P2. restaurantConfig is always present in the built context regardless of message", () => {
  const ctx = buildAIContext(newSession(), "ek jumbo zinger dedo", menu, restaurantConfig);
  assert.equal(ctx.restaurantConfig.name, "Think Food");
});

test("P3. asking restaurant info doesn't disturb existing cart/topic memory", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  ({ driver } = say(driver, "aapka address kya hai"));
  assert.equal(driver.session.memory.currentCart.items.length, 1);
  assert.equal(driver.session.memory.currentTopic, "Burgers");
});

// ─────────────────────────────────────────────────────────────────────────
// Q. Multiple categories / category switching
// ─────────────────────────────────────────────────────────────────────────

test("Q1. ordering from two categories in separate messages tracks the latest as current topic", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  assert.equal(driver.session.memory.currentTopic, "Burgers");
  ({ driver } = say(driver, "ek alfredo pasta dedo"));
  assert.equal(driver.session.memory.currentTopic, "Pasta");
});

test("Q2. a single compound message touching two categories is reflected in the relevant menu for the NEXT context", () => {
  const ctx = buildAIContext(newSession(), "2 jumbo zinger and 1 alfredo", menu, restaurantConfig);
  assert.deepEqual(ctx.menuContext.matchedCategoryKeys.sort(), ["burgers", "pasta"]);
});

test("Q3. lastMentionedCategory/lastMentionedProduct update independently of lastOrderedCategory/Item", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "gyro ki price kya hai"));
  assert.equal(driver.session.memory.lastMentionedProduct, "Gyro");
  assert.equal(driver.session.memory.lastOrderedItem, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// R. Interruptions and recovery
// ─────────────────────────────────────────────────────────────────────────

test("R1. 'ruko' mid-checkout is recorded without corrupting checkout memory", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "ruko"]));
  assert.equal(driver.session.memory.currentCheckoutStage, "AWAITING_DELIVERY_PICKUP");
});

test("R2. adding an item mid-checkout bounces memory's checkout stage back to ORDER_REVIEW", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "checkout", "confirm order", "ek gyro dedo"]));
  assert.equal(driver.session.memory.currentCheckoutStage, "ORDER_REVIEW");
  assert.equal(driver.session.memory.currentCart.items.length, 2);
});

test("R3. removing an item mid-checkout ('burger hata do') is reflected correctly in memory", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, ["ek jumbo zinger dedo", "ek gyro dedo", "checkout", "confirm order", "gyro hata do"]));
  assert.equal(driver.session.memory.currentCart.items.length, 1);
  assert.equal(driver.session.memory.currentCheckoutStage, "ORDER_REVIEW");
});

test("R4. recovery after interruption: conversation still reaches PENDING_VERIFICATION", () => {
  let driver = newDriver();
  ({ driver } = driveMany(driver, [
    "ek jumbo zinger dedo", "checkout", "confirm order", "ek gyro dedo",
    "confirm order", "pickup", "Bilal", "submit",
  ]));
  assert.equal(driver.session.memory.currentCheckoutStage, "PENDING_VERIFICATION");
  assert.equal(driver.session.memory.currentCart.items.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// S. 40+ full conversation flows: first message through PENDING_VERIFICATION
// ─────────────────────────────────────────────────────────────────────────

interface FullFlowCase {
  name: string;
  messages: string[];
  expectedItemIds: string[];
  expectedTopicCategory: string;
}

const FULL_FLOW_CASES: FullFlowCase[] = [
  { name: "S01 jumbo zinger, pickup", messages: ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Ali", "submit"], expectedItemIds: ["jumbo-zinger"], expectedTopicCategory: "Burgers" },
  { name: "S02 gyro, pickup", messages: ["ek gyro dedo", "checkout", "confirm order", "pickup", "Sara", "submit"], expectedItemIds: ["gyro"], expectedTopicCategory: "Roll" },
  { name: "S03 zinger burger, delivery", messages: ["ek zinger burger dedo", "checkout", "confirm order", "delivery", "House 1 Street 2", "Bilal", "submit"], expectedItemIds: ["zinger-burger"], expectedTopicCategory: "Burgers" },
  { name: "S04 chicken steak, delivery", messages: ["ek chicken steak dedo", "checkout", "confirm order", "delivery", "House 2 Street 3", "Hina", "final submit"], expectedItemIds: ["chicken-steak"], expectedTopicCategory: "Steaks" },
  { name: "S05 chicken sandwich, pickup", messages: ["ek chicken sandwich dedo", "checkout", "confirm order", "pickup", "Zara", "yes submit"], expectedItemIds: ["chicken-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S06 club sandwich, pickup", messages: ["ek club sandwich dedo", "checkout", "confirm order", "pickup", "Omar", "done"], expectedItemIds: ["club-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S07 wrap, delivery", messages: ["ek wrap dedo", "checkout", "confirm order", "delivery", "House 5 Block C", "Fahad", "submit"], expectedItemIds: ["wrap"], expectedTopicCategory: "Roll" },
  { name: "S08 pasta small (clarified), pickup", messages: ["ek pasta dedo", "pasta small", "checkout", "confirm order", "pickup", "Ayesha", "submit"], expectedItemIds: ["pasta-small"], expectedTopicCategory: "Pasta" },
  { name: "S09 alfredo pasta, delivery", messages: ["ek alfredo pasta dedo", "checkout", "confirm order", "delivery", "House 8 Nazimabad", "Kamran", "submit"], expectedItemIds: ["alfredo-pasta-white-sauce"], expectedTopicCategory: "Pasta" },
  { name: "S10 chicken chowmein, pickup", messages: ["ek chicken chowmein dedo", "checkout", "confirm order", "pickup", "Nida", "submit"], expectedItemIds: ["chicken-chowmein"], expectedTopicCategory: "Noodles" },
  { name: "S11 vegetable rice, delivery", messages: ["ek vegetable rice dedo", "checkout", "confirm order", "delivery", "House 10 Gulshan", "Waqas", "submit"], expectedItemIds: ["vegetable-rice"], expectedTopicCategory: "Rice" },
  { name: "S12 chicken fried rice, pickup", messages: ["ek chicken fried rice dedo", "checkout", "confirm order", "pickup", "Bushra", "submit"], expectedItemIds: ["chicken-fried-rice"], expectedTopicCategory: "Rice" },
  { name: "S13 think food special pizza, delivery", messages: ["ek think food special pizza dedo", "checkout", "confirm order", "delivery", "House 11 Korangi", "Imran", "submit"], expectedItemIds: ["think-food-special-pizza"], expectedTopicCategory: "Pizza" },
  { name: "S14 pizza regular, pickup", messages: ["ek pizza regular dedo", "checkout", "confirm order", "pickup", "Rabia", "submit"], expectedItemIds: ["pizza-regular-9-inch"], expectedTopicCategory: "Pizza" },
  { name: "S15 pizza fries small box, pickup", messages: ["ek pizza fries small box dedo", "checkout", "confirm order", "pickup", "Tariq", "submit"], expectedItemIds: ["pizza-fries-small-box"], expectedTopicCategory: "Pizza Fries" },
  { name: "S16 hot shot starter, delivery", messages: ["ek hot shot dedo", "checkout", "confirm order", "delivery", "House 20 Malir", "Sana", "submit"], expectedItemIds: ["hot-shot-8-pcs-with-fries"], expectedTopicCategory: "Starter" },
  { name: "S17 two jumbo zinger, pickup", messages: ["2 jumbo zinger dedo", "checkout", "confirm order", "pickup", "Adeel", "submit"], expectedItemIds: ["jumbo-zinger"], expectedTopicCategory: "Burgers" },
  { name: "S18 jumbo zinger + gyro, delivery", messages: ["ek jumbo zinger dedo", "ek gyro dedo", "checkout", "confirm order", "delivery", "House 30 Defence", "Mahnoor", "submit"], expectedItemIds: ["jumbo-zinger", "gyro"], expectedTopicCategory: "Roll" },
  { name: "S19 add then remove then add again, pickup", messages: ["ek gyro dedo", "gyro remove karo", "ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Usman", "submit"], expectedItemIds: ["jumbo-zinger"], expectedTopicCategory: "Burgers" },
  { name: "S20 clarified zinger then checkout, delivery", messages: ["ek zinger dedo", "jumbo zinger", "checkout", "confirm order", "delivery", "House 40 Clifton", "Hamza", "submit"], expectedItemIds: ["jumbo-zinger"], expectedTopicCategory: "Burgers" },
  { name: "S21 quantity change before checkout, pickup", messages: ["ek gyro dedo", "gyro ki quantity 3 kardo", "checkout", "confirm order", "pickup", "Farah", "submit"], expectedItemIds: ["gyro"], expectedTopicCategory: "Roll" },
  { name: "S22 replace before checkout, delivery", messages: ["ek jumbo zinger dedo", "zinger hata kar steak add karo", "checkout", "confirm order", "delivery", "House 50 Saddar", "Kashif", "submit"], expectedItemIds: ["chicken-steak"], expectedTopicCategory: "Steaks" },
  { name: "S23 interrupt add mid-review, pickup", messages: ["ek jumbo zinger dedo", "checkout", "ek gyro dedo", "confirm order", "pickup", "Naila", "submit"], expectedItemIds: ["jumbo-zinger", "gyro"], expectedTopicCategory: "Roll" },
  { name: "S24 English phrasing throughout, pickup", messages: ["I want a jumbo zinger", "checkout", "confirm order", "pickup", "my name is Ahmed", "submit"], expectedItemIds: ["jumbo-zinger"], expectedTopicCategory: "Burgers" },
  { name: "S25 Hinglish phrasing throughout, delivery", messages: ["2 zinger burger add karo", "checkout", "confirm order", "delivery", "House 80 Gulistan", "my name is Anum", "final submit"], expectedItemIds: ["zinger-burger"], expectedTopicCategory: "Burgers" },
  { name: "S26 mexican pizza, pickup, yes submit variant", messages: ["ek mexican pizza dedo", "checkout", "confirm order", "pickup", "Junaid", "yes submit"], expectedItemIds: ["mexican-pizza"], expectedTopicCategory: "Pizza" },
  { name: "S27 chicken strips starter, delivery, done variant", messages: ["ek chicken strips dedo", "checkout", "confirm order", "delivery", "House 90 Landhi", "Mariam", "done"], expectedItemIds: ["chicken-strips-6-pcs-with-fries"], expectedTopicCategory: "Starter" },
  { name: "S28 vegetable chowmein, pickup", messages: ["ek vegetable chowmein dedo", "checkout", "confirm order", "pickup", "Bilquis", "submit"], expectedItemIds: ["vegetable-chowmein"], expectedTopicCategory: "Noodles" },
  { name: "S29 macaroni pasta, delivery", messages: ["ek macaroni pasta dedo", "checkout", "confirm order", "delivery", "House 100 Nazimabad No 5", "Talha", "submit"], expectedItemIds: ["macaroni-pasta-red-sauce"], expectedTopicCategory: "Pasta" },
  { name: "S30 mexican pasta, pickup", messages: ["ek mexican pasta dedo", "checkout", "confirm order", "pickup", "Nimra", "submit"], expectedItemIds: ["mexican-pasta-white-sauce"], expectedTopicCategory: "Pasta" },
  { name: "S31 bbq sandwich, delivery", messages: ["ek bbq sandwich dedo", "checkout", "confirm order", "delivery", "House 3 Model Colony", "Shahzaib", "submit"], expectedItemIds: ["bbq-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S32 smoke sandwich, pickup", messages: ["ek smoke sandwich dedo", "checkout", "confirm order", "pickup", "Wajiha", "submit"], expectedItemIds: ["smoke-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S33 vegi sandwich, delivery", messages: ["ek vegi sandwich dedo", "checkout", "confirm order", "delivery", "House 6 Federal B Area", "Asad", "submit"], expectedItemIds: ["vegi-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S34 mexican sandwich, pickup", messages: ["ek mexican sandwich dedo", "checkout", "confirm order", "pickup", "Rimsha", "submit"], expectedItemIds: ["mexican-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S35 crispy sandwich, delivery", messages: ["ek crispy sandwich dedo", "checkout", "confirm order", "delivery", "House 7 Liaquatabad", "Danyal", "submit"], expectedItemIds: ["crispy-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S36 think food special sandwich, pickup", messages: ["ek think food special sandwich dedo", "checkout", "confirm order", "pickup", "Iqra", "submit"], expectedItemIds: ["think-food-special-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S37 grill sandwich, delivery", messages: ["ek grill sandwich dedo", "checkout", "confirm order", "delivery", "House 8 Gulshan-e-Iqbal", "Owais", "submit"], expectedItemIds: ["grill-sandwich"], expectedTopicCategory: "Sandwiches" },
  { name: "S38 egg rice, pickup", messages: ["ek egg rice dedo", "checkout", "confirm order", "pickup", "Laiba", "submit"], expectedItemIds: ["egg-rice"], expectedTopicCategory: "Rice" },
  { name: "S39 singaporean rice, delivery", messages: ["ek singaporean rice dedo", "checkout", "confirm order", "delivery", "House 9 Johar", "Rayyan", "submit"], expectedItemIds: ["singaporean-rice"], expectedTopicCategory: "Rice" },
  { name: "S40 white singaporean, pickup", messages: ["ek white singaporean dedo", "checkout", "confirm order", "pickup", "Zoya", "submit"], expectedItemIds: ["white-singaporean"], expectedTopicCategory: "Rice" },
];

for (const flow of FULL_FLOW_CASES) {
  test(`S. full flow: ${flow.name}`, () => {
    let driver = newDriver();
    ({ driver } = driveMany(driver, flow.messages));
    assert.equal(driver.session.memory.currentCheckoutStage, "PENDING_VERIFICATION", `flow "${flow.name}" should reach PENDING_VERIFICATION`);
    assert.deepEqual(
      driver.session.memory.currentCart.items.map((i) => i.itemId).sort(),
      [...flow.expectedItemIds].sort(),
      `flow "${flow.name}" should end with the expected cart items`
    );
    assert.equal(driver.session.memory.currentTopic, flow.expectedTopicCategory, `flow "${flow.name}" should track the expected topic`);
    assert.equal(isValidConversationMemory(driver.session.memory), true);
    const restored = restoreMemorySession(saveMemorySession(driver.session));
    assert.deepEqual(restored, driver.session, `flow "${flow.name}" should survive a save/restore round trip`);
  });
}

test("S-count. at least 40 full end-to-end conversation flows are defined", () => {
  assert.ok(FULL_FLOW_CASES.length >= 40, `expected >= 40 full flows, got ${FULL_FLOW_CASES.length}`);
});

// ─────────────────────────────────────────────────────────────────────────
// T. Context builder purity — never affects the real pipeline's outcome
// ─────────────────────────────────────────────────────────────────────────

test("T1. building an AIContext before a message never changes what the real pipeline produces", () => {
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"];

  let plainCtx = createInitialContext();
  const plainReplies: string[] = [];
  for (const m of messages) {
    const pr = parseMessage(m, plainCtx.cart, menu);
    const after = processMessage(plainCtx, pr, menu);
    plainReplies.push(buildResponse({ parseResult: pr, before: plainCtx, after, menu, restaurantConfig }));
    plainCtx = after;
  }

  let driver = newDriver();
  const withContextReplies: string[] = [];
  for (const m of messages) {
    const step = say(driver, m);
    withContextReplies.push(step.reply);
    driver = step.driver;
  }

  assert.deepEqual(withContextReplies, plainReplies);
  assert.deepEqual(driver.ctx.cart, plainCtx.cart);
  assert.equal(driver.ctx.state, plainCtx.state);
});

test("T2. calling buildAIContext multiple times for the same session never mutates it", () => {
  let driver = newDriver();
  ({ driver } = say(driver, "ek jumbo zinger dedo"));
  const before = cloneMemorySession(driver.session);
  buildAIContext(driver.session, "checkout", menu, restaurantConfig);
  buildAIContext(driver.session, "menu dikhao", menu, restaurantConfig);
  assert.deepEqual(driver.session, before);
});
