// V2 order state engine tests. Drives the engine through the REAL intent
// parser (parseMessage) rather than hand-built ParseResults for the
// end-to-end flow tests, so these also prove the whole pipeline (parser ->
// safety -> cart engine -> order state engine) actually connects. Some
// lower-level unit tests construct ParseResult/OrderContext fixtures
// directly to exercise specific guard/branch behavior in isolation.
// Run with:
//   npx tsx --test tests/v2/order-state.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { OrderContext } from "../../v2/types/order";
import type { ParseResult } from "../../v2/types/parser";
import { parseMessage } from "../../v2/intent-parser/parser";
import {
  processMessage,
  createInitialContext,
  cancelOrder,
  touch,
  isCartEditIntent,
  isFinalState,
  canEditCart,
  hasCartItems,
  hasPendingClarification,
  canStartCheckout,
  canConfirmOrder,
  canSelectDeliveryPickup,
  canAcceptAddress,
  canAcceptName,
  canSubmitOrder,
  nextStateAfterCartMutation,
  buildPendingClarification,
  resolveClarificationReply,
  isValidAddressReply,
  extractCustomerName,
  buildOrderReviewSummary,
  isFinalSubmitTrigger,
  PENDING_VERIFICATION_MESSAGE,
} from "../../v2/order-state-engine";

const menu = menuData as Menu;

function say(ctx: OrderContext, msg: string): { ctx: OrderContext; parseResult: ParseResult } {
  const parseResult = parseMessage(msg, ctx.cart, menu);
  return { ctx: processMessage(ctx, parseResult, menu), parseResult };
}

function driveMany(ctx: OrderContext, messages: string[]): OrderContext {
  let current = ctx;
  for (const m of messages) {
    current = say(current, m).ctx;
  }
  return current;
}

// ─── 1. BROWSING → CART_EDITING after add item ───────────────────────────────

test("1. BROWSING -> CART_EDITING after adding an item", () => {
  const ctx = createInitialContext();
  const { ctx: after } = say(ctx, "ek jumbo zinger dedo");
  assert.equal(after.state, "CART_EDITING");
  assert.equal(after.cart.items.length, 1);
  assert.equal(after.cart.items[0].itemId, "jumbo-zinger");
});

test("BROWSING stays BROWSING for info-only messages (menu/price/restaurant info)", () => {
  const ctx = createInitialContext();
  const { ctx: after } = say(ctx, "menu dikhao");
  assert.equal(after.state, "BROWSING");
  assert.equal(after.cart.items.length, 0);
});

// ─── 2. CART_EDITING → ORDER_REVIEW after checkout start ─────────────────────

test("2. CART_EDITING -> ORDER_REVIEW after checkout start", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]);
  const { ctx: after } = say(ctx, "checkout");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.orderReviewShown, true);
});

test("CART_EDITING supports add/remove/replace/change-quantity while staying in CART_EDITING", () => {
  let ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek gyro dedo"]);
  assert.equal(ctx.state, "CART_EDITING");
  assert.equal(ctx.cart.items.length, 2);
  ctx = say(ctx, "gyro remove karo").ctx;
  assert.equal(ctx.state, "CART_EDITING");
  assert.equal(ctx.cart.items.length, 1);
});

// ─── 3. ORDER_REVIEW does not go to delivery without confirm order ───────────

test("3. ORDER_REVIEW does not move to AWAITING_DELIVERY_PICKUP without confirm order", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  assert.equal(ctx.state, "ORDER_REVIEW");
  const { ctx: after } = say(ctx, "delivery");
  assert.equal(after.state, "ORDER_REVIEW"); // premature delivery selection ignored
  assert.equal(after.deliveryType, undefined);
});

// ─── 4-7. ORDER_REVIEW allows cart edits ─────────────────────────────────────

test("4. ORDER_REVIEW allows add item, stays in ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  const { ctx: after } = say(ctx, "ek gyro dedo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 2);
  assert.equal(after.orderReviewShown, true);
});

