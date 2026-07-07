// V2 cart engine tests — the deterministic execution layer. All 50+ tests
// exercise concrete resolved itemIds directly (never free text): this
// engine never interprets language, it only executes structured intents.
// Run with:
//   npx tsx --test tests/v2/cart-engine.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { ParsedAction, ParseResult } from "../../v2/types/parser";
import { addItem, addMultipleItems } from "../../v2/cart-engine/add";
import { removeItem } from "../../v2/cart-engine/remove";
import { replaceItem } from "../../v2/cart-engine/replace";
import { setQuantity, increaseQuantity, decreaseQuantity } from "../../v2/cart-engine/quantity";
import { clearCart } from "../../v2/cart-engine/clear";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { validateCart, findDuplicateItemIds } from "../../v2/cart-engine/validate";
import { recordHistory, appendHistory } from "../../v2/cart-engine/history";
import { executeAction, executeParseResult, showCart } from "../../v2/cart-engine/index";

const menu = menuData as Menu;
const emptyCart: CartState = { items: [] };

function cartOf(...lines: { itemId: string; name: string; price: number; qty: number }[]): CartState {
  return { items: lines };
}

function line(itemId: string, qty: number) {
  const menuItem = menu.categories.flatMap((c) => c.items).find((i) => i.id === itemId)!;
  return { itemId, name: menuItem.name, price: menuItem.price, qty };
}

function snapshot(cart: CartState): CartState {
  return JSON.parse(JSON.stringify(cart));
}

// ─── Add: single ─────────────────────────────────────────────────────────────

test("add: single item into an empty cart", () => {
  const result = addItem(emptyCart, "zinger-burger", menu, 1);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, 1);
  assert.deepEqual(result.cart.items[0], { itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 1 });
});

test("add: quantity defaults to 1 when omitted", () => {
  const result = addItem(emptyCart, "gyro", menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items[0].qty, 1);
});

test("add: explicit quantity greater than 1", () => {
  const result = addItem(emptyCart, "pasta-small", menu, 5);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items[0].qty, 5);
});

test("add: unknown itemId is rejected, cart unchanged", () => {
  const result = addItem(emptyCart, "not-a-real-item", menu, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, emptyCart);
});

test("add: adding the same item twice merges into one line (duplicate prevention)", () => {
  const step1 = addItem(emptyCart, "zinger-burger", menu, 1);
  const step2 = addItem(step1.cart, "zinger-burger", menu, 2);
  assert.equal(step2.cart.items.length, 1);
  assert.equal(step2.cart.items[0].qty, 3);
});

// ─── Add: multiple / mixed categories ────────────────────────────────────────

test("add: multiple items in one call", () => {
  const result = addMultipleItems(emptyCart, [
    { itemId: "pasta-small", qty: 2 },
    { itemId: "pasta-large", qty: 1 },
  ], menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, 2);
  assert.equal(result.cart.items[0].qty, 2);
  assert.equal(result.cart.items[1].qty, 1);
});

test("add: mixed categories in one call (burger + pizza + rice)", () => {
  const result = addMultipleItems(emptyCart, [
    { itemId: "zinger-burger", qty: 1 },
    { itemId: "pizza-large-12-inch", qty: 1 },
    { itemId: "chicken-fried-rice", qty: 2 },
  ], menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, 3);
  assert.equal(result.cart.items.map((i) => i.itemId).join(","), "zinger-burger,pizza-large-12-inch,chicken-fried-rice");
});

