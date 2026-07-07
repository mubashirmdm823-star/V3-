// V2 safety layer tests. Runs directly against evaluateSafety() — the NLU
// intent parser doesn't exist yet, so these construct Intent fixtures by
// hand rather than going through real text parsing. Run with:
//   npx tsx --test tests/v2/safety-layer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { Intent } from "../../v2/types/intent";
import { evaluateSafety } from "../../v2/intent-parser/safety";

const menu = menuData as Menu;

function idsInCategory(key: string): string[] {
  const category = menu.categories.find((c) => c.key === key);
  assert.ok(category, `expected a "${key}" category in v2/data/menu.json`);
  return category!.items.map((i) => i.id);
}

const PASTA_IDS = idsInCategory("pasta");
const SANDWICH_IDS = idsInCategory("sandwiches");
const ZINGER_IDS = ["zinger-burger", "zinger-burger-w-c", "jumbo-zinger"];

const baseCart: CartState = {
  items: [
    { itemId: "pizza-regular-9-inch", name: "Pizza Regular 9 inch", price: 850, qty: 1 },
    { itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 1 },
    { itemId: "pasta-small", name: "Pasta Small", price: 500, qty: 1 },
  ],
};

function cloneCart(cart: CartState): CartState {
  return JSON.parse(JSON.stringify(cart));
}

// 1. "or zinger dikhao" must return NO_CART_ACTION
test("show-intent guard: 'or zinger dikhao' -> NO_CART_ACTION, cart unchanged", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "add_item",
    rawText: "or zinger dikhao",
    confidence: 0.95,
    items: [{ query: "zinger", quantity: 1, candidateItemIds: ZINGER_IDS }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "NO_CART_ACTION");
  assert.deepEqual(cart, baseCart);
});

// 2. "5 pasta" must return ASK_CLARIFICATION
test("ambiguous item: '5 pasta' -> ASK_CLARIFICATION with all pasta options", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "add_item",
    rawText: "5 pasta",
    confidence: 0.9,
    items: [{ query: "pasta", quantity: 5, candidateItemIds: PASTA_IDS }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "ASK_CLARIFICATION");
  assert.equal(result.candidateItems?.length, PASTA_IDS.length);
  assert.match(result.message ?? "", /Aap kaunsa pasta chahenge\?/);
  assert.deepEqual(cart, baseCart);
});

// 3. "sandwich remove karo" when sandwich is not in cart -> REJECT_NOT_IN_CART
test("remove not-in-cart: 'sandwich remove karo' -> REJECT_NOT_IN_CART", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "remove_item",
    rawText: "sandwich remove karo",
    confidence: 0.9,
    items: [{ query: "sandwich", candidateItemIds: SANDWICH_IDS }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "REJECT_NOT_IN_CART");
  assert.match(result.message ?? "", /maujood nahi hai/);
  assert.deepEqual(cart, baseCart);
});

// 4. "beef burger chahiye" must return REJECT_UNAVAILABLE
test("unavailable item: 'beef burger chahiye' -> REJECT_UNAVAILABLE", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "add_item",
    rawText: "beef burger chahiye",
    confidence: 0.9,
    items: [{ query: "beef burger", quantity: 1, candidateItemIds: [] }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "REJECT_UNAVAILABLE");
  assert.deepEqual(cart, baseCart);
});

// 5. low confidence unknown message must not mutate cart
test("low confidence unknown message -> NO_CART_ACTION", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "unknown",
    rawText: "asdkjaslkdj random gibberish",
    confidence: 0.2,
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "NO_CART_ACTION");
  assert.deepEqual(cart, baseCart);
});

// 6. price query must not mutate cart
test("price query: 'zinger ka price kitne ka hai' -> NO_CART_ACTION", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "price_query",
    rawText: "zinger ka rate kitne ka hai",
    confidence: 0.95,
    items: [{ query: "zinger", candidateItemIds: ZINGER_IDS }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "NO_CART_ACTION");
  assert.deepEqual(cart, baseCart);
});

// 7. ambiguous category must ask clarification
test("ambiguous category: bare 'burger' -> ASK_CLARIFICATION", () => {
  const cart = cloneCart(baseCart);
  const burgerIds = idsInCategory("burgers");
  const intent: Intent = {
    type: "add_item",
    rawText: "burger",
    confidence: 0.9,
    items: [{ query: "burger", candidateItemIds: burgerIds }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "ASK_CLARIFICATION");
  assert.deepEqual(cart, baseCart);
});

// 8. exact high confidence item can be SAFE_TO_EXECUTE
test("unambiguous high-confidence add -> SAFE_TO_EXECUTE", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "add_item",
    rawText: "ek jumbo zinger dedo",
    confidence: 0.95,
    items: [{ query: "jumbo zinger", quantity: 1, candidateItemIds: ["jumbo-zinger"] }],
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "SAFE_TO_EXECUTE");
});

// 9. replace with missing source item must reject
test("replace with missing source: sandwich -> pizza (sandwich not in cart) -> REJECT_NOT_IN_CART", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "replace_item",
    rawText: "sandwich ki jagah pizza dedo",
    confidence: 0.9,
    replace: {
      sourceQuery: "sandwich",
      targetQuery: "pizza",
      sourceCandidateItemIds: SANDWICH_IDS,
      targetCandidateItemIds: ["pizza-regular-9-inch"],
    },
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "REJECT_NOT_IN_CART");
  assert.deepEqual(cart, baseCart);
});

// 10. replace with unavailable target item must reject
test("replace with unavailable target: zinger -> beef burger -> REJECT_UNAVAILABLE", () => {
  const cart = cloneCart(baseCart);
  const intent: Intent = {
    type: "replace_item",
    rawText: "zinger ki jagah beef burger dedo",
    confidence: 0.9,
    replace: {
      sourceQuery: "zinger",
      targetQuery: "beef burger",
      sourceCandidateItemIds: ["zinger-burger"],
      targetCandidateItemIds: [],
    },
  };
  const result = evaluateSafety(intent, cart, menu);
  assert.equal(result.decision, "REJECT_UNAVAILABLE");
  assert.deepEqual(cart, baseCart);
});
