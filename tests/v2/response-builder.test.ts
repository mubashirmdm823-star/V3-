// V2 response builder tests. Drives the REAL pipeline (parseMessage ->
// processMessage -> buildResponse) for anything conversation-shaped — every
// prior V2 session found real bugs this way that hand-built fixtures
// didn't, and the response builder's dispatch logic is exactly the kind of
// code where that matters most.
// Run with:
//   npx tsx --test tests/v2/response-builder.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { OrderContext } from "../../v2/types/order";
import type { CartState } from "../../v2/types/cart";
import { createInitialContext, processMessage } from "../../v2/order-state-engine";
import { parseMessage } from "../../v2/intent-parser/parser";
import {
  buildResponse,
  formatCurrency,
  bulletList,
  joinParagraphs,
  buildOrderSummary,
  EMPTY_CART_MESSAGE,
  buildClarificationReply,
  buildCategoryOptionsReply,
  unavailableItemMessage,
  itemNotInCartMessage,
  unknownRequestMessage,
  invalidQuantityMessage,
  invalidReplacementMessage,
  invalidCheckoutStepMessage,
  buildOrderReviewReply,
  DELIVERY_OR_PICKUP_PROMPT,
  ADDRESS_REQUEST_PROMPT,
  NAME_REQUEST_PROMPT,
  buildFinalReviewReply,
  PENDING_VERIFICATION_REPLY,
  alreadyFinalizedMessage,
  buildRestaurantInfoReply,
  pickEndingVariation,
  pickVariation,
  ENDING_VARIATIONS,
} from "../../v2/response-builder";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;

function say(ctx: OrderContext, msg: string): { ctx: OrderContext; reply: string } {
  const before = ctx;
  const parseResult = parseMessage(msg, before.cart, menu);
  const after = processMessage(before, parseResult, menu);
  const reply = buildResponse({ parseResult, before, after, menu, restaurantConfig });
  return { ctx: after, reply };
}

function driveMany(ctx: OrderContext, messages: string[]): { ctx: OrderContext; reply: string } {
  let current = ctx;
  let lastReply = "";
  for (const m of messages) {
    const step = say(current, m);
    current = step.ctx;
    lastReply = step.reply;
  }
  return { ctx: current, reply: lastReply };
}

function cartOf(...lines: { itemId: string; name: string; price: number; qty: number }[]): CartState {
  return { items: lines };
}

// A handful of internal terms that must never leak into a customer reply.
const FORBIDDEN_LEAK_PATTERNS = [
  /\bADD_ITEM\b/, /\bREMOVE_ITEM\b/, /\bSAFE_TO_EXECUTE\b/, /\bASK_CLARIFICATION\b/,
  /\bREJECT_UNAVAILABLE\b/, /\bREJECT_NOT_IN_CART\b/, /\bNO_CART_ACTION\b/,
  /confidence/i, /candidateItemIds/, /safetyDecision/i, /intent"?:/i,
  /jumbo-zinger|zinger-burger|pasta-small|chicken-steak/, // raw itemIds, not display names
  /\{"/, // JSON-looking output
];

function assertNoLeak(reply: string) {
  for (const pattern of FORBIDDEN_LEAK_PATTERNS) {
    assert.equal(pattern.test(reply), false, `reply leaked internal data matching ${pattern}: ${reply}`);
  }
  assert.equal(/undefined|NaN|\[object Object\]/.test(reply), false, `reply contains a placeholder artifact: ${reply}`);
}

// ─── Add item (single) ───────────────────────────────────────────────────────

test("add item: single item confirmation includes name, quantity, and order summary", () => {
  const { reply } = say(createInitialContext(), "2 jumbo zinger");
  assert.match(reply, /2 × Jumbo Zinger cart mein add kar diye gaye hain/);
  assert.match(reply, /Current Order/);
  assert.match(reply, /Jumbo Zinger ×2 — PKR 1500/);
  assert.match(reply, /Total: PKR 1500/);
  assertNoLeak(reply);
});

test("add item: default quantity of 1 is reflected in the confirmation", () => {
  const { reply } = say(createInitialContext(), "ek gyro dedo");
  assert.match(reply, /1 × Gyro cart mein add kar diye gaye hain/);
});

test("add item: ends with one of the dynamic variation sentences", () => {
  const { reply } = say(createInitialContext(), "ek gyro dedo");
  const lastLine = reply.trim().split("\n").pop()!;
  assert.equal(ENDING_VARIATIONS.includes(lastLine as (typeof ENDING_VARIATIONS)[number]), true);
});

// ─── Multiple items ───────────────────────────────────────────────────────────

test("multiple items: generic confirmation lists every added item with line totals", () => {
  const { reply } = say(createInitialContext(), "2 small 2 large 1 alfredo");
  assert.match(reply, /Aapke items cart mein add kar diye gaye hain/);
  assert.match(reply, /Pasta Small ×2 — PKR 1000/);
  assert.match(reply, /Pasta Large ×2 — PKR 1200/);
  assert.match(reply, /Alfredo Pasta white sauce ×1 — PKR 850/);
  assert.match(reply, /Total: PKR 3050/);
  assertNoLeak(reply);
});

test("multiple items: no item line appears twice", () => {
  const { reply } = say(createInitialContext(), "2 small 2 large 1 alfredo");
  const lines = reply.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(new Set(lines).size, lines.length);
});

// ─── Remove ───────────────────────────────────────────────────────────────────

test("remove: confirmation names the removed item and shows the updated cart", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek gyro dedo"]).ctx;
  const { reply } = say(ctx, "gyro remove karo");
  assert.match(reply, /Gyro cart se remove kar diya gaya hai/);
  assert.doesNotMatch(reply, /Gyro ×/); // gone from the summary
  assert.match(reply, /Jumbo Zinger ×1/);
  assertNoLeak(reply);
});