test("add: multiple items is atomic — one invalid id rejects the whole batch, original cart untouched", () => {
  const cart = cartOf(line("gyro", 1));
  const result = addMultipleItems(cart, [
    { itemId: "pasta-small", qty: 1 },
    { itemId: "does-not-exist", qty: 1 },
  ], menu);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

// ─── Remove ───────────────────────────────────────────────────────────────────

test("remove: existing item is removed, others untouched", () => {
  const cart = cartOf(line("pizza-regular-9-inch", 1), line("zinger-burger", 1), line("pasta-small", 1));
  const result = removeItem(cart, "zinger-burger");
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, 2);
  assert.deepEqual(result.cart.items.map((i) => i.itemId), ["pizza-regular-9-inch", "pasta-small"]);
});

test("remove: missing item -> rejected, cart unchanged", () => {
  const cart = cartOf(line("pizza-regular-9-inch", 1));
  const result = removeItem(cart, "grill-sandwich");
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("remove: never removes an unrelated item when the requested one exists", () => {
  const cart = cartOf(line("pizza-regular-9-inch", 1), line("zinger-burger", 1));
  const result = removeItem(cart, "zinger-burger");
  assert.equal(result.cart.items.some((i) => i.itemId === "pizza-regular-9-inch"), true);
});

test("remove: from a single-item cart empties it", () => {
  const cart = cartOf(line("gyro", 1));
  const result = removeItem(cart, "gyro");
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items, []);
});

// ─── Replace ──────────────────────────────────────────────────────────────────

test("replace: existing source + existing target, in place, per the spec's Pizza/Pasta/Burger->Steak example", () => {
  const cart = cartOf(line("pizza-regular-9-inch", 1), line("pasta-small", 1), line("zinger-burger", 1));
  const result = replaceItem(cart, "zinger-burger", "chicken-steak", menu);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items.map((i) => i.itemId), ["pizza-regular-9-inch", "pasta-small", "chicken-steak"]);
  assert.equal(result.cart.items[2].qty, 1);
});

test("replace: missing source -> rejected, cart unchanged", () => {
  const cart = cartOf(line("pizza-regular-9-inch", 1));
  const result = replaceItem(cart, "zinger-burger", "chicken-steak", menu);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("replace: unavailable target -> rejected, cart unchanged", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = replaceItem(cart, "zinger-burger", "not-a-real-item", menu);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("replace: preserves the replaced item's quantity", () => {
  const cart = cartOf(line("zinger-burger", 4));
  const result = replaceItem(cart, "zinger-burger", "chicken-steak", menu);
  assert.equal(result.cart.items[0].qty, 4);
});

test("replace: target already has its own line -> merges quantities instead of duplicating", () => {
  const cart = cartOf(line("zinger-burger", 2), line("chicken-steak", 1));
  const result = replaceItem(cart, "zinger-burger", "chicken-steak", menu);
  assert.equal(result.cart.items.length, 1);
  assert.equal(result.cart.items[0].itemId, "chicken-steak");
  assert.equal(result.cart.items[0].qty, 3);
});

// ─── Quantity: set / increase / decrease ─────────────────────────────────────

test("quantity: set to an explicit value", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = setQuantity(cart, "zinger-burger", 5);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items[0].qty, 5);
});

test("quantity: set on an item not in the cart -> rejected", () => {
  const result = setQuantity(emptyCart, "zinger-burger", 5);
  assert.equal(result.ok, false);
});

test("quantity: increase by default (1)", () => {
  const cart = cartOf(line("zinger-burger", 2));
  const result = increaseQuantity(cart, "zinger-burger");
  assert.equal(result.cart.items[0].qty, 3);
});

test("quantity: increase by explicit amount", () => {
  const cart = cartOf(line("zinger-burger", 2));
  const result = increaseQuantity(cart, "zinger-burger", 5);
  assert.equal(result.cart.items[0].qty, 7);
});

test("quantity: decrease by default (1)", () => {
  const cart = cartOf(line("zinger-burger", 3));
  const result = decreaseQuantity(cart, "zinger-burger");
  assert.equal(result.cart.items[0].qty, 2);
});

test("quantity: decrease by explicit amount", () => {
  const cart = cartOf(line("zinger-burger", 5));
  const result = decreaseQuantity(cart, "zinger-burger", 3);
  assert.equal(result.cart.items[0].qty, 2);
});

test("quantity: set to zero is rejected", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = setQuantity(cart, "zinger-burger", 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("quantity: set to a negative number is rejected", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = setQuantity(cart, "zinger-burger", -2);
  assert.equal(result.ok, false);
});

test("quantity: decreasing to zero is rejected rather than auto-removing", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = decreaseQuantity(cart, "zinger-burger", 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("quantity: decreasing below zero is rejected", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = decreaseQuantity(cart, "zinger-burger", 5);
  assert.equal(result.ok, false);
});

test("quantity: non-integer quantity is rejected", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const result = setQuantity(cart, "zinger-burger", 1.5);
  assert.equal(result.ok, false);
});

// ─── Clear ────────────────────────────────────────────────────────────────────

test("clear: non-empty cart becomes empty", () => {
  const cart = cartOf(line("zinger-burger", 1), line("pasta-small", 2));
  const result = clearCart(cart);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items, []);
});

test("clear: already-empty cart is a no-op success", () => {
  const result = clearCart(emptyCart);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items, []);
});

// ─── Totals ───────────────────────────────────────────────────────────────────

test("totals: empty cart totals to zero", () => {
  const totals = calculateTotal(emptyCart, menu);
  assert.deepEqual(totals, { subtotal: 0, itemCount: 0, lineCount: 0 });
});

test("totals: single line total", () => {
  const cart = cartOf(line("zinger-burger", 2)); // 500 * 2
  const totals = calculateTotal(cart, menu);
  assert.equal(totals.subtotal, 1000);
  assert.equal(totals.itemCount, 2);
  assert.equal(totals.lineCount, 1);
});

test("totals: multi-line total sums every line by menu price, not cached line price", () => {
  const cart: CartState = {
    items: [
      { itemId: "zinger-burger", name: "Zinger Burger", price: 999999, qty: 2 }, // tampered/stale price
      { itemId: "pasta-small", name: "Pasta Small", price: 500, qty: 3 },
    ],
  };
  const totals = calculateTotal(cart, menu);
  // Must use the REAL menu prices (500*2 + 500*3), never the tampered 999999.
  assert.equal(totals.subtotal, 500 * 2 + 500 * 3);
  assert.equal(totals.itemCount, 5);
  assert.equal(totals.lineCount, 2);
});

test("totals: unknown itemId contributes zero rather than throwing", () => {
  const cart: CartState = { items: [{ itemId: "ghost-item", name: "Ghost", price: 100, qty: 1 }] };
  const totals = calculateTotal(cart, menu);
  assert.equal(totals.subtotal, 0);
});

// ─── Validation ───────────────────────────────────────────────────────────────

test("validate: a clean cart is valid", () => {
  const cart = cartOf(line("zinger-burger", 1), line("pasta-small", 2));
  const result = validateCart(cart, menu);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("validate: unknown itemId flagged as ITEM_NOT_FOUND", () => {
  const cart: CartState = { items: [{ itemId: "ghost-item", name: "Ghost", price: 100, qty: 1 }] };
  const result = validateCart(cart, menu);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("ITEM_NOT_FOUND"));
});

test("validate: invalid quantity flagged as INVALID_QUANTITY", () => {
  const cart: CartState = { items: [{ itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 0 }] };
  const result = validateCart(cart, menu);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("INVALID_QUANTITY"));
});

test("validate: duplicate itemIds on separate lines flagged as DUPLICATE_ITEM_IDS", () => {
  const cart: CartState = {
    items: [
      { itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 1 },
      { itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 2 },
    ],
  };
  const result = validateCart(cart, menu);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("DUPLICATE_ITEM_IDS"));
  assert.deepEqual(findDuplicateItemIds(cart), ["zinger-burger"]);
});

