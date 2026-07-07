// V2 intent parser tests. Covers the 20 required scenarios plus a handful
// of bonus cases for the required intents the 20 don't otherwise exercise
// (CHANGE_QUANTITY, SHOW_CART, PRICE_QUERY, HYPOTHETICAL_TOTAL,
// ASK_RESTAURANT_INFO, UNKNOWN, ASK_CLARIFICATION). Run with:
//   npx tsx --test tests/v2/intent-parser.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import { parseMessage } from "../../v2/intent-parser/parser";

const menu = menuData as Menu;
const emptyCart: CartState = { items: [] };

function cartWith(...itemIds: string[]): CartState {
  return {
    items: itemIds.map((itemId) => ({ itemId, name: itemId, price: 0, qty: 1 })),
  };
}

function sorted(ids: string[] | undefined): string[] {
  return [...(ids ?? [])].sort();
}

// 1. ek zinger kardo
test("1. 'ek zinger kardo' -> ADD_ITEM, ambiguous zinger family, ASK_CLARIFICATION", () => {
  const r = parseMessage("ek zinger kardo", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].quantity, 1);
  assert.deepEqual(sorted(r.items[0].candidateItemIds), sorted(["zinger-burger", "zinger-burger-w-c", "jumbo-zinger"]));
  assert.equal(r.needsClarification, true);
  assert.equal(r.safetyDecision, "ASK_CLARIFICATION");
});