test("5. ORDER_REVIEW allows remove item, stays in ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]);
  const { ctx: after } = say(ctx, "gyro remove karo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 1);
  assert.equal(after.cart.items[0].itemId, "jumbo-zinger");
});

test("6. ORDER_REVIEW allows replace item, stays in ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  const { ctx: after } = say(ctx, "zinger hata kar steak add karo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.deepEqual(after.cart.items.map((i) => i.itemId), ["chicken-steak"]);
});

test("7. ORDER_REVIEW allows clear cart, stays in ORDER_REVIEW with an empty cart", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  const { ctx: after } = say(ctx, "remove everything");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 0);
});

// ─── 8. ORDER_REVIEW → AWAITING_DELIVERY_PICKUP after confirm order ──────────

test("8. ORDER_REVIEW -> AWAITING_DELIVERY_PICKUP after confirm order", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  const { ctx: after } = say(ctx, "confirm order");
  assert.equal(after.state, "AWAITING_DELIVERY_PICKUP");
});

test("8b. confirm order variants all work: 'order confirm', 'haan confirm', 'confirm kar do'", () => {
  for (const phrase of ["order confirm", "haan confirm", "confirm kar do"]) {
    const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
    const { ctx: after } = say(ctx, phrase);
    assert.equal(after.state, "AWAITING_DELIVERY_PICKUP", `expected confirm via "${phrase}" to work`);
  }
});

// ─── 9-10. AWAITING_DELIVERY_PICKUP branching ────────────────────────────────

test("9. AWAITING_DELIVERY_PICKUP -> AWAITING_ADDRESS after delivery", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  const { ctx: after } = say(ctx, "delivery");
  assert.equal(after.state, "AWAITING_ADDRESS");
  assert.equal(after.deliveryType, "delivery");
});

test("10. AWAITING_DELIVERY_PICKUP -> AWAITING_NAME after pickup", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  const { ctx: after } = say(ctx, "pickup");
  assert.equal(after.state, "AWAITING_NAME");
  assert.equal(after.deliveryType, "pickup");
});

// ─── 11-12. AWAITING_ADDRESS ──────────────────────────────────────────────────

test("11. AWAITING_ADDRESS rejects invalid/unclear replies", () => {
  const base = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]);
  for (const invalid of ["ok", "yes", "hello", "abc", "asdf", "same", "wait"]) {
    const { ctx: after } = say(base, invalid);
    assert.equal(after.state, "AWAITING_ADDRESS", `expected "${invalid}" to be rejected as an address`);
    assert.equal(after.address, undefined);
  }
});

test("12. AWAITING_ADDRESS accepts a valid address and moves to AWAITING_NAME", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]);
  const { ctx: after } = say(ctx, "House 45 Street 12 Nazimabad Karachi");
  assert.equal(after.state, "AWAITING_NAME");
  assert.equal(after.address, "House 45 Street 12 Nazimabad Karachi");
});

// ─── 13-15. AWAITING_NAME ─────────────────────────────────────────────────────

test("13. AWAITING_NAME extracts 'Fahad' from 'mera naam Fahad hai'", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 45 Street 12 Nazimabad Karachi",
  ]);
  const { ctx: after } = say(ctx, "mera naam Fahad hai");
  assert.equal(after.customerName, "Fahad");
});

test("14. AWAITING_NAME extracts 'Ali Khan' from 'my name is Ali Khan'", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo", "checkout", "confirm order", "pickup",
  ]);
  const { ctx: after } = say(ctx, "my name is Ali Khan");
  assert.equal(after.customerName, "Ali Khan");
});

test("15. AWAITING_NAME -> READY_TO_SUBMIT after a valid name", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]);
  const { ctx: after } = say(ctx, "Bilal");
  assert.equal(after.state, "READY_TO_SUBMIT");
  assert.equal(after.customerName, "Bilal");
});

test("AWAITING_NAME rejects a generic non-name reply and stays put", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]);
  const { ctx: after } = say(ctx, "ok");
  assert.equal(after.state, "AWAITING_NAME");
  assert.equal(after.customerName, undefined);
});

// ─── 16-17. READY_TO_SUBMIT / PENDING_VERIFICATION ───────────────────────────