test("validate: empty cart is valid", () => {
  const result = validateCart(emptyCart, menu);
  assert.equal(result.valid, true);
});

// ─── Immutability ─────────────────────────────────────────────────────────────

test("immutable: addItem never mutates the original cart object", () => {
  const cart = cartOf(line("gyro", 1));
  const before = snapshot(cart);
  addItem(cart, "zinger-burger", menu, 1);
  assert.deepEqual(cart, before);
});

test("immutable: removeItem never mutates the original cart object", () => {
  const cart = cartOf(line("gyro", 1), line("zinger-burger", 1));
  const before = snapshot(cart);
  removeItem(cart, "zinger-burger");
  assert.deepEqual(cart, before);
});

test("immutable: replaceItem never mutates the original cart object", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const before = snapshot(cart);
  replaceItem(cart, "zinger-burger", "chicken-steak", menu);
  assert.deepEqual(cart, before);
});

test("immutable: setQuantity never mutates the original cart object", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const before = snapshot(cart);
  setQuantity(cart, "zinger-burger", 9);
  assert.deepEqual(cart, before);
});

test("immutable: clearCart never mutates the original cart object", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const before = snapshot(cart);
  clearCart(cart);
  assert.deepEqual(cart, before);
});

test("immutable: successive operations return distinct cart objects (no shared references)", () => {
  const cart = cartOf(line("gyro", 1));
  const afterAdd = addItem(cart, "zinger-burger", menu, 1).cart;
  assert.notEqual(afterAdd, cart);
  assert.notEqual(afterAdd.items, cart.items);
});