test("remove: item not in cart returns a professional rejection, not the confirmation template", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "sandwich remove karo");
  assert.match(reply, /maujood nahi hai/);
  assert.doesNotMatch(reply, /remove kar diya gaya hai/);
  assertNoLeak(reply);
});

// ─── Replace ──────────────────────────────────────────────────────────────────

test("replace: confirmation names both the source and target item", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "zinger hata kar steak add karo");
  assert.match(reply, /Jumbo Zinger ki jagah Chicken Steak add kar diya gaya hai/);
  assert.match(reply, /Chicken Steak ×1/);
  assertNoLeak(reply);
});

test("replace: missing source item returns a not-in-cart rejection", () => {
  const { reply } = say(createInitialContext(), "sandwich hata kar steak add karo");
  assert.match(reply, /maujood nahi hai/);
});

test("replace: unavailable target returns an unavailable rejection", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "zinger hata kar beef burger add karo");
  assert.match(reply, /maujood nahi hai/);
});

// ─── Quantity update ──────────────────────────────────────────────────────────

test("quantity: confirmation and updated summary reflect the new quantity", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "jumbo zinger ki quantity 5 kardo");
  assert.match(reply, /Quantity successfully update kar di gayi hai/);
  assert.match(reply, /Jumbo Zinger ×5/);
  assertNoLeak(reply);
});

// ─── Clear cart ───────────────────────────────────────────────────────────────

test("clear cart: confirmation reports the cart is now clear", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek gyro dedo"]).ctx;
  const { reply } = say(ctx, "remove everything");
  assert.match(reply, /cart clear kar di gayi hai/);
  assertNoLeak(reply);
});

// ─── Order summary builder ────────────────────────────────────────────────────

test("order-summary: empty cart returns the empty-cart message", () => {
  assert.equal(buildOrderSummary({ items: [] }, menu), EMPTY_CART_MESSAGE);
});

test("order-summary: includes item, quantity, line total, and grand total with no extra blank lines", () => {
  const cart = cartOf({ itemId: "gyro", name: "Gyro", price: 550, qty: 2 }, { itemId: "wrap", name: "Wrap", price: 550, qty: 1 });
  const summary = buildOrderSummary(cart, menu, "Current Order");
  assert.match(summary, /Gyro ×2 — PKR 1100/);
  assert.match(summary, /Wrap ×1 — PKR 550/);
  assert.match(summary, /Total: PKR 1650/);
  assert.equal(/\n\n\n/.test(summary), false); // no 3+ consecutive newlines anywhere
});

test("order-summary: never lists the same item on two separate lines", () => {
  const cart = cartOf({ itemId: "gyro", name: "Gyro", price: 550, qty: 3 });
  const summary = buildOrderSummary(cart, menu);
  assert.equal((summary.match(/Gyro/g) ?? []).length, 1);
});

