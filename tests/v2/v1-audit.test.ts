// V1-vs-V2 behavioral audit — fixes for two real gaps found by comparing
// V1 (lib/think-food-ai.ts) against V2 turn by turn across every intent
// category (greetings, menu/category requests, add/remove/replace, price,
// unavailable items, checkout, yes/no, complaints, recommendations, help,
// restaurant info, clarification). Every other audited category was
// already at parity or better in V2 (conversation layer + action planner
// phases) — no changes were needed there. Every test drives the REAL
// pipeline. Run with: npx tsx --test tests/v2/v1-audit.test.ts

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
  let conversation = createConversationContext(`audit-${counter}`, `audit-s-${counter}`);
  const logger = new Logger(`audit-s-${counter}`, `audit-${counter}`);
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

const BURGER_NAMES = ["Zinger Burger", "Zinger Burger W/C", "Jumbo Zinger", "Think Food SP Burger", "Smoke Burger", "Spicy Stuff Burger"];
const PIZZA_NAMES = ["Pizza Large 12 inch", "Pizza Regular 9 inch", "Pizza Small 6 inch", "Think Food Special Pizza", "Mexican Pizza"];
const SANDWICH_NAMES = [
  "Chicken Sandwich", "Club Sandwich", "BBQ Sandwich", "Smoke Sandwich", "Vegi Sandwich",
  "Mexican Sandwich", "Crispy Sandwich", "Think Food Special Sandwich", "Grill Sandwich",
];
const FRIES_NAMES = ["Pizza Fries Small Box", "Pizza Fries Large Box", "Chicken Strips 6 pcs with fries", "Hot Shot 8 pcs with fries"];
const PASTA_NAMES = ["Pasta Small", "Pasta Large", "Alfredo Pasta white sauce", "Macaroni Pasta red sauce", "Mexican Pasta white sauce"];
const CHOWMEIN_NAMES = ["Chicken Chowmein", "Vegetable Chowmein"];