// 2. or zinger dikhao
test("2. 'or zinger dikhao' -> SHOW_OPTIONS, NO_CART_ACTION", () => {
  const r = parseMessage("or zinger dikhao", emptyCart, menu);
  assert.equal(r.intent, "SHOW_OPTIONS");
  assert.equal(r.category, "zinger");
  assert.equal(r.actions.length, 0);
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

// 3. 5 pasta
test("3. '5 pasta' -> ADD_ITEM qty 5, ambiguous pasta family, ASK_CLARIFICATION", () => {
  const r = parseMessage("5 pasta", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.equal(r.items[0].quantity, 5);
  assert.equal(r.items[0].candidateItemIds?.length, 5);
  assert.equal(r.needsClarification, true);
  assert.equal(r.safetyDecision, "ASK_CLARIFICATION");
});

// 4. 2 small 2 large 1 alfredo
test("4. '2 small 2 large 1 alfredo' -> ADD_MULTIPLE_ITEMS, anchored to pasta, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("2 small 2 large 1 alfredo", emptyCart, menu);
  assert.equal(r.intent, "ADD_MULTIPLE_ITEMS");
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => ({ qty: i.quantity, ids: i.candidateItemIds })), [
    { qty: 2, ids: ["pasta-small"] },
    { qty: 2, ids: ["pasta-large"] },
    { qty: 1, ids: ["alfredo-pasta-white-sauce"] },
  ]);
  assert.equal(r.needsClarification, false);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 5. remove everything and add 1 large pizza
test("5. 'remove everything and add 1 large pizza' -> compound REMOVE_ALL + ADD_ITEM, SAFE_TO_EXECUTE", () => {
  const cart = cartWith("zinger-burger");
  const r = parseMessage("remove everything and add 1 large pizza", cart, menu);
  assert.equal(r.intent, "REMOVE_ALL");
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].action, "REMOVE_ALL");
  assert.equal(r.actions[1].action, "ADD_ITEM");
  assert.deepEqual(r.actions[1].items?.[0].candidateItemIds, ["pizza-large-12-inch"]);
  assert.equal(r.actions[1].items?.[0].quantity, 1);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 6. sab remove kardo aur ek grill sandwich add kardo
test("6. 'sab remove kardo aur ek grill sandwich add kardo' -> compound REMOVE_ALL + ADD_ITEM, SAFE_TO_EXECUTE", () => {
  const cart = cartWith("zinger-burger");
  const r = parseMessage("sab remove kardo aur ek grill sandwich add kardo", cart, menu);
  assert.equal(r.intent, "REMOVE_ALL");
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[1].action, "ADD_ITEM");
  assert.deepEqual(r.actions[1].items?.[0].candidateItemIds, ["grill-sandwich"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 7. sandwich remove karo (sandwich not in cart)
test("7. 'sandwich remove karo' with no sandwich in cart -> REMOVE_ITEM, REJECT_NOT_IN_CART", () => {
  const cart = cartWith("pizza-regular-9-inch", "zinger-burger", "pasta-small");
  const r = parseMessage("sandwich remove karo", cart, menu);
  assert.equal(r.intent, "REMOVE_ITEM");
  assert.equal(r.items[0].candidateItemIds?.length, 9);
  assert.equal(r.safetyDecision, "REJECT_NOT_IN_CART");
  assert.match(r.clarificationQuestion ?? "", /maujood nahi hai/);
});

// 8. hot shot hata kar steak add karo
test("8. 'hot shot hata kar steak add karo' -> REPLACE_ITEM, SAFE_TO_EXECUTE", () => {
  const cart = cartWith("hot-shot-8-pcs-with-fries");
  const r = parseMessage("hot shot hata kar steak add karo", cart, menu);
  assert.equal(r.intent, "REPLACE_ITEM");
  const replace = r.actions[0].replace;
  assert.equal(replace?.sourceQuery, "hot shot");
  assert.equal(replace?.targetQuery, "steak");
  assert.deepEqual(replace?.sourceCandidateItemIds, ["hot-shot-8-pcs-with-fries"]);
  assert.deepEqual(replace?.targetCandidateItemIds, ["chicken-steak"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 9. steak hata kar hot shot add karo (mirror of 8)
test("9. 'steak hata kar hot shot add karo' -> REPLACE_ITEM, SAFE_TO_EXECUTE", () => {
  const cart = cartWith("chicken-steak");
  const r = parseMessage("steak hata kar hot shot add karo", cart, menu);
  assert.equal(r.intent, "REPLACE_ITEM");
  const replace = r.actions[0].replace;
  assert.equal(replace?.sourceQuery, "steak");
  assert.equal(replace?.targetQuery, "hot shot");
  assert.deepEqual(replace?.sourceCandidateItemIds, ["chicken-steak"]);
  assert.deepEqual(replace?.targetCandidateItemIds, ["hot-shot-8-pcs-with-fries"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 10. confirm order
test("10. 'confirm order' -> CONFIRM_ORDER, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("confirm order", emptyCart, menu);
  assert.equal(r.intent, "CONFIRM_ORDER");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 11. bas yahi hai place kardo
test("11. 'bas yahi hai place kardo' -> CHECKOUT_START, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("bas yahi hai place kardo", emptyCart, menu);
  assert.equal(r.intent, "CHECKOUT_START");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 12. delivery
test("12. 'delivery' -> SELECT_DELIVERY, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("delivery", emptyCart, menu);
  assert.equal(r.intent, "SELECT_DELIVERY");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 13. pickup
test("13. 'pickup' -> SELECT_PICKUP, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("pickup", emptyCart, menu);
  assert.equal(r.intent, "SELECT_PICKUP");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 14. mera naam Fahad hai
test("14. 'mera naam Fahad hai' -> PROVIDE_NAME, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("mera naam Fahad hai", emptyCart, menu);
  assert.equal(r.intent, "PROVIDE_NAME");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 15. House 45 Street 12 Nazimabad Karachi
test("15. 'House 45 Street 12 Nazimabad Karachi' -> PROVIDE_ADDRESS, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("House 45 Street 12 Nazimabad Karachi", emptyCart, menu);
  assert.equal(r.intent, "PROVIDE_ADDRESS");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 16. add one • Gyro — PKR 550
test("16. 'add one • Gyro — PKR 550' -> ADD_ITEM Gyro, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("add one • Gyro — PKR 550", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.deepEqual(r.items[0].candidateItemIds, ["gyro"]);
  assert.equal(r.items[0].quantity, 1);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 17. chicken noodles
test("17. 'chicken noodles' -> ADD_ITEM Chicken Chowmein, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("chicken noodles", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.deepEqual(r.items[0].candidateItemIds, ["chicken-chowmein"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 18. fries menu dikhao
test("18. 'fries menu dikhao' -> SHOW_OPTIONS, NO_CART_ACTION", () => {
  const r = parseMessage("fries menu dikhao", emptyCart, menu);
  assert.equal(r.intent, "SHOW_OPTIONS");
  assert.equal(r.category, "fries");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

// 19. hotshot chahiye
test("19. 'hotshot chahiye' -> ADD_ITEM Hot Shot, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("hotshot chahiye", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.deepEqual(r.items[0].candidateItemIds, ["hot-shot-8-pcs-with-fries"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

// 20. beef burger chahiye
test("20. 'beef burger chahiye' -> ADD_ITEM, REJECT_UNAVAILABLE", () => {
  const r = parseMessage("beef burger chahiye", emptyCart, menu);
  assert.equal(r.intent, "ADD_ITEM");
  assert.equal(r.items[0].candidateItemIds?.length, 0);
  assert.equal(r.safetyDecision, "REJECT_UNAVAILABLE");
});

// ─── Bonus coverage for required intents not exercised by 1-20 ─────────────

test("bonus: 'zinger burger ki quantity 3 kardo' -> CHANGE_QUANTITY, SAFE_TO_EXECUTE", () => {
  const cart = cartWith("zinger-burger");
  const r = parseMessage("zinger burger ki quantity 3 kardo", cart, menu);
  assert.equal(r.intent, "CHANGE_QUANTITY");
  assert.equal(r.items[0].quantity, 3);
  assert.deepEqual(r.items[0].candidateItemIds, ["zinger-burger"]);
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

test("bonus: 'mera cart dikhao' -> SHOW_CART, NO_CART_ACTION", () => {
  const r = parseMessage("mera cart dikhao", emptyCart, menu);
  assert.equal(r.intent, "SHOW_CART");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

test("bonus: 'menu dikhao' with nothing else -> SHOW_MENU, NO_CART_ACTION", () => {
  const r = parseMessage("menu dikhao", emptyCart, menu);
  assert.equal(r.intent, "SHOW_MENU");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

test("bonus: 'zinger burger ka rate kitne ka hai' -> PRICE_QUERY, NO_CART_ACTION", () => {
  const r = parseMessage("zinger burger ka rate kitne ka hai", emptyCart, menu);
  assert.equal(r.intent, "PRICE_QUERY");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

test("bonus: 'agar add karun to total kitna hoga' -> HYPOTHETICAL_TOTAL, NO_CART_ACTION", () => {
  const r = parseMessage("agar add karun to total kitna hoga", emptyCart, menu);
  assert.equal(r.intent, "HYPOTHETICAL_TOTAL");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

test("bonus: 'aapka address kya hai' -> ASK_RESTAURANT_INFO, SAFE_TO_EXECUTE", () => {
  const r = parseMessage("aapka address kya hai", emptyCart, menu);
  assert.equal(r.intent, "ASK_RESTAURANT_INFO");
  assert.equal(r.safetyDecision, "SAFE_TO_EXECUTE");
});

test("bonus: pure gibberish -> UNKNOWN, NO_CART_ACTION, cart untouched", () => {
  const r = parseMessage("asdkjaslkdj qqzz random", emptyCart, menu);
  assert.equal(r.intent, "UNKNOWN");
  assert.equal(r.needsClarification, false);
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
});

test("bonus: 'kuch achha sa chahiye' is now a first-class recommendation request", () => {
  // Conversation-layer upgrade: this used to fall through to a generic
  // ASK_CLARIFICATION; the customer is really asking for a suggestion.
  const r = parseMessage("kuch achha sa chahiye", emptyCart, menu);
  assert.equal(r.intent, "RECOMMENDATION_REQUEST");
  assert.equal(r.safetyDecision, "NO_CART_ACTION");
  assert.equal(r.actions.length, 0);
});

test("bonus: order-ish filler with no resolvable item -> ASK_CLARIFICATION", () => {
  const r = parseMessage("wo wala chahiye", emptyCart, menu);
  assert.equal(r.intent, "ASK_CLARIFICATION");
  assert.equal(r.needsClarification, true);
  assert.equal(r.safetyDecision, "ASK_CLARIFICATION");
});

test("parser never mutates the cart object passed in", () => {
  const cart = cartWith("zinger-burger", "pasta-small");
  const snapshot = JSON.parse(JSON.stringify(cart));
  parseMessage("remove everything and add 1 large pizza", cart, menu);
  parseMessage("sandwich remove karo", cart, menu);
  parseMessage("5 pasta", cart, menu);
  assert.deepEqual(cart, snapshot);
});