// ─── Checkout review ──────────────────────────────────────────────────────────

test("checkout review: reply includes the summary and the confirm-order instruction", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "checkout");
  assert.match(reply, /order review tayyar hai/);
  assert.match(reply, /Order Review/);
  assert.match(reply, /Jumbo Zinger ×1/);
  assert.match(reply, /"Confirm Order"/);
  assertNoLeak(reply);
});

test("checkout review: cart edits during ORDER_REVIEW show 'Updated Order' heading", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]).ctx;
  const { reply } = say(ctx, "ek gyro dedo");
  assert.match(reply, /Updated Order/);
});

test("checkout review: confirm order prompts for delivery or pickup", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout"]).ctx;
  const { reply } = say(ctx, "confirm order");
  assert.equal(reply, DELIVERY_OR_PICKUP_PROMPT);
});

// ─── Delivery / Pickup ────────────────────────────────────────────────────────

test("delivery: selecting delivery prompts for the address", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]).ctx;
  const { reply } = say(ctx, "delivery");
  assert.equal(reply, ADDRESS_REQUEST_PROMPT);
});

test("pickup: selecting pickup prompts for the name (no address needed)", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order"]).ctx;
  const { reply } = say(ctx, "pickup");
  assert.equal(reply, NAME_REQUEST_PROMPT);
});

// ─── Address ──────────────────────────────────────────────────────────────────

test("address: an invalid reply re-prompts rather than accepting it", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]).ctx;
  const { reply } = say(ctx, "ok");
  assert.equal(reply, ADDRESS_REQUEST_PROMPT);
});

test("address: a valid address moves on to asking for the name", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]).ctx;
  const { reply } = say(ctx, "House 45 Street 12 Nazimabad Karachi");
  assert.equal(reply, NAME_REQUEST_PROMPT);
});

// ─── Name ─────────────────────────────────────────────────────────────────────

test("name: a valid name produces the final review with name and pickup/delivery details", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]).ctx;
  const { reply } = say(ctx, "Bilal");
  assert.match(reply, /Final Order Review/);
  assert.match(reply, /Naam: Bilal/);
  assert.match(reply, /Order Type: Pickup/);
  assert.match(reply, /"Submit"/);
  assertNoLeak(reply);
});

test("name: final review for delivery shows the address instead of 'Pickup'", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 45 Street 12 Nazimabad Karachi",
  ]).ctx;
  const { reply } = say(ctx, "mera naam Fahad hai");
  assert.match(reply, /Naam: Fahad/);
  assert.match(reply, /Delivery Address: House 45 Street 12 Nazimabad Karachi/);
});

// ─── Pending verification ─────────────────────────────────────────────────────

test("pending verification: exact required phrases are present", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal",
  ]).ctx;
  const { reply } = say(ctx, "submit");
  assert.match(reply, /order receive kar liya gaya hai/);
  assert.match(reply, /Pending Verification/);
  assert.match(reply, /Hamari team jald aapse rabta karegi/);
  assertNoLeak(reply);
});

test("pending verification: a further message afterward gets a polite already-submitted reply, no cart edits", () => {
  const ctx = driveMany(createInitialContext(), [
    "ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit",
  ]).ctx;
  const { ctx: after, reply } = say(ctx, "ek aur zinger dedo");
  assert.equal(after.state, "PENDING_VERIFICATION");
  assert.equal(after.cart.items.length, ctx.cart.items.length);
  assert.match(reply, /pehle hi receive ho chuka hai/);
});

test("cancelled: alreadyFinalizedMessage reports the order was cancelled", () => {
  assert.match(alreadyFinalizedMessage("CANCELLED"), /cancel ho chuka hai/);
});

// ─── Restaurant info ──────────────────────────────────────────────────────────

test("restaurant info: reply is generated entirely from restaurant-config.json fields", () => {
  const { reply } = say(createInitialContext(), "aapka address kya hai");
  assert.match(reply, new RegExp(restaurantConfig.address.replace(/[()]/g, "\\$&")));
  assert.match(reply, new RegExp(restaurantConfig.phone));
  assert.match(reply, new RegExp(restaurantConfig.timing));
  assert.match(reply, /PKR 150/);
  assert.match(reply, new RegExp(restaurantConfig.deliveryTime));
});

