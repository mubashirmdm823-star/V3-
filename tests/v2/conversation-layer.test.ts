// V2 Customer Conversation Layer tests — greetings, thanks, yes/no by
// state, wait/pause, cancel, human support, complaints, recommendations,
// small talk, irrelevant queries, confusion, help, goodbye, checkout
// interruption and continuation after a pause.
//
// Every conversation test drives the REAL pipeline (processCustomerMessage)
// per this repo's standing lesson; parser-level classification tests use
// the real parseMessage. Run with:
//   npx tsx --test tests/v2/conversation-layer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { IntentName } from "../../v2/types/parser";
import { Logger } from "../../v2/logger";
import { parseMessage } from "../../v2/intent-parser/parser";
import { createConversationContext, type ConversationContext } from "../../v2/core/context-manager";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { ProcessMessageResult } from "../../v2/core/result";
import { validateLLMResponse } from "../../v2/llm/json-validator";
import {
  GREETING_REPLY,
  THANKS_REPLY,
  GOODBYE_REPLY,
  SMALL_TALK_REPLY,
  IRRELEVANT_REDIRECT_REPLY,
  ORDER_CANCELLED_REPLY,
  NOTHING_TO_CANCEL_REPLY,
  buildHelpReply,
  pickPopularItems,
} from "../../v2/response-builder";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const EMPTY_CART = { items: [] };