test("16. READY_TO_SUBMIT -> PENDING_VERIFICATION after submit", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal"]);
  const { ctx: after } = say(ctx, "submit");
  assert.equal(after.state, "PENDING_VERIFICATION");
});

test("16b. 'final submit', 'yes submit', 'done' all trigger PENDING_VERIFICATION", () => {
  for (const phrase of ["final submit", "yes submit", "done"]) {
    const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal"]);
    const { ctx: after } = say(ctx, phrase);
    assert.equal(after.state, "PENDING_VERIFICATION", `expected "${phrase}" to submit`);
  }
});

test("17. PENDING_VERIFICATION is final — further messages are ignored, no cart edits", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]);
  assert.equal(ctx.state, "PENDING_VERIFICATION");
  const { ctx: after } = say(ctx, "ek aur zinger dedo");
  assert.equal(after.state, "PENDING_VERIFICATION");
  assert.equal(after.cart.items.length, ctx.cart.items.length);
  assert.equal(isFinalState(after.state), true);
});

test("PENDING_VERIFICATION message text mentions the required phrases", () => {
  assert.match(PENDING_VERIFICATION_MESSAGE, /Order received successfully/);
  assert.match(PENDING_VERIFICATION_MESSAGE, /Pending Verification/);
  assert.match(PENDING_VERIFICATION_MESSAGE, /call you shortly/);
});

// ─── 18-19. Clarification ─────────────────────────────────────────────────────

test("18. '5 pasta' creates AWAITING_CLARIFICATION with pending pasta category", () => {
  const { ctx: after, parseResult } = say(createInitialContext(), "5 pasta");
  assert.equal(after.state, "AWAITING_CLARIFICATION");
  assert.equal(parseResult.safetyDecision, "ASK_CLARIFICATION");
  assert.ok(after.pendingClarification);
  assert.equal(after.pendingClarification?.category, "pasta");
  assert.equal(after.pendingClarification?.quantity, 5);
  assert.equal(after.cart.items.length, 0); // never mutated while ambiguous
});

test("19. '2 small 2 large 1 alfredo' resolves the pending pasta clarification and returns to CART_EDITING", () => {
  const ctx = driveMany(createInitialContext(), ["5 pasta"]);
  assert.equal(ctx.state, "AWAITING_CLARIFICATION");
  const { ctx: after } = say(ctx, "2 small 2 large 1 alfredo");
  assert.equal(after.state, "CART_EDITING");
  assert.equal(after.pendingClarification, undefined);
  assert.equal(after.cart.items.length, 3);
  assert.deepEqual(
    after.cart.items.map((i) => [i.itemId, i.qty]),
    [["pasta-small", 2], ["pasta-large", 2], ["alfredo-pasta-white-sauce", 1]]
  );
});

test("clarification: a bare unrelated reply re-asks instead of guessing", () => {
  const ctx = driveMany(createInitialContext(), ["5 pasta"]);
  const { ctx: after } = say(ctx, "asdkjaslkdj");
  assert.equal(after.state, "AWAITING_CLARIFICATION");
  assert.ok(after.pendingClarification);
});

test("clarification: checkout is BLOCKED while a clarification is pending, and the question is preserved (Clarification Queue rule 8)", () => {
  // Deliberate behavior change (V2 Customer Conversation Layer / Action
  // Planner + Clarification Queue rework): checkout is no longer silently
  // abandoned — it's blocked until the customer answers, so an order is
  // never finalized while it's still missing an item they asked for.
  const cartWithItem = driveMany(createInitialContext(), ["ek gyro dedo"]);
  const withClarification = say(cartWithItem, "5 pasta").ctx;
  assert.equal(withClarification.state, "AWAITING_CLARIFICATION");
  const { ctx: after } = say(withClarification, "checkout");
  assert.equal(after.state, "AWAITING_CLARIFICATION");
  assert.ok(after.pendingClarification);
  assert.equal(after.pendingClarification?.category, "pasta");
});

// ─── 20. Edit cart during delivery/pickup stage ──────────────────────────────