test("restaurant info: changing the config changes the reply (no hardcoding)", () => {
  const customConfig: RestaurantConfig = { ...restaurantConfig, phone: "0300-9999999", deliveryFee: 999 };
  const reply = buildRestaurantInfoReply(customConfig);
  assert.match(reply, /0300-9999999/);
  assert.match(reply, /PKR 999/);
});

test("restaurant info: uses only the approved emoji set", () => {
  const reply = buildRestaurantInfoReply(restaurantConfig);
  const emojis = reply.match(/[\u{1F300}-\u{1FAFF}✅]/gu) ?? [];
  for (const e of emojis) {
    assert.equal(["📍", "📞", "🚚"].includes(e), true, `unexpected emoji: ${e}`);
  }
});

// ─── Unavailable item / item not in cart ─────────────────────────────────────

test("unavailable item: professional rejection, no technical reason exposed", () => {
  const { reply } = say(createInitialContext(), "beef burger chahiye");
  assert.match(reply, /maujood nahi hai/);
  assertNoLeak(reply);
});

test("item not in cart: professional rejection when removing something absent", () => {
  const { reply } = say(createInitialContext(), "sandwich remove karo");
  assert.match(reply, /maujood nahi hai/);
});

test("errors: unavailableItemMessage and itemNotInCartMessage never expose the word 'reject'", () => {
  assert.equal(/reject/i.test(unavailableItemMessage("x")), false);
  assert.equal(/reject/i.test(itemNotInCartMessage("x")), false);
});

test("errors: unknownRequestMessage, invalidQuantityMessage, invalidReplacementMessage, invalidCheckoutStepMessage are all non-empty distinct strings", () => {
  const messages = [unknownRequestMessage(), invalidQuantityMessage(), invalidReplacementMessage(), invalidCheckoutStepMessage()];
  assert.equal(new Set(messages).size, messages.length);
  for (const m of messages) assert.equal(m.length > 0, true);
});

test("invalid checkout step: confirming order before checkout is a polite rejection, not silent", () => {
  const { reply } = say(createInitialContext(), "confirm order");
  assert.equal(reply, invalidCheckoutStepMessage());
});

// ─── Clarification ────────────────────────────────────────────────────────────

test("clarification: '5 pasta' lists all 5 pasta options", () => {
  const { reply } = say(createInitialContext(), "5 pasta");
  assert.match(reply, /Aap kaunsa Pasta chahenge\?/);
  assert.match(reply, /Pasta Small/);
  assert.match(reply, /Pasta Large/);
  assert.match(reply, /Alfredo Pasta white sauce/);
  assert.match(reply, /Macaroni Pasta red sauce/);
  assert.match(reply, /Mexican Pasta white sauce/);
  assertNoLeak(reply);
});

test("clarification: bare 'zinger' lists the 3 zinger family options", () => {
  const { reply } = say(createInitialContext(), "ek zinger kardo");
  assert.match(reply, /Aap kaunsa Zinger chahenge\?/);
  assert.match(reply, /Zinger Burger W\/C/);
  assert.match(reply, /Jumbo Zinger/);
});

test("clarification: 'or zinger dikhao' shows the zinger family as browse options (not a question)", () => {
  const { reply } = say(createInitialContext(), "or zinger dikhao");
  assert.match(reply, /options available/);
  assert.doesNotMatch(reply, /\?/);
});

test("buildClarificationReply / buildCategoryOptionsReply produce non-empty, option-listing strings directly", () => {
  const pending = { category: "pasta", quantity: 5, question: "q", options: [{ id: "pasta-small", name: "Pasta Small", price: 500 }], previousMessage: "5 pasta" };
  assert.match(buildClarificationReply(pending), /Pasta Small/);
  assert.match(buildCategoryOptionsReply("burger", [{ id: "zinger-burger", name: "Zinger Burger", price: 500 }]), /Zinger Burger/);
  assert.match(buildCategoryOptionsReply("burger", []), /koi item nahi mila/);
});

// ─── Formatting / currency ────────────────────────────────────────────────────

test("formatting: formatCurrency always renders as 'PKR <amount>'", () => {
  assert.equal(formatCurrency(500), "PKR 500");
  assert.equal(formatCurrency(0), "PKR 0");
  assert.equal(formatCurrency(1234), "PKR 1234");
});