// ─── History ──────────────────────────────────────────────────────────────────

test("history: recordHistory captures before, after, action, and a timestamp", () => {
  const before = cartOf(line("gyro", 1));
  const after = addItem(before, "zinger-burger", menu, 1).cart;
  const entry = recordHistory(before, after, "ADD_ITEM");
  assert.deepEqual(entry.before, before);
  assert.deepEqual(entry.after, after);
  assert.equal(entry.action, "ADD_ITEM");
  assert.equal(Number.isNaN(Date.parse(entry.timestamp)), false);
});

test("history: recordHistory accepts an injectable clock for deterministic tests", () => {
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  const entry = recordHistory(emptyCart, emptyCart, "REMOVE_ALL", () => fixed);
  assert.equal(entry.timestamp, fixed.toISOString());
});

test("history: appendHistory immutably grows the log", () => {
  const entry1 = recordHistory(emptyCart, emptyCart, "ADD_ITEM", () => new Date(0));
  const log1 = appendHistory([], entry1);
  const entry2 = recordHistory(emptyCart, emptyCart, "REMOVE_ALL", () => new Date(1));
  const log2 = appendHistory(log1, entry2);
  assert.equal(log1.length, 1);
  assert.equal(log2.length, 2);
  assert.notEqual(log1, log2);
});

test("history: executeAction returns one history entry per successful mutation", () => {
  const action: ParsedAction = { action: "ADD_ITEM", items: [{ query: "gyro", quantity: 1, candidateItemIds: ["gyro"] }] };
  const result = executeAction(action, emptyCart, menu);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].action, "ADD_ITEM");
  assert.deepEqual(result.history[0].before, emptyCart);
  assert.deepEqual(result.history[0].after, result.cart);
});

test("history: a rejected executeAction call records no history", () => {
  const action: ParsedAction = { action: "REMOVE_ITEM", items: [{ query: "gyro", candidateItemIds: ["gyro"] }] };
  const result = executeAction(action, emptyCart, menu);
  assert.equal(result.ok, false);
  assert.equal(result.history.length, 0);
});

// ─── Large carts / empty cart / edge quantities ──────────────────────────────