test("20. customer can edit cart during AWAITING_DELIVERY_PICKUP, bounces back to ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  assert.equal(ctx.state, "AWAITING_DELIVERY_PICKUP");
  const { ctx: after } = say(ctx, "ek gyro dedo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 2);
});

// ─── Full end-to-end flows ────────────────────────────────────────────────────

test("full pickup flow end to end", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo",
    "checkout",
    "confirm order",
    "pickup",
    "Bilal",
    "submit",
  ]);
  assert.equal(ctx.state, "PENDING_VERIFICATION");
  assert.equal(ctx.deliveryType, "pickup");
  assert.equal(ctx.address, undefined);
  assert.equal(ctx.customerName, "Bilal");
  assert.equal(ctx.cart.items.length, 1);
});

test("full delivery flow end to end", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo",
    "checkout",
    "confirm order",
    "delivery",
    "House 45 Street 12 Nazimabad Karachi",
    "mera naam Fahad hai",
    "final submit",
  ]);
  assert.equal(ctx.state, "PENDING_VERIFICATION");
  assert.equal(ctx.deliveryType, "delivery");
  assert.equal(ctx.address, "House 45 Street 12 Nazimabad Karachi");
  assert.equal(ctx.customerName, "Fahad");
});

// ─── Checkout interruption ────────────────────────────────────────────────────

test("checkout interruption: editing cart during AWAITING_ADDRESS returns to ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]);
  assert.equal(ctx.state, "AWAITING_ADDRESS");
  const { ctx: after } = say(ctx, "ek gyro dedo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 2);
});

test("checkout interruption: editing cart during AWAITING_NAME returns to ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]);
  assert.equal(ctx.state, "AWAITING_NAME");
  const { ctx: after } = say(ctx, "ek gyro dedo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 2);
});

test("checkout interruption: editing cart during READY_TO_SUBMIT returns to ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal"]);
  assert.equal(ctx.state, "READY_TO_SUBMIT");
  const { ctx: after } = say(ctx, "gyro dedo ek");
  assert.equal(after.state, "ORDER_REVIEW");
});

// ─── Additional required scenarios ────────────────────────────────────────────

test("clear cart during review empties the cart and keeps ORDER_REVIEW", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]);
  const { ctx: after } = say(ctx, "clear cart");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 0);
});

test("invalid confirm without cart: clearing cart during review then confirming is rejected", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "remove everything"]);
  assert.equal(ctx.cart.items.length, 0);
  const { ctx: after } = say(ctx, "confirm order");
  assert.equal(after.state, "ORDER_REVIEW"); // never advances with an empty cart
});

test("confirm order before checkout is ignored (still BROWSING/CART_EDITING)", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]);
  assert.equal(ctx.state, "CART_EDITING");
  const { ctx: after } = say(ctx, "confirm order");
  assert.equal(after.state, "CART_EDITING");
});

test("confirm order with an empty cart from BROWSING never reaches delivery/pickup", () => {
  const ctx = createInitialContext();
  const { ctx: after } = say(ctx, "confirm order");
  assert.equal(after.state, "BROWSING");
});

test("address before delivery selected is never accepted", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  assert.equal(ctx.state, "AWAITING_DELIVERY_PICKUP");
  const { ctx: after } = say(ctx, "House 45 Street 12 Nazimabad Karachi");
  assert.equal(after.state, "AWAITING_DELIVERY_PICKUP");
  assert.equal(after.address, undefined);
});

test("name before delivery/pickup selected is never accepted", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  const { ctx: after } = say(ctx, "mera naam Fahad hai");
  assert.equal(after.state, "AWAITING_DELIVERY_PICKUP");
  assert.equal(after.customerName, undefined);
});

test("name before address, when delivery was selected, is never accepted", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]);
  assert.equal(ctx.state, "AWAITING_ADDRESS");
  assert.equal(canAcceptName(ctx), false);
});