function assertShowsOnly(reply: string, expectedNames: string[], forbiddenNames: string[]) {
  for (const name of expectedNames) {
    assert.match(reply, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing "${name}"`);
  }
  for (const name of forbiddenNames) {
    assert.doesNotMatch(reply, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `unexpectedly contains "${name}"`);
  }
}

// ─── Category requests must show ONLY that category ─────────────────────────

test("'mujhe burgers dikhao' shows only Burgers, never the full menu", async () => {
  const { conversation, result } = await drive(["mujhe burgers dikhao"]);
  assertShowsOnly(result.reply, BURGER_NAMES, [...PIZZA_NAMES, ...SANDWICH_NAMES]);
  assert.doesNotMatch(result.reply, /Hamara Menu:/);
  assert.deepEqual(cartOf(conversation), []);
});

test("'burger menu' shows only Burgers", async () => {
  const { conversation, result } = await drive(["burger menu"]);
  assertShowsOnly(result.reply, BURGER_NAMES, [...PIZZA_NAMES, ...SANDWICH_NAMES]);
  assert.doesNotMatch(result.reply, /Hamara Menu:/);
  assert.deepEqual(cartOf(conversation), []);
});

test("'burgers dikhao' shows only Burgers", async () => {
  const { result } = await drive(["burgers dikhao"]);
  assertShowsOnly(result.reply, BURGER_NAMES, [...PIZZA_NAMES, ...SANDWICH_NAMES]);
});

test("'pizza menu' shows only Pizza", async () => {
  const { conversation, result } = await drive(["pizza menu"]);
  assertShowsOnly(result.reply, PIZZA_NAMES, [...BURGER_NAMES, ...SANDWICH_NAMES]);
  assert.deepEqual(cartOf(conversation), []);
});

test("'pizza dikhao' shows only Pizza", async () => {
  const { result } = await drive(["pizza dikhao"]);
  assertShowsOnly(result.reply, PIZZA_NAMES, [...BURGER_NAMES, ...SANDWICH_NAMES]);
});

test("'sandwich menu' shows only Sandwiches", async () => {
  const { conversation, result } = await drive(["sandwich menu"]);
  assertShowsOnly(result.reply, SANDWICH_NAMES, [...BURGER_NAMES, ...PIZZA_NAMES]);
  assert.deepEqual(cartOf(conversation), []);
});

test("'sandwich dikhao' shows only Sandwiches", async () => {
  const { result } = await drive(["sandwich dikhao"]);
  assertShowsOnly(result.reply, SANDWICH_NAMES, [...BURGER_NAMES, ...PIZZA_NAMES]);
});

test("'fries menu' shows only the Pizza Fries / fries items", async () => {
  const { conversation, result } = await drive(["fries menu"]);
  assertShowsOnly(result.reply, FRIES_NAMES, [...BURGER_NAMES, ...SANDWICH_NAMES]);
  assert.deepEqual(cartOf(conversation), []);
});

test("'pasta menu' shows only Pasta", async () => {
  const { conversation, result } = await drive(["pasta menu"]);
  assertShowsOnly(result.reply, PASTA_NAMES, [...BURGER_NAMES, ...PIZZA_NAMES]);
  assert.deepEqual(cartOf(conversation), []);
});

test("'chowmein menu' shows only the Noodles category", async () => {
  const { result } = await drive(["chowmein menu"]);
  assertShowsOnly(result.reply, CHOWMEIN_NAMES, [...BURGER_NAMES, ...PIZZA_NAMES]);
});

// ─── Never show full menu unless explicitly asked ───────────────────────────

test("'full menu' shows the WHOLE menu (every category)", async () => {
  const { conversation, result } = await drive(["full menu"]);
  assert.match(result.reply, /Hamara Menu:/);
  for (const category of menu.categories) assert.match(result.reply, new RegExp(category.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(cartOf(conversation), []);
});

test("'complete menu' shows the WHOLE menu", async () => {
  const { result } = await drive(["complete menu"]);
  assert.match(result.reply, /Hamara Menu:/);
  assert.match(result.reply, /Burgers/);
  assert.match(result.reply, /Sandwiches/);
});

test("'sab menu' shows the WHOLE menu", async () => {
  const { result } = await drive(["sab menu"]);
  assert.match(result.reply, /Hamara Menu:/);
});

test("'poora menu' shows the WHOLE menu", async () => {
  const { result } = await drive(["poora menu"]);
  assert.match(result.reply, /Hamara Menu:/);
});

test("bare 'menu' (no intensifier) still shows the whole menu — unaffected by the fix", async () => {
  const { result } = await drive(["menu"]);
  assert.match(result.reply, /Hamara Menu:/);
});

// ─── Show vs Add: dikhao/batao/menu/options/available never mutate cart ────

test("'burger' should NOT add — bare category name only browses", async () => {
  const { conversation, result } = await drive(["burger"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.doesNotMatch(result.reply, /add kar diye gaye hain/);
  assertShowsOnly(result.reply, BURGER_NAMES, []);
});

test("'burger order' should engage the ordering pathway (ambiguous -> clarification), not reject as unavailable", async () => {
  const { conversation, result } = await drive(["burger order karo"]);
  assert.deepEqual(cartOf(conversation), []); // ambiguous — correctly asks, never guesses
  assert.equal(conversation.order.state, "AWAITING_CLARIFICATION");
  assert.doesNotMatch(result.reply, /maujood nahi hai/); // must not be misread as "unavailable"
  assert.match(result.reply, /kaunsa/i);
});

test("an exact, unambiguous order phrase DOES add (contrast case for the 'order' word fix)", async () => {
  const { conversation } = await drive(["2 Zinger Burger order karo"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

test("'burger price' should NOT add — a price question never mutates the cart even when the item is ambiguous", async () => {
  const { conversation, result } = await drive(["burger price kya hai"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.doesNotMatch(result.reply, /add kar diye gaye hain/);
});

test("every show-word variant (dikhao/batao/menu/options/available) never adds, across every category", async () => {
  for (const msg of [
    "burgers dikhao", "pizza batao", "sandwich menu", "pasta options", "fries available hai",
    "zinger dikhao", "steak batao",
  ]) {
    const { conversation } = await drive([msg]);
    assert.deepEqual(cartOf(conversation), [], `"${msg}" mutated the cart`);
  }
});

// ─── Only explicit ordering phrases mutate the cart ─────────────────────────

test("explicit ordering phrases DO add — contrast against the show-words above", async () => {
  for (const [msg, itemId] of [
    ["2 Zinger Burger add karo", "zinger-burger"],
    ["ek Gyro dedo", "gyro"],
    ["Chicken Steak chahiye", "chicken-steak"],
  ] as const) {
    const { conversation } = await drive([msg]);
    assert.ok(cartOf(conversation).some(([id]) => id === itemId), `"${msg}" should have added ${itemId}`);
  }
});