test("large carts: adding every menu item once succeeds and totals correctly", () => {
  const allItems = menu.categories.flatMap((c) => c.items);
  const entries = allItems.map((i) => ({ itemId: i.id, qty: 1 }));
  const result = addMultipleItems(emptyCart, entries, menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, allItems.length);
  const totals = calculateTotal(result.cart, menu);
  const expectedTotal = allItems.reduce((sum, i) => sum + i.price, 0);
  assert.equal(totals.subtotal, expectedTotal);
  assert.equal(totals.lineCount, allItems.length);
});

test("large carts: removing one item out of every-menu-item cart only removes that one", () => {
  const allItems = menu.categories.flatMap((c) => c.items);
  const full = addMultipleItems(emptyCart, allItems.map((i) => ({ itemId: i.id, qty: 1 })), menu).cart;
  const result = removeItem(full, "gyro");
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, allItems.length - 1);
  assert.equal(result.cart.items.some((i) => i.itemId === "gyro"), false);
});

test("large carts: high quantity on a single item", () => {
  const result = addItem(emptyCart, "pasta-small", menu, 500);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items[0].qty, 500);
  assert.equal(calculateTotal(result.cart, menu).subtotal, 500 * 500);
});

test("empty cart: showCart on an empty cart returns it unchanged", () => {
  assert.deepEqual(showCart(emptyCart), emptyCart);
});

test("empty cart: removeItem on an empty cart is rejected", () => {
  const result = removeItem(emptyCart, "gyro");
  assert.equal(result.ok, false);
});

test("empty cart: replaceItem on an empty cart is rejected (nothing to replace)", () => {
  const result = replaceItem(emptyCart, "gyro", "wrap", menu);
  assert.equal(result.ok, false);
});

test("empty cart: setQuantity on an empty cart is rejected", () => {
  const result = setQuantity(emptyCart, "gyro", 3);
  assert.equal(result.ok, false);
});

test("edge quantity: fractional quantity rejected on add", () => {
  const result = addItem(emptyCart, "gyro", menu, 1.5);
  assert.equal(result.ok, false);
});

test("edge quantity: negative quantity rejected on add", () => {
  const result = addItem(emptyCart, "gyro", menu, -1);
  assert.equal(result.ok, false);
});

test("edge quantity: zero quantity rejected on add", () => {
  const result = addItem(emptyCart, "gyro", menu, 0);
  assert.equal(result.ok, false);
});

test("edge quantity: NaN quantity rejected on add", () => {
  const result = addItem(emptyCart, "gyro", menu, NaN);
  assert.equal(result.ok, false);
});

// ─── Orchestrator: executeAction / executeParseResult ────────────────────────

test("orchestrator: executeAction dispatches ADD_MULTIPLE_ITEMS", () => {
  const action: ParsedAction = {
    action: "ADD_MULTIPLE_ITEMS",
    items: [
      { query: "small", quantity: 2, candidateItemIds: ["pasta-small"] },
      { query: "large", quantity: 2, candidateItemIds: ["pasta-large"] },
      { query: "alfredo", quantity: 1, candidateItemIds: ["alfredo-pasta-white-sauce"] },
    ],
  };
  const result = executeAction(action, emptyCart, menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items.length, 3);
  assert.equal(result.totals.subtotal, 500 * 2 + 600 * 2 + 850 * 1);
});

test("orchestrator: executeAction rejects ADD_ITEM with an ambiguous (2+) candidate list", () => {
  const action: ParsedAction = { action: "ADD_ITEM", items: [{ query: "zinger", quantity: 1, candidateItemIds: ["zinger-burger", "jumbo-zinger"] }] };
  const result = executeAction(action, emptyCart, menu);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, emptyCart);
});

test("orchestrator: executeAction rejects ADD_ITEM with zero candidates (unavailable)", () => {
  const action: ParsedAction = { action: "ADD_ITEM", items: [{ query: "beef burger", quantity: 1, candidateItemIds: [] }] };
  const result = executeAction(action, emptyCart, menu);
  assert.equal(result.ok, false);
});