test("formatting: never $ prefix, never trailing PKR, never doubled PKR", () => {
  const { reply } = say(createInitialContext(), "2 jumbo zinger");
  assert.equal(/\$\d/.test(reply), false);
  assert.equal(/\dPKR/.test(reply), false);
  assert.equal(/PKR\s*PKR/.test(reply), false);
});

test("formatting: every currency mention in a full conversation matches the single approved format", () => {
  const { reply } = driveMany(createInitialContext(), ["2 small 2 large 1 alfredo", "checkout"]);
  const currencyMentions = reply.match(/PKR[^\n]*?(\d+)/g) ?? [];
  assert.equal(currencyMentions.length > 0, true);
  for (const mention of currencyMentions) {
    assert.match(mention, /^PKR \d+/);
  }
});

test("bulletList/joinParagraphs: never introduce blank bullet lines or leading/trailing blank paragraphs", () => {
  const list = bulletList(["A", "B"]);
  assert.equal(list, "• A\n• B");
  const joined = joinParagraphs("first", "", undefined, "second");
  assert.equal(joined, "first\n\nsecond");
});

// ─── Reply variation ──────────────────────────────────────────────────────────

test("variation: pickEndingVariation only ever returns one of the 5 documented sentences", () => {
  for (const seed of ["a", "b", "c", "ek gyro dedo", "5 pasta", "checkout now please"]) {
    assert.equal(ENDING_VARIATIONS.includes(pickEndingVariation(seed) as (typeof ENDING_VARIATIONS)[number]), true);
  }
});

test("variation: different seeds produce more than one distinct ending across a spread of messages", () => {
  const seeds = ["ek gyro dedo", "2 jumbo zinger", "checkout", "confirm order", "mera naam Ali hai", "pickup please", "delivery abhi", "5 pasta please add"];
  const outputs = new Set(seeds.map((s) => pickEndingVariation(s)));
  assert.equal(outputs.size > 1, true);
});

test("variation: pickVariation is deterministic — repeated calls with the same seed match", () => {
  const pool = ["one", "two", "three"] as const;
  const first = pickVariation(pool, "some-seed");
  for (let i = 0; i < 5; i++) {
    assert.equal(pickVariation(pool, "some-seed"), first);
  }
});

test("variation: an empty pool returns an empty string rather than throwing", () => {
  assert.equal(pickVariation([], "anything"), "");
});

// ─── Deterministic replies ────────────────────────────────────────────────────

test("deterministic: the same structured input always produces the exact same reply", () => {
  const ctx = createInitialContext();
  const parseResult = parseMessage("2 jumbo zinger", ctx.cart, menu);
  const after = processMessage(ctx, parseResult, menu);
  const reply1 = buildResponse({ parseResult, before: ctx, after, menu, restaurantConfig });
  const reply2 = buildResponse({ parseResult, before: ctx, after, menu, restaurantConfig });
  assert.equal(reply1, reply2);
});

test("deterministic: replaying an entire conversation from scratch produces identical replies at every step", () => {
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"];
  const run = () => {
    let ctx = createInitialContext();
    const replies: string[] = [];
    for (const m of messages) {
      const step = say(ctx, m);
      ctx = step.ctx;
      replies.push(step.reply);
    }
    return replies;
  };
  assert.deepEqual(run(), run());
});

// ─── No JSON / debug leakage across a broad conversation ─────────────────────

test("no leakage: a full conversation across every intent type never exposes internal data", () => {
  const messages = [
    "menu dikhao", "or zinger dikhao", "aapka address kya hai", "zinger burger ka rate kitne ka hai",
    "beef burger chahiye", "ek jumbo zinger dedo", "5 pasta", "2 small 2 large 1 alfredo",
    "jumbo zinger ki quantity 3 kardo", "zinger hata kar steak add karo", "sandwich remove karo",
    "checkout", "confirm order", "delivery", "ok", "House 45 Street 12 Nazimabad Karachi",
    "mera naam Fahad hai", "submit", "asdkjaslkdj",
  ];
  let ctx = createInitialContext();
  for (const m of messages) {
    const { ctx: next, reply } = say(ctx, m);
    ctx = next;
    assertNoLeak(reply);
    assert.equal(typeof reply, "string");
    assert.equal(reply.length > 0, true);
  }
});