let counter = 0;
async function drive(messages: string[]): Promise<{ conversation: ConversationContext; result: ProcessMessageResult }> {
  counter += 1;
  let conversation = createConversationContext(`conv-${counter}`, `conv-s-${counter}`);
  const logger = new Logger(`conv-s-${counter}`, `conv-${counter}`);
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

// Message sequences that put a fresh conversation into each checkout state.
const REACH_STATE: Record<string, string[]> = {
  CART_EDITING: ["2 Zinger Burger add karo"],
  ORDER_REVIEW: ["2 Zinger Burger add karo", "checkout"],
  AWAITING_DELIVERY_PICKUP: ["2 Zinger Burger add karo", "checkout", "confirm order"],
  AWAITING_ADDRESS: ["2 Zinger Burger add karo", "checkout", "confirm order", "delivery"],
  AWAITING_NAME: ["2 Zinger Burger add karo", "checkout", "confirm order", "pickup"],
  READY_TO_SUBMIT: ["2 Zinger Burger add karo", "checkout", "confirm order", "pickup", "Ahmed"],
};

function expectIntent(message: string, intent: IntentName): void {
  const r = parseMessage(message, EMPTY_CART, menu);
  assert.equal(r.intent, intent, `"${message}" parsed as ${r.intent}, expected ${intent}`);
  assert.equal(r.safetyDecision, "NO_CART_ACTION", `"${message}" safety was ${r.safetyDecision}`);
  assert.equal(r.actions.length, 0, `"${message}" produced cart actions`);
}

// ─── A. Greetings ────────────────────────────────────────────────────────────

const GREETING_VARIANTS = ["hello", "hi", "hey", "salam", "aoa", "assalam o alaikum", "assalamu alaikum", "Hello!"];
for (const msg of GREETING_VARIANTS) {
  test(`A. greeting "${msg}" -> GREETING, no cart action`, () => expectIntent(msg, "GREETING"));
}

test("A. greeting reply is the welcome message", async () => {
  const { result } = await drive(["salam"]);
  assert.equal(result.reply, GREETING_REPLY);
});

test("A. greeting never changes cart or state", async () => {
  const { conversation } = await drive(["hello"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "BROWSING");
});

test("A. greeting with an order attached still orders", async () => {
  const { conversation } = await drive(["salam, 2 zinger burger add karo"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

// ─── B. Thanks ───────────────────────────────────────────────────────────────

const THANKS_VARIANTS = ["thanks", "thank you", "shukriya", "bohat shukriya", "thnx", "jazakallah", "ty", "Thank You So Much"];
for (const msg of THANKS_VARIANTS) {
  test(`B. thanks "${msg}" -> THANKS, no cart action`, () => expectIntent(msg, "THANKS"));
}

test("B. thanks reply is polite and never the apology", async () => {
  const { result } = await drive(["shukriya"]);
  assert.equal(result.reply, THANKS_REPLY);
  assert.doesNotMatch(result.reply, /samajh nahi saka/);
});

test("B. thanks mid-order keeps cart and state exactly as they were", async () => {
  const { conversation } = await drive(["2 Zinger Burger add karo", "shukriya"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.equal(conversation.order.state, "CART_EDITING");
});

test("B. thanks mid-review does not confirm the order", async () => {
  const { conversation } = await drive([...REACH_STATE.ORDER_REVIEW, "thanks"]);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
});

// ─── C. YES in different states ──────────────────────────────────────────────

const YES_VARIANTS = ["yes", "haan", "han ji", "ji", "g", "theek hai", "ok", "bilkul", "zaroor", "yep"];
for (const msg of YES_VARIANTS) {
  test(`C. yes "${msg}" -> YES intent`, () => expectIntent(msg, "YES"));
}

test("C. YES at ORDER_REVIEW confirms the order", async () => {
  const { conversation } = await drive([...REACH_STATE.ORDER_REVIEW, "haan"]);
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
});

test("C. YES at ORDER_REVIEW replies with the delivery/pickup prompt", async () => {
  const { result } = await drive([...REACH_STATE.ORDER_REVIEW, "yes"]);
  assert.match(result.reply, /Delivery.*Pickup|Pickup.*Delivery/i);
});

test("C. YES at READY_TO_SUBMIT submits the order", async () => {
  const { conversation } = await drive([...REACH_STATE.READY_TO_SUBMIT, "haan"]);
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

test("C. YES at AWAITING_DELIVERY_PICKUP re-asks the choice instead of guessing", async () => {
  const { conversation, result } = await drive([...REACH_STATE.AWAITING_DELIVERY_PICKUP, "haan"]);
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
  assert.match(result.reply, /Delivery.*Pickup|Pickup.*Delivery/i);
});

test("C. YES while browsing invites an order without adding anything", async () => {
  const { conversation, result } = await drive(["haan"]);
  assert.deepEqual(cartOf(conversation), []);
  assert.equal(conversation.order.state, "BROWSING");
  assert.match(result.reply, /order|menu/i);
});

test("C. YES at AWAITING_ADDRESS re-prompts for the address", async () => {
  const { conversation, result } = await drive([...REACH_STATE.AWAITING_ADDRESS, "ok"]);
  assert.equal(conversation.order.state, "AWAITING_ADDRESS");
  assert.match(result.reply, /address/i);
});

test("C. YES never mutates the cart in any state", async () => {
  for (const reach of Object.values(REACH_STATE)) {
    const before = await drive(reach);
    const after = await drive([...reach, "haan"]);
    assert.deepEqual(cartOf(after.conversation), cartOf(before.conversation));
  }
});

// ─── D. NO in different states ───────────────────────────────────────────────

const NO_VARIANTS = ["no", "nahi", "nahin", "nope", "nahi chahiye", "no thanks"];
for (const msg of NO_VARIANTS) {
  test(`D. no "${msg}" -> NO intent`, () => expectIntent(msg, "NO"));
}

test("D. NO at ORDER_REVIEW declines without destroying anything", async () => {
  const { conversation, result } = await drive([...REACH_STATE.ORDER_REVIEW, "nahi"]);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.match(result.reply, /Confirm Order/i);
});

test("D. NO at READY_TO_SUBMIT does not submit", async () => {
  const { conversation, result } = await drive([...REACH_STATE.READY_TO_SUBMIT, "no"]);
  assert.equal(conversation.order.state, "READY_TO_SUBMIT");
  assert.match(result.reply, /Submit/i);
});

test("D. NO to a clarification question drops it cleanly", async () => {
  const { conversation, result } = await drive(["3 zinger", "nahi"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.equal(conversation.order.pendingClarification, undefined);
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /rehne dete|aur order/i);
});

test("D. NO while browsing is a polite no-op", async () => {
  const { conversation, result } = await drive(["nahi"]);
  assert.equal(conversation.order.state, "BROWSING");
  assert.deepEqual(cartOf(conversation), []);
  assert.match(result.reply, /koi masla nahi|bata dein/i);
});

test("D. order continues normally after a NO at review", async () => {
  const { conversation } = await drive([...REACH_STATE.ORDER_REVIEW, "nahi", "confirm order", "pickup", "Ahmed", "submit"]);
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

// ─── E. WAIT / ruko (pause + continuation) ───────────────────────────────────

const WAIT_VARIANTS = ["wait", "ruko", "ruk jao", "ek minute", "1 min", "baad mein", "hold on", "abhi nahi", "thora ruko"];
for (const msg of WAIT_VARIANTS) {
  test(`E. wait "${msg}" -> WAIT intent`, () => expectIntent(msg, "WAIT"));
}

for (const [state, reach] of Object.entries(REACH_STATE)) {
  test(`E. WAIT at ${state} pauses safely — state and cart preserved`, async () => {
    const { conversation, result } = await drive([...reach, "ruko"]);
    assert.equal(conversation.order.state, state);
    assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
    assert.match(result.reply, /aaram se|mehfooz|ready hon/i);
  });
}

test("E. checkout continues after a pause all the way to submission", async () => {
  const { conversation } = await drive([
    ...REACH_STATE.AWAITING_ADDRESS,
    "ruko",
    "House 12 Street 5 Nazimabad",
    "Ahmed",
    "submit",
  ]);
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
  assert.equal(conversation.order.address, "House 12 Street 5 Nazimabad");
});

test("E. a pause reply mentions the order is safe when the cart is non-empty", async () => {
  const { result } = await drive([...REACH_STATE.CART_EDITING, "ruko"]);
  assert.match(result.reply, /mehfooz/);
});

// ─── F. CANCEL_ORDER ─────────────────────────────────────────────────────────

const CANCEL_VARIANTS = ["cancel", "order cancel karo", "cancel kar do", "rehne do", "nahi mangwana"];
for (const msg of CANCEL_VARIANTS) {
  test(`F. cancel "${msg}" -> CANCEL_ORDER intent`, () => expectIntent(msg, "CANCEL_ORDER"));
}

for (const [state, reach] of Object.entries(REACH_STATE)) {
  test(`F. cancel at ${state} ends the order`, async () => {
    const { conversation, result } = await drive([...reach, "cancel karo"]);
    assert.equal(conversation.order.state, "CANCELLED");
    assert.equal(result.reply, ORDER_CANCELLED_REPLY);
  });
}

test("F. cancel with nothing to cancel is a polite no-op, never a dead-end", async () => {
  const { conversation, result } = await drive(["cancel"]);
  assert.equal(conversation.order.state, "BROWSING");
  assert.equal(result.reply, NOTHING_TO_CANCEL_REPLY);
});

test("F. ordering still works after a nothing-to-cancel", async () => {
  const { conversation } = await drive(["cancel", "2 Zinger Burger add karo"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

test("F. messages after cancellation get the finalized reply", async () => {
  const { result } = await drive([...REACH_STATE.ORDER_REVIEW, "cancel karo", "2 zinger burger add karo"]);
  assert.doesNotMatch(result.reply, /add kar diye/);
});

// ─── G. HUMAN_SUPPORT ────────────────────────────────────────────────────────

const HUMAN_VARIANTS = [
  "manager se baat karni hai", "kisi insan se baat karwao", "admin se baat karao",
  "mujhe call karo", "customer care ka number", "agent se milao", "kisi se baat karni hai",
];
for (const msg of HUMAN_VARIANTS) {
  test(`G. human support "${msg}" -> HUMAN_SUPPORT`, () => expectIntent(msg, "HUMAN_SUPPORT"));
}

test("G. escalation reply gives the real phone number and timing", async () => {
  const { result } = await drive(["manager se baat karni hai"]);
  assert.ok(result.reply.includes(restaurantConfig.phone));
  assert.ok(result.reply.includes(restaurantConfig.timing));
});

test("G. escalation mid-checkout preserves the order", async () => {
  const { conversation, result } = await drive([...REACH_STATE.AWAITING_ADDRESS, "manager se baat karni hai"]);
  assert.equal(conversation.order.state, "AWAITING_ADDRESS");
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.ok(result.reply.includes(restaurantConfig.phone));
});

// ─── H. COMPLAINT ────────────────────────────────────────────────────────────

const COMPLAINT_VARIANTS = [
  "mujhe complaint karni hai", "yeh shikayat hai meri", "pichla order thanda tha",
  "khana kharab tha", "order bohat late aya", "galat order aya tha", "bad service",
];
for (const msg of COMPLAINT_VARIANTS) {
  test(`H. complaint "${msg}" -> COMPLAINT`, () => expectIntent(msg, "COMPLAINT"));
}

test("H. complaint reply apologizes and offers help", async () => {
  const { result } = await drive(["pichla order thanda tha"]);
  assert.match(result.reply, /maazrat/);
  assert.match(result.reply, /madad/);
  assert.ok(result.reply.includes(restaurantConfig.phone));
});

test("H. complaint never touches the cart", async () => {
  const { conversation } = await drive(["2 Zinger Burger add karo", "khana kharab tha"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

// ─── I. RECOMMENDATION_REQUEST ───────────────────────────────────────────────

const RECOMMENDATION_VARIANTS = [
  "kya acha hai", "kuch recommend karo", "suggest karo kuch", "best kya hai aapke pass",
  "kya famous hai", "kuch acha sa batao", "what should i order", "sabse acha kya hai",
];
for (const msg of RECOMMENDATION_VARIANTS) {
  test(`I. recommendation "${msg}" -> RECOMMENDATION_REQUEST`, () => expectIntent(msg, "RECOMMENDATION_REQUEST"));
}

test("I. recommendation lists real popular items with real menu prices", async () => {
  const { result } = await drive(["kya acha hai"]);
  const picks = pickPopularItems(menu);
  assert.ok(picks.length >= 4);
  for (const item of picks) {
    assert.ok(result.reply.includes(item.name), `reply missing ${item.name}`);
    assert.ok(result.reply.includes(`PKR ${item.price}`), `reply missing price of ${item.name}`);
  }
});

test("I. recommendation never mutates the cart", async () => {
  const { conversation } = await drive(["kuch recommend karo"]);
  assert.deepEqual(cartOf(conversation), []);
});

test("I. ordering a recommended item right after works", async () => {
  const picks = pickPopularItems(menu);
  const { conversation } = await drive(["kya acha hai", `2 ${picks[0].name} add karo`]);
  assert.deepEqual(cartOf(conversation), [[picks[0].id, 2]]);
});

test("I. every popular pick actually exists on the menu", () => {
  const ids = new Set(menu.categories.flatMap((c) => c.items.map((i) => i.id)));
  for (const item of pickPopularItems(menu)) {
    assert.ok(ids.has(item.id));
  }
});

// ─── J. SMALL_TALK ───────────────────────────────────────────────────────────

const SMALL_TALK_VARIANTS = ["kya haal hai", "kaise ho", "how are you", "aap kaun ho", "who are you", "bot ho kya"];
for (const msg of SMALL_TALK_VARIANTS) {
  test(`J. small talk "${msg}" -> SMALL_TALK`, () => expectIntent(msg, "SMALL_TALK"));
}

test("J. small talk replies warmly and steers to the menu", async () => {
  const { result } = await drive(["kya haal hai"]);
  assert.equal(result.reply, SMALL_TALK_REPLY);
});

test("J. small talk mid-order changes nothing", async () => {
  const { conversation } = await drive(["2 Zinger Burger add karo", "kaise ho"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.equal(conversation.order.state, "CART_EDITING");
});

// ─── K. IRRELEVANT_QUERY ─────────────────────────────────────────────────────

const IRRELEVANT_VARIANTS = [
  "aaj mausam kaisa hai", "cricket match dekha", "koi achi movie batao",
  "news kya hai aaj ki", "bitcoin ka rate batao", "election kaun jeeta",
];
for (const msg of IRRELEVANT_VARIANTS) {
  test(`K. irrelevant "${msg}" -> IRRELEVANT_QUERY`, () => expectIntent(msg, "IRRELEVANT_QUERY"));
}

test("K. irrelevant query politely redirects to the menu", async () => {
  const { result } = await drive(["aaj mausam kaisa hai"]);
  assert.equal(result.reply, IRRELEVANT_REDIRECT_REPLY);
  assert.match(result.reply, /menu/i);
});

test("K. irrelevant query never mutates the cart", async () => {
  const { conversation } = await drive(["2 Zinger Burger add karo", "cricket match dekha"]);
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

// ─── L. CONFUSED_CUSTOMER ────────────────────────────────────────────────────

const CONFUSED_VARIANTS = [
  "mujhe samajh nahi aa raha", "kaise order karu", "order kaise karte hain",
  "main confuse ho gaya hun", "how do i order", "kuch samajh nahi aya",
];
for (const msg of CONFUSED_VARIANTS) {
  test(`L. confused "${msg}" -> CONFUSED_CUSTOMER`, () => expectIntent(msg, "CONFUSED_CUSTOMER"));
}

test("L. confused customer gets the simple Roman Urdu guide", async () => {
  const { result } = await drive(["kaise order karu"]);
  assert.equal(result.reply, buildHelpReply());
  assert.match(result.reply, /"menu" likhein/);
  assert.match(result.reply, /Zinger Burger add karo/);
  assert.match(result.reply, /checkout/);
});

// ─── M. HELP ─────────────────────────────────────────────────────────────────

const HELP_VARIANTS = ["help", "madad", "help karo", "madad chahiye", "help me"];
for (const msg of HELP_VARIANTS) {
  test(`M. help "${msg}" -> HELP`, () => expectIntent(msg, "HELP"));
}

test("M. help reply is the guide, and never the apology", async () => {
  const { result } = await drive(["help"]);
  assert.equal(result.reply, buildHelpReply());
  assert.doesNotMatch(result.reply, /samajh nahi saka/);
});

// ─── N. GOODBYE ──────────────────────────────────────────────────────────────

const GOODBYE_VARIANTS = ["bye", "goodbye", "allah hafiz", "khuda hafiz", "ok bye", "phir milenge"];
for (const msg of GOODBYE_VARIANTS) {
  test(`N. goodbye "${msg}" -> GOODBYE`, () => expectIntent(msg, "GOODBYE"));
}

test("N. goodbye closes politely", async () => {
  const { result } = await drive(["allah hafiz"]);
  assert.equal(result.reply, GOODBYE_REPLY);
});

test("N. goodbye does not finalize or destroy an in-progress order", async () => {
  const { conversation } = await drive([...REACH_STATE.CART_EDITING, "bye"]);
  assert.equal(conversation.order.state, "CART_EDITING");
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
});

// ─── O. Checkout interruption & continuation ─────────────────────────────────

test("O. a full checkout survives a barrage of conversational interruptions", async () => {
  const { conversation } = await drive([
    "salam",
    "kya acha hai",
    "2 Zinger Burger add karo",
    "shukriya",
    "checkout",
    "ruko",
    "haan",
    "kya haal hai",
    "delivery",
    "House 12 Street 5 Nazimabad",
    "Ahmed",
    "haan",
  ]);
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
  assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  assert.equal(conversation.order.customerName, "Ahmed");
});

test("O. thanks + goodbye after submission never resurrect the order", async () => {
  const { conversation } = await drive([...REACH_STATE.READY_TO_SUBMIT, "submit", "shukriya", "allah hafiz"]);
  assert.equal(conversation.order.state, "PENDING_VERIFICATION");
});

test("O. help mid-review answers, then confirm still works", async () => {
  const { conversation } = await drive([...REACH_STATE.ORDER_REVIEW, "help", "confirm order"]);
  assert.equal(conversation.order.state, "AWAITING_DELIVERY_PICKUP");
});

test("O. recommendation mid-cart-editing, then adding the pick, then checkout", async () => {
  const picks = pickPopularItems(menu);
  const target = picks.find((p) => p.id !== "zinger-burger")!;
  const { conversation } = await drive([
    ...REACH_STATE.CART_EDITING,
    "kuch recommend karo",
    `1 ${target.name} add karo`,
    "checkout",
  ]);
  assert.equal(conversation.order.state, "ORDER_REVIEW");
  assert.deepEqual(new Map(cartOf(conversation)), new Map([["zinger-burger", 2], [target.id, 1]]));
});

test("O. wait then cancel then a fresh order in one conversation is impossible after CANCELLED (terminal)", async () => {
  const { conversation } = await drive([...REACH_STATE.ORDER_REVIEW, "ruko", "cancel karo"]);
  assert.equal(conversation.order.state, "CANCELLED");
});

// ─── P. Safety sweep: conversational messages never mutate any cart state ───

const ALL_CONVERSATIONAL_MESSAGES = [
  "hello", "shukriya", "haan", "nahi", "ruko", "manager se baat karni hai",
  "pichla order thanda tha", "kya acha hai", "kya haal hai",
  "aaj mausam kaisa hai", "kaise order karu", "help", "bye",
];
for (const msg of ALL_CONVERSATIONAL_MESSAGES) {
  test(`P. "${msg}" never mutates a mid-checkout cart`, async () => {
    const { conversation } = await drive([...REACH_STATE.AWAITING_DELIVERY_PICKUP, msg]);
    assert.deepEqual(cartOf(conversation), [["zinger-burger", 2]]);
  });
}

// ─── Q. LLM contract for the conversation layer ──────────────────────────────

const NEW_INTENTS: IntentName[] = [
  "GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT",
  "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK",
  "IRRELEVANT_QUERY", "HELP", "GOODBYE",
];
for (const intent of NEW_INTENTS) {
  test(`Q. LLM JSON with intent ${intent} validates`, () => {
    const validation = validateLLMResponse(JSON.stringify({ intent, confidence: 0.95, items: [] }), menu);
    assert.equal(validation.ok, true, JSON.stringify(validation));
  });
}

test("Q. conversational replies never leak intent names or internals", async () => {
  for (const msg of ALL_CONVERSATIONAL_MESSAGES) {
    const { result } = await drive([msg]);
    for (const token of [...NEW_INTENTS, "NO_CART_ACTION", "safetyDecision"]) {
      assert.ok(!result.reply.includes(token), `"${msg}" reply leaks ${token}`);
    }
    assert.ok(result.reply.trim().length > 0);
    assert.ok(!/ {2}/.test(result.reply), `"${msg}" reply has a double space`);
  }
});

test("Q. every conversational reply is professional Roman Urdu/Hinglish (spot check)", async () => {
  const { result: thanks } = await drive(["thanks"]);
  const { result: waitR } = await drive(["ruko"]);
  const { result: irrelevant } = await drive(["cricket match dekha"]);
  for (const reply of [thanks.reply, waitR.reply, irrelevant.reply]) {
    assert.ok(reply.length > 20, "reply too short to be helpful");
  }
});