test("changing from delivery to pickup while awaiting address switches flow and clears address", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]);
  assert.equal(ctx.state, "AWAITING_ADDRESS");
  const { ctx: after } = say(ctx, "pickup");
  assert.equal(after.state, "AWAITING_NAME");
  assert.equal(after.deliveryType, "pickup");
  assert.equal(after.address, undefined);
});

test("changing from pickup to delivery while awaiting name switches flow back to address", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]);
  assert.equal(ctx.state, "AWAITING_NAME");
  const { ctx: after } = say(ctx, "delivery");
  assert.equal(after.state, "AWAITING_ADDRESS");
  assert.equal(after.deliveryType, "delivery");
});

// ─── Guards: direct unit tests ────────────────────────────────────────────────

test("guards: isCartEditIntent recognizes all 6 cart-mutating intents and rejects others", () => {
  for (const i of ["ADD_ITEM", "ADD_MULTIPLE_ITEMS", "REMOVE_ITEM", "REMOVE_ALL", "REPLACE_ITEM", "CHANGE_QUANTITY"] as const) {
    assert.equal(isCartEditIntent(i), true);
  }
  for (const i of ["SHOW_MENU", "CONFIRM_ORDER", "UNKNOWN"] as const) {
    assert.equal(isCartEditIntent(i), false);
  }
});

test("guards: isFinalState / canEditCart", () => {
  assert.equal(isFinalState("PENDING_VERIFICATION"), true);
  assert.equal(isFinalState("CANCELLED"), true);
  assert.equal(isFinalState("BROWSING"), false);
  assert.equal(canEditCart("PENDING_VERIFICATION"), false);
  assert.equal(canEditCart("CANCELLED"), false);
  assert.equal(canEditCart("ORDER_REVIEW"), true);
});

test("guards: hasCartItems / hasPendingClarification", () => {
  assert.equal(hasCartItems({ items: [] }), false);
  assert.equal(hasCartItems({ items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 1 }] }), true);
  const ctx = createInitialContext();
  assert.equal(hasPendingClarification(ctx), false);
  assert.equal(hasPendingClarification({ ...ctx, pendingClarification: { category: "pasta", quantity: 1, question: "q", options: [], previousMessage: "m" } }), true);
});

test("guards: canStartCheckout requires CART_EDITING and a non-empty cart", () => {
  const cart: CartState = { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 1 }] };
  assert.equal(canStartCheckout("CART_EDITING", cart), true);
  assert.equal(canStartCheckout("CART_EDITING", { items: [] }), false);
  assert.equal(canStartCheckout("BROWSING", cart), false);
});

test("guards: canConfirmOrder requires ORDER_REVIEW + shown + non-empty cart", () => {
  const base = createInitialContext({ items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 1 }] });
  assert.equal(canConfirmOrder({ ...base, state: "ORDER_REVIEW", orderReviewShown: true }), true);
  assert.equal(canConfirmOrder({ ...base, state: "ORDER_REVIEW", orderReviewShown: false }), false);
  assert.equal(canConfirmOrder({ ...base, state: "ORDER_REVIEW", orderReviewShown: true, cart: { items: [] } }), false);
});

test("guards: canSelectDeliveryPickup only true in AWAITING_DELIVERY_PICKUP", () => {
  assert.equal(canSelectDeliveryPickup("AWAITING_DELIVERY_PICKUP"), true);
  assert.equal(canSelectDeliveryPickup("ORDER_REVIEW"), false);
});

test("guards: canAcceptAddress requires AWAITING_ADDRESS + deliveryType delivery", () => {
  const base = createInitialContext();
  assert.equal(canAcceptAddress({ ...base, state: "AWAITING_ADDRESS", deliveryType: "delivery" }), true);
  assert.equal(canAcceptAddress({ ...base, state: "AWAITING_ADDRESS", deliveryType: "pickup" }), false);
  assert.equal(canAcceptAddress({ ...base, state: "AWAITING_ADDRESS" }), false);
});

test("guards: canAcceptName requires address first for delivery, nothing extra for pickup", () => {
  const base = createInitialContext();
  assert.equal(canAcceptName({ ...base, state: "AWAITING_NAME", deliveryType: "pickup" }), true);
  assert.equal(canAcceptName({ ...base, state: "AWAITING_NAME", deliveryType: "delivery" }), false);
  assert.equal(canAcceptName({ ...base, state: "AWAITING_NAME", deliveryType: "delivery", address: "some address" }), true);
});