// ─── Professional grammar / no duplicated lines across a real conversation ──

test("no duplicated lines: order summaries never repeat the same bullet line twice in one reply", () => {
  const { reply } = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek jumbo zinger dedo", "ek gyro dedo"]);
  const bullets = reply.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(new Set(bullets).size, bullets.length);
});

test("professional grammar: replies never contain double spaces or stray punctuation artifacts", () => {
  const { reply } = say(createInitialContext(), "2 jumbo zinger");
  assert.equal(/  /.test(reply), false);
  assert.equal(/,,|\.\.|!!/.test(reply), false);
});

// ─── SHOW_MENU / SHOW_CART / PRICE_QUERY ─────────────────────────────────────

test("SHOW_MENU: full menu reply lists every category and every item with a price", () => {
  const { reply } = say(createInitialContext(), "menu dikhao");
  for (const cat of menu.categories) {
    assert.match(reply, new RegExp(cat.title.replace(/[()]/g, "\\$&")));
    for (const item of cat.items) {
      assert.match(reply, new RegExp(item.name.replace(/[()/]/g, "\\$&")));
    }
  }
  assertNoLeak(reply);
});

test("SHOW_CART: shows the current cart summary", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "mera cart dikhao");
  assert.match(reply, /Jumbo Zinger ×1/);
});

test("SHOW_CART: an empty cart reports it's empty rather than an empty summary block", () => {
  const { reply } = say(createInitialContext(), "mera cart dikhao");
  assert.equal(reply, EMPTY_CART_MESSAGE);
});

test("PRICE_QUERY: reports a specific item's price without any cart mutation", () => {
  const ctx = createInitialContext();
  const { ctx: after, reply } = say(ctx, "jumbo zinger ka rate kitne ka hai");
  assert.match(reply, /PKR 750/);
  assert.equal(after.cart.items.length, 0);
});

test("HYPOTHETICAL_TOTAL: responds without mutating the cart", () => {
  const { ctx: after, reply } = say(createInitialContext(), "agar add karun to total kitna hoga");
  assert.equal(after.cart.items.length, 0);
  assert.equal(reply.length > 0, true);
  assertNoLeak(reply);
});

// ─── Compound actions ─────────────────────────────────────────────────────────

test("compound action: 'remove everything and add 1 large pizza' gets one combined confirmation", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { reply } = say(ctx, "remove everything and add 1 large pizza");
  assert.match(reply, /cart update kar di gayi hai/);
  assert.match(reply, /Pizza Large 12 inch ×1/);
  assertNoLeak(reply);
});

// ─── Building blocks used directly (unit-level) ──────────────────────────────

test("buildOrderReviewReply includes the summary and confirm instruction directly", () => {
  const cart = cartOf({ itemId: "gyro", name: "Gyro", price: 550, qty: 1 });
  const reply = buildOrderReviewReply(cart, menu);
  assert.match(reply, /Gyro ×1/);
  assert.match(reply, /"Confirm Order"/);
});

test("buildFinalReviewReply for delivery vs pickup differ only in the delivery/type line", () => {
  const cart = cartOf({ itemId: "gyro", name: "Gyro", price: 550, qty: 1 });
  const pickupReply = buildFinalReviewReply(cart, menu, "pickup", undefined, "Bilal");
  const deliveryReply = buildFinalReviewReply(cart, menu, "delivery", "Some Address", "Bilal");
  assert.match(pickupReply, /Order Type: Pickup/);
  assert.match(deliveryReply, /Delivery Address: Some Address/);
});

test("PENDING_VERIFICATION_REPLY constant matches the exact required wording", () => {
  assert.match(PENDING_VERIFICATION_REPLY, /order receive kar liya gaya hai/);
  assert.match(PENDING_VERIFICATION_REPLY, /^.*Status: Pending Verification.*$/m);
  assert.match(PENDING_VERIFICATION_REPLY, /Hamari team jald aapse rabta karegi aur order confirm karegi/);
});

// ─── Never exposes internal identifiers even when things go wrong ───────────

test("no leakage: an ambiguous multi-candidate reply never lists raw item ids, only names", () => {
  const { reply } = say(createInitialContext(), "burger");
  assert.equal(/-burger|-zinger|-sandwich/.test(reply), false);
});

