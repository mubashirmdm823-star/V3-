// Golden Conversation Test Runner (Production Stabilization Mode).
//
// Drives every scenario in tests/golden-conversations/*.json through the
// REAL local V3 engine entry point (v3/agent/index.ts#processAgentMessage)
// — never the UI, never a real network call. Same "no real providers"
// convention as every other tests/v3/*.test.ts file: the AI Gateway's
// fetch is replaced with a scripted, deterministic fake that returns a
// fixed JSON plan for each known customer message, so a run is 100%
// reproducible and needs no API keys.
//
// Why a scripted lookup table, not a generic fake NLU: the golden JSON
// fixtures intentionally contain only customer text + expected backend
// facts (see schema.ts) — no per-message "what should the model draft"
// field. A generic fake parser risks silently misclassifying an intent in
// a way that's hard to notice. A table keyed by the exact, small (~90),
// enumerated set of messages actually used across the suite is fully
// transparent and auditable: every fake "model turn" below is a concrete,
// plausible draft a real LLM could produce for that exact message — the
// REAL backend (actions.ts/clarification-engine.ts/fact-verifier.ts/
// correct-reply.ts/reply-orchestrator.ts) still does all the actual
// resolution, correction, and fact-verification work, exactly as it would
// for a real provider response. Several entries below deliberately script
// a "bad" draft (a false claim, an intro-only menu line, a guessed item
// variant) specifically so the real backend's correction logic is
// genuinely exercised, not just its happy path.
//
// This file is test infrastructure only — it does not change, and must
// never change, any v3/agent/, v2/, or v1 production file.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import menuData from "../../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { getClarificationQueue } from "../../v2/order-state-engine/clarification";
import { createAgentSession, type AgentSession } from "../../v3/agent/context";
import { processAgentMessage, resetCooldown } from "../../v3/agent/index";

import type { GoldenExpected, GoldenScenario } from "./schema";
import { DEFAULT_FORBIDDEN_TERMS } from "./schema";

const menu = menuData as Menu;
const restaurantConfig = restaurantConfigData as RestaurantConfig;
const FAKE_ENV = { LLM_PROVIDER: "google-ai", GOOGLE_API_KEY: "fake-key-for-tests" };

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Scenario loading ───────────────────────────────────────────────────────