test("guards: canSubmitOrder requires READY_TO_SUBMIT + a customer name", () => {
  const base = createInitialContext();
  assert.equal(canSubmitOrder({ ...base, state: "READY_TO_SUBMIT", customerName: "Bilal" }), true);
  assert.equal(canSubmitOrder({ ...base, state: "READY_TO_SUBMIT" }), false);
});

// ─── Transitions: direct unit tests ───────────────────────────────────────────

test("transitions: nextStateAfterCartMutation", () => {
  assert.equal(nextStateAfterCartMutation("BROWSING"), "CART_EDITING");
  assert.equal(nextStateAfterCartMutation("CART_EDITING"), "CART_EDITING");
  assert.equal(nextStateAfterCartMutation("ORDER_REVIEW"), "ORDER_REVIEW");
  assert.equal(nextStateAfterCartMutation("AWAITING_DELIVERY_PICKUP"), "ORDER_REVIEW");
  assert.equal(nextStateAfterCartMutation("AWAITING_ADDRESS"), "ORDER_REVIEW");
  assert.equal(nextStateAfterCartMutation("AWAITING_NAME"), "ORDER_REVIEW");
  assert.equal(nextStateAfterCartMutation("READY_TO_SUBMIT"), "ORDER_REVIEW");
});

// ─── Context helpers ───────────────────────────────────────────────────────────

test("context: createInitialContext starts BROWSING with an empty cart", () => {
  const ctx = createInitialContext();
  assert.equal(ctx.state, "BROWSING");
  assert.deepEqual(ctx.cart, { items: [] });
  assert.equal(ctx.orderReviewShown, false);
  assert.equal(ctx.createdAt, ctx.updatedAt);
});

test("context: touch never mutates the original context and bumps updatedAt", () => {
  const ctx = createInitialContext(undefined, () => new Date("2026-01-01T00:00:00.000Z"));
  const next = touch(ctx, { state: "CART_EDITING" }, () => new Date("2026-01-01T00:05:00.000Z"));
  assert.equal(ctx.state, "BROWSING");
  assert.equal(next.state, "CART_EDITING");
  assert.equal(next.updatedAt, "2026-01-01T00:05:00.000Z");
  assert.equal(next.createdAt, ctx.createdAt);
});

// ─── Clarification helpers: direct unit tests ─────────────────────────────────

test("clarification: buildPendingClarification returns null when nothing is ambiguous", () => {
  const parseResult = parseMessage("ek gyro dedo", { items: [] }, menu);
  assert.equal(buildPendingClarification(parseResult, menu), null);
});

test("clarification: buildPendingClarification captures category/quantity/options from an ambiguous add", () => {
  const parseResult = parseMessage("5 pasta", { items: [] }, menu);
  const pending = buildPendingClarification(parseResult, menu);
  assert.ok(pending);
  assert.equal(pending?.category, "pasta");
  assert.equal(pending?.quantity, 5);
  assert.equal(pending?.options.length, 5);
  assert.equal(pending?.previousMessage, "5 pasta");
});

test("clarification: resolveClarificationReply reports 'not_an_answer' for unrelated gibberish", () => {
  const parseResult1 = parseMessage("5 pasta", { items: [] }, menu);
  const pending = buildPendingClarification(parseResult1, menu)!;
  const parseResult2 = parseMessage("asdkjaslkdj", { items: [] }, menu);
  assert.equal(resolveClarificationReply(pending, parseResult2, menu).kind, "not_an_answer");
});

test("clarification: resolveClarificationReply reports 'unavailable' for a real item outside the pending category", () => {
  const parseResult1 = parseMessage("mujhe ek pasta chahiye", { items: [] }, menu);
  const pending = buildPendingClarification(parseResult1, menu)!;
  const parseResult2 = parseMessage("club", { items: [] }, menu);
  assert.equal(resolveClarificationReply(pending, parseResult2, menu).kind, "unavailable");
});