test("no leakage: parseResult/context objects are never stringified into a reply", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]).ctx;
  const { reply } = say(ctx, "House 45 Street 12 Nazimabad Karachi");
  assert.equal(/rawUserMessage|normalizedMessage|pendingClarification/.test(reply), false);
});

// ─── Additional add / mixed-category coverage ────────────────────────────────

test("add item: mixed-category cart (burger + pizza + rice) summary lists all three with correct totals", () => {
  const { reply } = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "1 large pizza", "ek chicken fried rice dedo"]);
  assert.match(reply, /Chicken Fried Rice ×1/);
  assert.match(reply, /Pizza Large 12 inch ×1/);
  assertNoLeak(reply);
});

test("add item: a large quantity renders correctly without overflow artifacts", () => {
  const { reply } = say(createInitialContext(), "50 pasta small dedo");
  assert.match(reply, /Pasta Small ×50 — PKR 25000/);
  assert.match(reply, /Total: PKR 25000/);
});

test("add item: adding the same item twice in a row merges into one line, not two", () => {
  const { reply } = driveMany(createInitialContext(), ["ek gyro dedo", "ek gyro dedo"]);
  assert.equal((reply.match(/Gyro ×/g) ?? []).length, 1);
  assert.match(reply, /Gyro ×2/);
});

// ─── Additional remove / replace coverage ────────────────────────────────────

test("remove: removing the only item in the cart still shows a coherent (empty) order context", () => {
  const ctx = driveMany(createInitialContext(), ["ek gyro dedo"]).ctx;
  const { reply } = say(ctx, "gyro remove karo");
  assert.match(reply, /Gyro cart se remove kar diya gaya hai/);
  assertNoLeak(reply);
});

test("replace: replacing into an item that already has its own cart line merges quantities in the summary", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "ek chicken steak dedo"]).ctx;
  const { reply } = say(ctx, "zinger hata kar steak add karo");
  assert.match(reply, /Chicken Steak ×2/);
  // The confirmation sentence also names the item, so check only the
  // summary's bullet lines for a genuine duplicate cart line.
  const bulletLines = reply.split("\n").filter((l) => l.startsWith("•"));
  const steakBullets = bulletLines.filter((l) => l.includes("Chicken Steak"));
  assert.equal(steakBullets.length, 1);
});

// ─── Additional checkout / delivery / pickup coverage ────────────────────────

test("checkout review: an empty-cart checkout attempt never produces an order review with an empty summary", () => {
  const { reply } = say(createInitialContext(), "checkout");
  assert.doesNotMatch(reply, /Order Review/);
});

test("delivery then pickup mid-flow switch updates the prompt correctly", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]).ctx;
  const { reply } = say(ctx, "pickup");
  assert.equal(reply, NAME_REQUEST_PROMPT);
});

test("pickup then delivery mid-flow switch prompts for the address again", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]).ctx;
  const { reply } = say(ctx, "delivery");
  assert.equal(reply, ADDRESS_REQUEST_PROMPT);
});

test("checkout interruption: editing the cart during AWAITING_ADDRESS returns to the order review reply", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery"]).ctx;
  const { reply } = say(ctx, "ek gyro dedo");
  assert.match(reply, /Updated Order/);
  assert.match(reply, /"Confirm Order"/);
});

// ─── Additional error coverage ────────────────────────────────────────────────

test("invalid quantity: decreasing a quantity to zero produces a professional rejection, not a crash", () => {
  const ctx = driveMany(createInitialContext(), ["2 jumbo zinger"]).ctx;
  const { reply } = say(ctx, "jumbo zinger ki quantity 0 kardo");
  assert.equal(reply, invalidQuantityMessage());
  assertNoLeak(reply);
});

test("unknown request: pure gibberish gets the generic unclear-request reply", () => {
  const { reply } = say(createInitialContext(), "asdkjaslkdj qqzz random");
  assert.equal(reply, unknownRequestMessage());
});

test("errors: every error/rejection message ends with proper punctuation", () => {
  const messages = [unavailableItemMessage("x"), itemNotInCartMessage("x"), unknownRequestMessage(), invalidQuantityMessage(), invalidReplacementMessage(), invalidCheckoutStepMessage()];
  for (const m of messages) assert.match(m, /[.?]$/);
});

// ─── Additional clarification coverage ───────────────────────────────────────