export function loadGoldenScenarios(): GoldenScenario[] {
  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const scenarios: GoldenScenario[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const raw = readFileSync(join(__dirname, file), "utf8");
    const parsed = JSON.parse(raw) as GoldenScenario[];
    for (const scenario of parsed) {
      if (seenIds.has(scenario.id)) {
        throw new Error(`Duplicate golden scenario id "${scenario.id}" (found in ${file})`);
      }
      seenIds.add(scenario.id);
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

// ─── Scripted fake-model plans ──────────────────────────────────────────────
//
// Keyed by the exact customer message text, trimmed and lower-cased for
// lookup only (the ORIGINAL, as-authored message text is still what's
// actually sent to processAgentMessage).

interface ScriptedPlan {
  reply: string;
  cartActions?: unknown[];
  checkoutAction?: unknown;
  recommendationRequest?: unknown;
}

function addItem(query: string, quantity?: number) {
  return quantity ? { type: "add_item", query, quantity } : { type: "add_item", query };
}
function addMultiple(items: { query: string; quantity?: number }[]) {
  return { type: "add_multiple_items", items };
}
function removeItem(query: string) {
  return { type: "remove_item", query };
}
function replaceItem(fromQuery: string, toQuery: string) {
  return { type: "replace_item", fromQuery, toQuery };
}
function changeQuantity(query: string, quantity: number) {
  return { type: "change_quantity", query, quantity };
}
function checkout(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}
function recommend(theme: string) {
  return { theme };
}

const SCRIPTED_PLANS: Record<string, ScriptedPlan> = {
  "ek zinger burger add karo": { reply: "Zinger Burger add ho gaya!", cartActions: [addItem("zinger burger", 1)] },
  "3 zinger burger add karo": { reply: "3 Zinger Burger add ho gaye!", cartActions: [addItem("zinger burger", 3)] },
  "ek zinger burger aur ek pizza small 6 inch add karo": {
    reply: "Zinger Burger aur Pizza Small add ho gaye!",
    cartActions: [addMultiple([{ query: "zinger burger", quantity: 1 }, { query: "pizza small 6 inch", quantity: 1 }])],
  },
  "ek dragon roll add karo": { reply: "Ek Dragon Roll add kar raha hoon.", cartActions: [addItem("dragon roll", 1)] },
  "zinger burger hata do": { reply: "Zinger Burger hata diya.", cartActions: [removeItem("zinger burger")] },
  "ek pizza small 6 inch add karo": { reply: "Pizza Small add ho gaya!", cartActions: [addItem("pizza small 6 inch", 1)] },
  "ek jumbo zinger add karo": { reply: "Jumbo Zinger add ho gaya!", cartActions: [addItem("jumbo zinger", 1)] },
  "zinger hata do": { reply: "Zinger hata diya.", cartActions: [removeItem("zinger")] },
  "zinger burger ki jagah jumbo zinger kar do": {
    reply: "Zinger Burger ki jagah Jumbo Zinger kar diya.",
    cartActions: [replaceItem("zinger burger", "jumbo zinger")],
  },
  "ek pasta small add karo": { reply: "Pasta Small add ho gaya!", cartActions: [addItem("pasta small", 1)] },
  "zinger burger 3 kar do": { reply: "Zinger Burger quantity 3 kar di.", cartActions: [changeQuantity("zinger burger", 3)] },
  "order dikhao": { reply: "Dekhte hain." },
  "do pasta small add karo": { reply: "2 Pasta Small add ho gaye!", cartActions: [addItem("pasta small", 2)] },
  "mera order": { reply: "Order dekh rahe hain." },
  "kitna total hua": { reply: "Total calculate kar rahe hain." },
  "bill kitna hai": { reply: "Bill nikal rahe hain." },
  ok: { reply: "Theek hai!", cartActions: [addItem("zinger burger", 1)] },
  thanks: { reply: "Aapka shukriya!", cartActions: [addItem("zinger burger", 1)] },
  "ek chowmein add karo": { reply: "Ek Chowmein add kar raha hoon.", cartActions: [addItem("chowmein", 1)] },
  chicken: { reply: "Chicken Chowmein add ho gaya!", cartActions: [addItem("chicken", 1)] },
  checkout: { reply: "Chaliye checkout karte hain!", checkoutAction: checkout("start_checkout") },
  "confirm order": { reply: "Confirm ho gaya!", checkoutAction: checkout("confirm_order") },
  delivery: { reply: "Delivery select ho gaya. Meherbani karke apna address batayein.", checkoutAction: checkout("select_delivery") },
  pickup: { reply: "Pickup select ho gaya. Meherbani karke apna naam batayein.", checkoutAction: checkout("select_pickup") },
  "house 12, street 4, gulshan-e-iqbal, karachi": {
    reply: "Address save ho gaya.",
    checkoutAction: checkout("save_address", { address: "House 12, Street 4, Gulshan-e-Iqbal, Karachi" }),
  },
  yes: { reply: "Address save ho gaya: yes", checkoutAction: checkout("save_address", { address: "yes" }) },
  "ali khan": { reply: "Naam save ho gaya.", checkoutAction: checkout("save_customer_name", { name: "Ali Khan" }) },
  help: { reply: "Aapka naam Help save ho gaya!", checkoutAction: checkout("save_customer_name", { name: "Help" }) },
  confirm: { reply: "Order confirm!", checkoutAction: checkout("confirm_order") },
  "ek chowmein bhi add karo": { reply: "Chowmein bhi add kar diya!", cartActions: [addItem("chowmein", 1)] },
  "mujhe ek pasta chahiye": { reply: "Kaunsa pasta chahiye?", cartActions: [addItem("pasta", 1)] },
  small: { reply: "Small add ho gaya.", cartActions: [addItem("small", 1)] },
  alfredo: { reply: "Alfredo add ho gaya.", cartActions: [addItem("alfredo", 1)] },
  vegetable: { reply: "Vegetable Chowmein add ho gaya.", cartActions: [addItem("vegetable", 1)] },
  "ek zinger kardo": { reply: "Kaunsa zinger chahiye?", cartActions: [addItem("zinger", 1)] },
  jumbo: { reply: "Jumbo Zinger add ho gaya.", cartActions: [addItem("jumbo", 1)] },
  "w/c wala": { reply: "Zinger Burger W/C add ho gaya.", cartActions: [addItem("w/c wala", 1)] },
  "burger chahiye": { reply: "Kaunsa burger chahiye?", cartActions: [addItem("burger", 1)] },
  "smoke burger": { reply: "Smoke Burger add ho gaya.", cartActions: [addItem("smoke burger", 1)] },
  mexican: { reply: "Kaunsa mexican item?", cartActions: [addItem("mexican", 1)] },
  "zinger burger": { reply: "Zinger Burger add ho gaya.", cartActions: [addItem("zinger burger", 1)] },
  "mujhe ek pasta aur ek chowmein chahiye": {
    reply: "Kaunsa pasta aur kaunsa chowmein chahiye?",
    cartActions: [addMultiple([{ query: "pasta", quantity: 1 }, { query: "chowmein", quantity: 1 }])],
  },
  "pasta small chowmein chicken": {
    reply: "Theek hai!",
    cartActions: [addMultiple([{ query: "pasta small", quantity: 1 }, { query: "chicken", quantity: 1 }])],
  },
  "cricket match kaisa raha aaj": { reply: "Haha, acha chal raha hai! Waise aap order karna chahenge?" },
  "aapka service bohat slow hai": { reply: "Maazrat chahte hain, hum behtar karne ki koshish karenge." },
  "mujhe samajh nahi aa raha kya karoon": { reply: "Koi baat nahi, main madad karta hoon — menu dekhna chahenge ya kuch order karna chahenge?" },
  "🍔🍕😋": { reply: "😋 Kuch order karna chahenge?" },
  "hi bhai kaise ho umeed hai acha hoga mujhe aik zinger burger chahiye aur haan ek pasta small bhi de dena shukriya": {
    reply: "Zinger Burger aur Pasta Small add ho gaye!",
    cartActions: [addMultiple([{ query: "zinger burger", quantity: 1 }, { query: "pasta small", quantity: 1 }])],
  },
  "can you please add one zinger burger aur ek chowmein chicken wala": {
    reply: "Added!",
    cartActions: [addMultiple([{ query: "zinger burger", quantity: 1 }, { query: "chicken chowmein", quantity: 1 }])],
  },
  "asdkjaslkdj qwoeiqwoe zxcvzxcv": { reply: "Maazrat, samajh nahi aaya. Aap menu dekhna chahenge?" },
  "ek zinger burger aur ek pasta small add karo": {
    reply: "Zinger Burger aur Pasta Small add ho gaye!",
    cartActions: [addMultiple([{ query: "zinger burger", quantity: 1 }, { query: "pasta small", quantity: 1 }])],
  },
  "zinger burger hata do aur ek jumbo zinger add kar do": {
    reply: "Zinger Burger hata ke Jumbo Zinger add kar diya!",
    cartActions: [removeItem("zinger burger"), addItem("jumbo zinger", 1)],
  },
  hi: { reply: "Hi! Think Food mein khushamdeed. Hamara menu dekhna chahenge?" },
  hello: { reply: "Hello! Welcome to Think Food. Would you like to see the menu?" },
  hey: { reply: "Hey! Kaise help karoon?" },
  salam: { reply: "Walaikum Salam! Kaise madad karoon?" },
  "assalam o alaikum": { reply: "Walaikum Assalam! Khushamdeed." },
  "hello there, is this think food?": { reply: "Hello! Yes, this is Think Food. Kaise madad karoon?" },
  menu: { reply: "Sure, here's our menu!" },
  "hi, menu dikhao": { reply: "Hi! Yahan hamara menu hai." },
  "menu please": { reply: "Sure, here's our full menu for you!" },
  "full menu": { reply: "Poora menu yeh hai." },
  "show menu": { reply: "Menu dikha rahe hain." },
  "view menu": { reply: "Yahan menu hai." },
  "kya kya hai": { reply: "Hamare paas yeh sab hai." },
  "kia kia available hai": { reply: "Hamare paas yeh available hai." },
  "pizza menu dikhao": { reply: "Pizza Menu." },
  "burgers dikhao": { reply: "Burgers." },
  "pasta menu batao": { reply: "Pasta." },
  "ab sirf burgers dikhao": { reply: "Burgers dikha rahe hain." },
  "hey what do you guys offer around here": { reply: "We have a great menu! Let me know if you have questions." },
  "mujhe kuch acha sa suggest karo": { reply: "Yeh try karein!", recommendationRequest: recommend("popular") },
  "kuch spicy suggest karo": { reply: "Spicy chahiye? Yeh try karein!", recommendationRequest: recommend("spicy") },
  "hot and spicy ma kuch batao mujhe": { reply: "Backend aapko spicy items dikha dega." },
  "sabse popular item kya hai": { reply: "Yeh popular hai!", recommendationRequest: recommend("popular") },
  "bachon ke liye kuch batao": { reply: "Bachon ke liye yeh acha hai!", recommendationRequest: recommend("kids") },
  "vegetarian options batao": { reply: "Vegetarian options yeh hain!", recommendationRequest: recommend("vegetarian") },
  "burger ke ilawa kya spicy hai": { reply: "Yeh try karein!", recommendationRequest: recommend("spicy") },
  "spicy ma": { reply: "Spicy Stuff Burger try karein!", recommendationRequest: recommend("spicy") },
  "burgers ke ilawa kia hai spicy ma": { reply: "Spicy Stuff Burger try karein!", recommendationRequest: recommend("spicy") },
  "ye to burger hai na iske ilawa kuch nahi hai spicy ma": { reply: "Spicy Stuff Burger hi try karein.", recommendationRequest: recommend("spicy") },
  "haan spicy stuff burger add kar do": { reply: "Spicy Stuff Burger add ho gaya!", cartActions: [addItem("Spicy Stuff Burger", 1)] },
  "kahan hai current order": { reply: "Hamara address yeh hai." },
  "kahan hai": { reply: "Hamara address yeh hai." },
  "aapka number kya hai": { reply: "Yeh raha number." },
  "aap kitne baje tak khule hain": { reply: "Yeh hamari timing hai." },
  "delivery mein kitna time lagta hai": { reply: "Yeh delivery time hai." },
  "delivery charges kitne hain": { reply: "Yeh delivery charges hain." },
  "mera order kahan dikhega": { reply: "Aapka order yahan dikhega." },
  "aapki dukan kahan hai": { reply: "Hamara address yeh hai." },
};

function lookupKey(message: string): string {
  return message.trim().toLowerCase();
}

function planFor(message: string): ScriptedPlan {
  const key = lookupKey(message);
  const plan = SCRIPTED_PLANS[key];
  if (!plan) {
    throw new Error(
      `No scripted plan for golden-conversation message: "${message}" (lookup key "${key}"). ` +
        `Add an entry to SCRIPTED_PLANS in run-golden.ts.`
    );
  }
  return plan;
}

function googleJsonResponse(text: string): Response {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) } as unknown as Response;
}

function scriptedFetchFor(message: string): FetchLike {
  const plan = planFor(message);
  const body = JSON.stringify({
    reply: plan.reply,
    cartActions: plan.cartActions ?? [],
    pendingClarifications: [],
    checkoutAction: plan.checkoutAction ?? null,
    recommendationRequest: plan.recommendationRequest ?? null,
  });
  return (async () => googleJsonResponse(body)) as unknown as FetchLike;
}

// ─── Driving a scenario through the real V3 engine ─────────────────────────

export interface GoldenTranscriptTurn {
  message: string;
  reply: string;
}

export interface GoldenRunOutcome {
  scenario: GoldenScenario;
  transcript: GoldenTranscriptTurn[];
  finalReply: string;
  finalCart: { name: string; quantity: number; price: number }[];
  finalTotal: number;
  finalState: string;
  pendingClarificationCount: number;
  failures: string[];
}

async function driveScenario(scenario: GoldenScenario): Promise<GoldenRunOutcome> {
  resetCooldown();
  let session: AgentSession = createAgentSession(scenario.id, scenario.id);
  const transcript: GoldenTranscriptTurn[] = [];

  for (const message of scenario.messages) {
    const result = await processAgentMessage(session, message, menu, restaurantConfig, {
      fetchImpl: scriptedFetchFor(message),
      env: FAKE_ENV,
    });
    session = result.session;
    transcript.push({ message, reply: result.reply });
  }

  const cart = session.conversation.order.cart;
  const finalCart = cart.items.map((line) => ({ name: line.name, quantity: line.qty, price: line.price }));
  const finalTotal = calculateTotal(cart, menu).subtotal;
  const finalState = session.conversation.order.state;
  const pendingClarificationCount = getClarificationQueue(session.conversation.order).length;
  const finalReply = transcript.length > 0 ? transcript[transcript.length - 1].reply : "";

  const failures = evaluateExpectations(scenario.expected, transcript, finalReply, finalCart, finalTotal, finalState);

  return { scenario, transcript, finalReply, finalCart, finalTotal, finalState, pendingClarificationCount, failures };
}

// ─── Assertions ─────────────────────────────────────────────────────────────

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cartLinesMatch(actual: { name: string; quantity: number }[], expected: { name: string; quantity: number }[]): boolean {
  const norm = (lines: { name: string; quantity: number }[]) =>
    [...lines].map((l) => `${l.name}::${l.quantity}`).sort().join("|");
  return norm(actual) === norm(expected);
}

function evaluateExpectations(
  expected: GoldenExpected,
  transcript: GoldenTranscriptTurn[],
  finalReply: string,
  finalCart: { name: string; quantity: number; price: number }[],
  finalTotal: number,
  finalState: string
): string[] {
  const failures: string[] = [];

  if (expected.mustContain) {
    for (const term of expected.mustContain) {
      if (!containsCaseInsensitive(finalReply, term)) {
        failures.push(`mustContain failed: expected final reply to contain "${term}"`);
      }
    }
  }

  if (expected.mustNotContain) {
    for (const term of expected.mustNotContain) {
      if (containsCaseInsensitive(finalReply, term)) {
        failures.push(`mustNotContain failed: final reply must not contain "${term}"`);
      }
    }
  }

  const forbidden = expected.forbiddenTerms ?? DEFAULT_FORBIDDEN_TERMS;
  for (const term of forbidden) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    for (const turn of transcript) {
      if (pattern.test(turn.reply)) {
        failures.push(`forbiddenTerms failed: reply to "${turn.message}" leaked forbidden term "${term}"`);
      }
    }
  }

  if (expected.cart) {
    const actualLines = finalCart.map((l) => ({ name: l.name, quantity: l.quantity }));
    const expectedLines = expected.cart.map((l) => ({ name: l.name, quantity: l.quantity }));
    if (!cartLinesMatch(actualLines, expectedLines)) {
      failures.push(
        `cart mismatch: expected ${JSON.stringify(expectedLines)}, got ${JSON.stringify(actualLines)}`
      );
    }
  }

  if (expected.total !== undefined && expected.total !== finalTotal) {
    failures.push(`total mismatch: expected ${expected.total}, got ${finalTotal}`);
  }

  if (expected.state !== undefined && expected.state !== finalState) {
    failures.push(`state mismatch: expected "${expected.state}", got "${finalState}"`);
  }

  return failures;
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function runAllGoldenScenarios(): Promise<GoldenRunOutcome[]> {
  const scenarios = loadGoldenScenarios();
  const outcomes: GoldenRunOutcome[] = [];
  for (const scenario of scenarios) {
    outcomes.push(await driveScenario(scenario));
  }
  return outcomes;
}

// ─── CLI report ──────────────────────────────────────────────────────────────

function printFailureReport(outcome: GoldenRunOutcome): void {
  console.log("─".repeat(70));
  console.log(`✖ FAILED: ${outcome.scenario.id} — ${outcome.scenario.title}`);
  console.log("  Transcript:");
  for (const turn of outcome.transcript) {
    console.log(`    customer: ${turn.message}`);
    console.log(`    reply:    ${turn.reply.replace(/\n/g, "\n              ")}`);
  }
  console.log(`  Final reply: ${outcome.finalReply}`);
  console.log(`  Final cart:  ${JSON.stringify(outcome.finalCart)}`);
  console.log(`  Final state: ${outcome.finalState}`);
  console.log("  Failures:");
  for (const f of outcome.failures) console.log(`    - ${f}`);
}

async function main(): Promise<void> {
  const outcomes = await runAllGoldenScenarios();
  const failed = outcomes.filter((o) => o.failures.length > 0);
  const passed = outcomes.length - failed.length;

  for (const outcome of failed) printFailureReport(outcome);

  console.log("=".repeat(70));
  console.log(`Golden Conversation Suite: ${outcomes.length} total, ${passed} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log("Failed scenario ids:", failed.map((o) => o.scenario.id).join(", "));
  }

  process.exitCode = failed.length > 0 ? 1 : 0;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