test("orchestrator: executeAction dispatches REPLACE_ITEM from a ParsedAction.replace", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const action: ParsedAction = {
    action: "REPLACE_ITEM",
    replace: {
      sourceQuery: "zinger", targetQuery: "steak",
      sourceCandidateItemIds: ["zinger-burger"], targetCandidateItemIds: ["chicken-steak"],
    },
  };
  const result = executeAction(action, cart, menu);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items.map((i) => i.itemId), ["chicken-steak"]);
});

test("orchestrator: executeAction dispatches CHANGE_QUANTITY", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const action: ParsedAction = { action: "CHANGE_QUANTITY", items: [{ query: "zinger burger", quantity: 4, candidateItemIds: ["zinger-burger"] }] };
  const result = executeAction(action, cart, menu);
  assert.equal(result.ok, true);
  assert.equal(result.cart.items[0].qty, 4);
});

test("orchestrator: executeParseResult refuses to mutate when safetyDecision isn't SAFE_TO_EXECUTE", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const parseResult: ParseResult = {
    intent: "ADD_ITEM",
    confidence: 0.9,
    items: [{ query: "pasta", quantity: 5, candidateItemIds: ["pasta-small", "pasta-large"] }],
    actions: [{ action: "ADD_ITEM", items: [{ query: "pasta", quantity: 5, candidateItemIds: ["pasta-small", "pasta-large"] }] }],
    needsClarification: true,
    safetyDecision: "ASK_CLARIFICATION",
    rawUserMessage: "5 pasta",
    normalizedMessage: "5 pasta",
  };
  const result = executeParseResult(parseResult, cart, menu);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cart, cart);
});

test("orchestrator: executeParseResult with no actions is a safe no-op", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const parseResult: ParseResult = {
    intent: "SHOW_MENU",
    confidence: 0.95,
    items: [],
    actions: [],
    needsClarification: false,
    safetyDecision: "NO_CART_ACTION",
    rawUserMessage: "menu dikhao",
    normalizedMessage: "menu dikhao",
  };
  const result = executeParseResult(parseResult, cart, menu);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart, cart);
});

test("orchestrator: executeParseResult applies a compound REMOVE_ALL + ADD_ITEM in sequence", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const parseResult: ParseResult = {
    intent: "REMOVE_ALL",
    confidence: 0.9,
    items: [{ query: "large pizza", quantity: 1, candidateItemIds: ["pizza-large-12-inch"] }],
    actions: [
      { action: "REMOVE_ALL" },
      { action: "ADD_ITEM", items: [{ query: "large pizza", quantity: 1, candidateItemIds: ["pizza-large-12-inch"] }] },
    ],
    needsClarification: false,
    safetyDecision: "SAFE_TO_EXECUTE",
    rawUserMessage: "remove everything and add 1 large pizza",
    normalizedMessage: "remove everything and add 1 large pizza",
  };
  const result = executeParseResult(parseResult, cart, menu);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cart.items.map((i) => i.itemId), ["pizza-large-12-inch"]);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].action, "REMOVE_ALL");
  assert.equal(result.history[1].action, "ADD_ITEM");
});

test("orchestrator: executeParseResult never mutates the original cart, even on success", () => {
  const cart = cartOf(line("zinger-burger", 1));
  const before = snapshot(cart);
  const parseResult: ParseResult = {
    intent: "ADD_ITEM",
    confidence: 0.9,
    items: [{ query: "gyro", quantity: 1, candidateItemIds: ["gyro"] }],
    actions: [{ action: "ADD_ITEM", items: [{ query: "gyro", quantity: 1, candidateItemIds: ["gyro"] }] }],
    needsClarification: false,
    safetyDecision: "SAFE_TO_EXECUTE",
    rawUserMessage: "ek gyro krdo",
    normalizedMessage: "ek gyro krdo",
  };
  executeParseResult(parseResult, cart, menu);
  assert.deepEqual(cart, before);
});