test("clarification: resolveClarificationReply resolves strictly within the pending category, never cross-category", () => {
  const parseResult1 = parseMessage("mujhe ek pasta chahiye", { items: [] }, menu);
  const pending = buildPendingClarification(parseResult1, menu)!;
  // "mexican" is globally ambiguous across Sandwich/Pizza/Pasta — must
  // resolve to the Pasta variant only, scoped to the pending category.
  const parseResult2 = parseMessage("mexican", { items: [] }, menu);
  const outcome = resolveClarificationReply(pending, parseResult2, menu);
  assert.equal(outcome.kind, "resolved");
  if (outcome.kind === "resolved") {
    assert.deepEqual(outcome.result.items[0].candidateItemIds, ["mexican-pasta-white-sauce"]);
  }
});

// ─── Customer info helpers: direct unit tests ─────────────────────────────────

test("customer-info: extractCustomerName handles all 4 documented forms", () => {
  assert.equal(extractCustomerName("mera naam Fahad hai"), "Fahad");
  assert.equal(extractCustomerName("my name is Ali Khan"), "Ali Khan");
  assert.equal(extractCustomerName("main Bilal hun"), "Bilal");
  assert.equal(extractCustomerName("Bilal"), "Bilal");
});

test("customer-info: extractCustomerName rejects generic filler replies", () => {
  for (const m of ["ok", "yes", "hello", "done", "submit"]) {
    assert.equal(extractCustomerName(m), null, `expected "${m}" to not be treated as a name`);
  }
});

test("customer-info: isValidAddressReply accepts a real address and rejects filler", () => {
  assert.equal(isValidAddressReply("House 45 Street 12 Nazimabad Karachi"), true);
  for (const m of ["ok", "yes", "hello", "abc", "asdf", "same", "wait"]) {
    assert.equal(isValidAddressReply(m), false);
  }
});

// ─── Checkout helpers: direct unit tests ──────────────────────────────────────

test("checkout: buildOrderReviewSummary reflects cart contents and totals", () => {
  const cart: CartState = { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 2 }] };
  const summary = buildOrderReviewSummary(cart, menu);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.totals.subtotal, 1100);
});

test("checkout: isFinalSubmitTrigger recognizes all 4 documented phrases and rejects unrelated text", () => {
  for (const phrase of ["submit", "final submit", "yes submit", "done"]) {
    assert.equal(isFinalSubmitTrigger(phrase), true);
  }
  assert.equal(isFinalSubmitTrigger("hello"), false);
});

// ─── cancelOrder ───────────────────────────────────────────────────────────────

test("cancelOrder moves a non-final context to CANCELLED", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]);
  const cancelled = cancelOrder(ctx);
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(isFinalState(cancelled.state), true);
});

test("cancelOrder is a no-op once already PENDING_VERIFICATION", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]);
  const result = cancelOrder(ctx);
  assert.equal(result.state, "PENDING_VERIFICATION");
});

// ─── Large / mixed carts through the full pipeline ────────────────────────────

test("mixed-category cart survives the full checkout pipeline intact", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo",
    "ek gyro dedo",
    "chicken noodles",
    "checkout",
    "confirm order",
    "pickup",
    "Bilal",
  ]);
  assert.equal(ctx.state, "READY_TO_SUBMIT");
  assert.deepEqual(
    ctx.cart.items.map((i) => i.itemId).sort(),
    ["chicken-chowmein", "gyro", "jumbo-zinger"].sort()
  );
});

test("unavailable item during CART_EDITING is rejected without changing state or cart", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]);
  const { ctx: after } = say(ctx, "beef burger chahiye");
  assert.equal(after.state, "CART_EDITING");
  assert.equal(after.cart.items.length, 1);
});

test("removing an item not in the cart during ORDER_REVIEW is rejected, cart unchanged", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]);
  const { ctx: after } = say(ctx, "sandwich remove karo");
  assert.equal(after.state, "ORDER_REVIEW");
  assert.equal(after.cart.items.length, 1);
});