test("clarification: does not mutate the cart while awaiting a reply", () => {
  const { ctx } = say(createInitialContext(), "5 pizza");
  assert.equal(ctx.cart.items.length, 0);
});

test("clarification: an unresolved follow-up re-asks the same options rather than guessing", () => {
  const ctx = driveMany(createInitialContext(), ["5 pasta"]).ctx;
  const { reply } = say(ctx, "hmm not sure");
  assert.match(reply, /Aap kaunsa Pasta chahenge\?/);
});

// ─── Regression: cart-change acknowledgment while a DIFFERENT clarification
// stays pending must always name what actually happened, not just say
// "cart updated" ─────────────────────────────────────────────────────────
//
// Live QA bug: "vegetable rice remove kar kar do" while a Pizza
// clarification was still pending removed the item correctly, but the
// reply's first line said only "Aapki cart update kar di gayi hai" — never
// "Vegetable Rice" — because the confirmation builder for this specific
// multi-action case only ever checked ADDED lines.

test("regression: a pure remove while a different clarification is pending names the removed item, not a generic 'cart updated'", () => {
  const ctx = driveMany(createInitialContext(), ["ek vegetable rice dedo", "5 pizza"]).ctx;
  assert.equal(ctx.state, "AWAITING_CLARIFICATION");
  const { reply } = say(ctx, "vegetable rice remove kar do");
  assert.match(reply, /Vegetable Rice/);
  assert.doesNotMatch(reply, /Aapki cart update kar di gayi hai/);
  assert.match(reply, /Aap kaunsa Pizza chahenge\?/);
});

test("regression: a replace (remove+add in one turn) while a different clarification is pending names BOTH items", () => {
  const ctx = driveMany(createInitialContext(), ["ek gyro dedo", "5 pasta"]).ctx;
  assert.equal(ctx.state, "AWAITING_CLARIFICATION");
  const { reply } = say(ctx, "gyro hata kar steak add karo");
  assert.match(reply, /Chicken Steak/);
  assert.match(reply, /Gyro/);
});

// ─── Additional formatting / determinism coverage ────────────────────────────

test("formatting: restaurant info currency formatting matches the single approved format", () => {
  const reply = buildRestaurantInfoReply(restaurantConfig);
  assert.match(reply, /PKR 150/);
  assert.equal(/\$150|150PKR|PKRPKR/.test(reply), false);
});

test("deterministic: two independently-run identical conversations produce identical reply sequences", () => {
  const messages = ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"];
  const runReplies = () => {
    let ctx = createInitialContext();
    const out: string[] = [];
    for (const m of messages) {
      const step = say(ctx, m);
      ctx = step.ctx;
      out.push(step.reply);
    }
    return out;
  };
  assert.deepEqual(runReplies(), runReplies());
});

test("no leakage: a rejected replace never exposes the safety layer's internal reason text", () => {
  const { reply } = say(createInitialContext(), "sandwich hata kar steak add karo");
  assert.equal(/is not in the current cart|does not exist on the menu/.test(reply), false);
});

// ─── A few more direct edge cases ────────────────────────────────────────────

test("ASK_RESTAURANT_INFO reply never mutates the cart or the order state", () => {
  const ctx = driveMany(createInitialContext(), ["ek jumbo zinger dedo"]).ctx;
  const { ctx: after } = say(ctx, "restaurant ka number kya hai");
  assert.equal(after.state, ctx.state);
  assert.deepEqual(after.cart, ctx.cart);
});

test("SHOW_OPTIONS reply for an unavailable category gracefully says nothing was found", () => {
  const reply = buildCategoryOptionsReply("nonexistent", []);
  assert.match(reply, /koi item nahi mila/);
});

test("name request prompt and address request prompt are distinct strings", () => {
  assert.notEqual(NAME_REQUEST_PROMPT, ADDRESS_REQUEST_PROMPT);
});

test("buildOrderSummary custom heading is respected verbatim", () => {
  const cart = cartOf({ itemId: "gyro", name: "Gyro", price: 550, qty: 1 });
  const summary = buildOrderSummary(cart, menu, "My Custom Heading");
  assert.match(summary, /^My Custom Heading/);
});

test("formatCurrency rounds fractional totals rather than showing decimals", () => {
  assert.equal(formatCurrency(499.999), "PKR 500");
  assert.equal(formatCurrency(100.2), "PKR 100");
});
