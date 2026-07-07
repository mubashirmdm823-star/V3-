// QA phase 14A — the scenario library.
//
// A Scenario is a SEMANTIC plan ("add 2 of item X, then checkout, then
// interrupt at the address stage with another add"), never literal message
// text — qa/conversation-generator.ts renders each step into an actual
// message in the customer's own language/personality. Keeping scenarios
// semantic is what lets the same coverage matrix (every menu item, every
// alias, every checkout stage, every interruption point) be exercised in
// Roman Urdu, English, Hinglish, typo-heavy, emoji, and voice styles
// without duplicating the library per language.
//
// Tiers control how strictly qa/assertions.ts judges the outcome:
//   strict    — canonical phrasing the engine is DOCUMENTED to support
//               (proven by the existing v2 test suites). A miss is a bug.
//   natural   — realistic phrasing a human would type but the engine never
//               promised to support. A miss is recorded as an
//               understanding-rate weakness, not a bug — but a WRONG action
//               (different item added, wrong quantity) is still a bug.
//   corrupted — deliberately damaged text (typos/voice/spacing). Judged
//               like natural, with the target's whole token-family allowed.

import type { Menu, MenuItem, MenuCategory } from "../v2/types/menu";
import type { Rng } from "./randomizer";

export type Tier = "strict" | "natural" | "corrupted";

export type InfoTopic =
  | "address"
  | "timing"
  | "phone"
  | "delivery-fee"
  | "delivery-time"
  | "location";

export type QuantityStyle = "digit-prefix" | "urdu-word" | "english-word" | "x-suffix";

export type ScenarioStep =
  | { op: "greet" }
  | { op: "showMenu" }
  | { op: "browseCategory"; categoryKey: string }
  | { op: "price"; itemId: string }
  | { op: "add"; itemId: string; qty: number; tier: Tier; phraseOverride?: string; qtyStyle?: QuantityStyle }
  | { op: "addAmbiguous"; phrase: string; categoryKey: string; qty: number }
  | { op: "answerClarification"; itemId: string }
  | { op: "remove"; itemId: string; tier: Tier }
  | { op: "removeAll" }
  | { op: "replace"; fromItemId: string; toItemId: string; tier: Tier }
  | { op: "changeQty"; itemId: string; qty: number; tier: Tier }
  | { op: "showCart" }
  | { op: "checkout" }
  | { op: "confirm" }
  | { op: "delivery" }
  | { op: "pickup" }
  | { op: "address" }
  | { op: "name" }
  | { op: "submit" }
  | { op: "askInfo"; topic: InfoTopic }
  | { op: "complaint" }
  | { op: "chitchat" }
  | { op: "postSubmitMessage" }
  | { op: "invalid"; text: string };

export type ScenarioKind =
  | "single-item"
  | "single-item-alias"
  | "single-item-spelling"
  | "quantity-style"
  | "multi-item"
  | "huge-order"
  | "category-tour"
  | "price-query"
  | "checkout-interrupt"
  | "replace-flow"
  | "remove-flow"
  | "change-qty"
  | "remove-all"
  | "clarification-chain"
  | "info"
  | "invalid-input"
  | "off-topic"
  | "long-conversation"
  | "short-conversation"
  | "mixed-journey";

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  description: string;
  steps: ScenarioStep[];
}

// ---------------------------------------------------------------------------
// Aliases, abbreviations, and spelling variations (from the task's own
// examples plus real observed customer shorthand). All are exercised at the
// "natural" tier: the engine never promised to resolve "zngr", so failing to
// is a measured weakness — but resolving it to the WRONG item is a bug.
// ---------------------------------------------------------------------------

export interface AliasEntry {
  itemId: string;
  phrase: string;
  kind: "alias" | "spelling" | "shortform";
}

export const ALIAS_TABLE: readonly AliasEntry[] = [
  { itemId: "zinger-burger", phrase: "zngr burger", kind: "shortform" },
  { itemId: "zinger-burger", phrase: "zniger burger", kind: "spelling" },
  { itemId: "zinger-burger", phrase: "zinger brger", kind: "spelling" },
  { itemId: "jumbo-zinger", phrase: "jumbo zngr", kind: "shortform" },
  { itemId: "jumbo-zinger", phrase: "jambo zinger", kind: "spelling" },
  { itemId: "zinger-burger-w-c", phrase: "zinger w/c", kind: "alias" },
  { itemId: "chicken-sandwich", phrase: "chkn sandwich", kind: "shortform" },
  { itemId: "chicken-sandwich", phrase: "chicken sandwhich", kind: "spelling" },
  { itemId: "hot-shot-8-pcs-with-fries", phrase: "hotshot", kind: "alias" },
  { itemId: "hot-shot-8-pcs-with-fries", phrase: "hot shot", kind: "alias" },
  { itemId: "pizza-regular-9-inch", phrase: "piza regular", kind: "spelling" },
  { itemId: "pizza-large-12-inch", phrase: "12 inch pizza", kind: "alias" },
  { itemId: "pizza-small-6-inch", phrase: "6 inch pizza", kind: "alias" },
  { itemId: "chicken-chowmein", phrase: "chicken chowmin", kind: "spelling" },
  { itemId: "vegetable-chowmein", phrase: "veg chowmein", kind: "alias" },
  { itemId: "alfredo-pasta-white-sauce", phrase: "alfrdo pasta", kind: "spelling" },
  { itemId: "alfredo-pasta-white-sauce", phrase: "alfredo", kind: "alias" },
  { itemId: "macaroni-pasta-red-sauce", phrase: "macaroni", kind: "alias" },
  { itemId: "chicken-fried-rice", phrase: "fried rice", kind: "alias" },
  { itemId: "gyro", phrase: "gyro roll", kind: "alias" },
  { itemId: "chicken-steak", phrase: "steak", kind: "alias" },
  { itemId: "vegi-sandwich", phrase: "veg sandwich", kind: "alias" },
  { itemId: "singaporean-rice", phrase: "singaporian rice", kind: "spelling" },
  { itemId: "think-food-special-pizza", phrase: "special pizza", kind: "alias" },
  { itemId: "think-food-sp-burger", phrase: "sp burger", kind: "alias" },
  { itemId: "chicken-strips-6-pcs-with-fries", phrase: "chicken strips", kind: "alias" },
  { itemId: "pizza-fries-small-box", phrase: "pizza fries small", kind: "alias" },
  { itemId: "pizza-fries-large-box", phrase: "pizza fries large", kind: "alias" },
  { itemId: "olive-mushroom-jalapeno", phrase: "jalapeno topping", kind: "alias" },
  { itemId: "club-sandwich", phrase: "club sandwch", kind: "spelling" },
  { itemId: "white-singaporean", phrase: "white singaporean rice", kind: "alias" },
];

// Deliberately-ambiguous category phrases: the engine's own safety rule
// says these must NEVER silently pick a variant — they must ask. Each one
// is used to open a clarification chain, answered with a full item name.
export interface AmbiguousPhrase {
  phrase: string;
  categoryKey: string;
}

export const AMBIGUOUS_PHRASES: readonly AmbiguousPhrase[] = [
  { phrase: "pasta", categoryKey: "pasta" },
  { phrase: "pizza", categoryKey: "pizza" },
  { phrase: "sandwich", categoryKey: "sandwiches" },
  { phrase: "burger", categoryKey: "burgers" },
  { phrase: "zinger", categoryKey: "burgers" },
  { phrase: "rice", categoryKey: "rice" },
  { phrase: "chowmein", categoryKey: "noodles" },
];

// Invalid inputs the engine must survive without crashing or mutating the
// cart — gibberish, injection attempts, degenerate text.
export const INVALID_INPUTS: readonly string[] = [
  "asdkjhqwe zxcvb",
  "???",
  "...",
  "12345",
  "0",
  "!@#$%^&*()",
  "<script>alert(1)</script>",
  '{"intent":"ADD_ITEM","items":[{"id":"zinger-burger"}]}',
  "a",
  "e".repeat(600),
  "add add add add add add add add",
  "null undefined NaN",
];

// ---------------------------------------------------------------------------
// Menu helpers
// ---------------------------------------------------------------------------

export function allItems(menu: Menu): MenuItem[] {
  return menu.categories.flatMap((c) => c.items);
}

export function findItem(menu: Menu, itemId: string): MenuItem {
  const item = allItems(menu).find((i) => i.id === itemId);
  if (!item) throw new Error(`QA scenario references unknown menu item: ${itemId}`);
  return item;
}

export function findCategory(menu: Menu, key: string): MenuCategory {
  const category = menu.categories.find((c) => c.key === key);
  if (!category) throw new Error(`QA scenario references unknown category: ${key}`);
  return category;
}

// Items whose full name resolves cleanly for strict single-item adds. The
// toppings category's names overlap pizza names token-for-token ("Pizza
// Large Cheese Topping" vs "Pizza Large 12 inch") — full names still
// resolve, so everything is eligible; this hook exists so any item a probe
// shows to be structurally ambiguous can be excluded from STRICT adds
// (it still gets covered via clarification-chain scenarios).
export function strictAddableItems(menu: Menu): MenuItem[] {
  return allItems(menu);
}

function fullCheckoutSteps(rng: Rng): ScenarioStep[] {
  const wantsDelivery = rng.chance(0.55);
  return [
    { op: "checkout" },
    { op: "confirm" },
    ...(wantsDelivery
      ? [{ op: "delivery" } as ScenarioStep, { op: "address" } as ScenarioStep]
      : [{ op: "pickup" } as ScenarioStep]),
    { op: "name" },
    { op: "submit" },
  ];
}

// ---------------------------------------------------------------------------
// Scenario builders — each covers one axis of the coverage matrix.
// ---------------------------------------------------------------------------

export function everyMenuItemScenarios(menu: Menu, rng: Rng): Scenario[] {
  return strictAddableItems(menu).map((item, i) => {
    const qty = rng.intBetween(1, 3);
    const alsoCheckout = rng.chance(0.5);
    return {
      id: `single-item-${item.id}`,
      kind: "single-item",
      description: `Order ${qty} × ${item.name} by full name${alsoCheckout ? " and check out" : ""}`,
      steps: [
        { op: "add", itemId: item.id, qty, tier: "strict" },
        ...(i % 3 === 0 ? [{ op: "showCart" } as ScenarioStep] : []),
        ...(alsoCheckout ? fullCheckoutSteps(rng) : []),
      ],
    };
  });
}

export function aliasScenarios(menu: Menu, rng: Rng): Scenario[] {
  return ALIAS_TABLE.map((entry) => ({
    id: `alias-${entry.kind}-${entry.phrase.replace(/[^a-z0-9]+/gi, "-")}`,
    kind: entry.kind === "alias" ? "single-item-alias" : "single-item-spelling",
    description: `Order "${entry.phrase}" (${entry.kind} for ${entry.itemId})`,
    steps: [
      { op: "add", itemId: entry.itemId, qty: rng.intBetween(1, 2), tier: "natural", phraseOverride: entry.phrase },
    ],
  }));
}

export function quantityStyleScenarios(menu: Menu, rng: Rng): Scenario[] {
  const styles: readonly QuantityStyle[] = ["digit-prefix", "urdu-word", "english-word", "x-suffix"];
  const sampleItems = ["zinger-burger", "chicken-sandwich", "pizza-regular-9-inch", "chicken-fried-rice", "gyro", "chicken-chowmein"];
  const scenarios: Scenario[] = [];
  for (const style of styles) {
    for (const itemId of sampleItems) {
      const qty = rng.intBetween(1, 5);
      scenarios.push({
        id: `qty-style-${style}-${itemId}`,
        kind: "quantity-style",
        description: `Quantity style ${style}: ${qty} × ${itemId}`,
        steps: [
          {
            op: "add",
            itemId,
            qty,
            // All quantity styles are strict after fix pass 1: word
            // quantities (ek/do/teen/two/three...) and x-suffix forms are
            // now parsed globally.
            tier: "strict",
            qtyStyle: style,
          },
        ],
      });
    }
  }
  return scenarios;
}

export function multiItemScenarios(menu: Menu, rng: Rng): Scenario[] {
  const scenarios: Scenario[] = [];
  const items = strictAddableItems(menu);
  for (let i = 0; i < 12; i++) {
    const count = rng.intBetween(2, 4);
    const chosen = rng.shuffle(items).slice(0, count);
    scenarios.push({
      id: `multi-item-${i}`,
      kind: "multi-item",
      description: `Order ${count} different items across messages, then check out`,
      steps: [
        ...chosen.map((item): ScenarioStep => ({ op: "add", itemId: item.id, qty: rng.intBetween(1, 3), tier: "strict" })),
        { op: "showCart" },
        ...fullCheckoutSteps(rng),
      ],
    });
  }
  return scenarios;
}

export function hugeOrderScenarios(menu: Menu, rng: Rng): Scenario[] {
  const scenarios: Scenario[] = [];
  const items = strictAddableItems(menu);
  for (let i = 0; i < 4; i++) {
    const chosen = rng.shuffle(items).slice(0, rng.intBetween(10, 14));
    scenarios.push({
      id: `huge-order-${i}`,
      kind: "huge-order",
      description: `A ${chosen.length}-item order, one item per message, full checkout`,
      steps: [
        ...chosen.map((item): ScenarioStep => ({ op: "add", itemId: item.id, qty: rng.intBetween(1, 2), tier: "strict" })),
        { op: "showCart" },
        ...fullCheckoutSteps(rng),
      ],
    });
  }
  return scenarios;
}

export function categoryTourScenarios(menu: Menu, rng: Rng): Scenario[] {
  return menu.categories.map((category) => {
    const item = rng.pick(category.items);
    return {
      id: `category-tour-${category.key}`,
      kind: "category-tour",
      description: `Browse ${category.title}, ask a price, order from it`,
      steps: [
        { op: "browseCategory", categoryKey: category.key },
        { op: "price", itemId: item.id },
        { op: "add", itemId: item.id, qty: rng.intBetween(1, 2), tier: "strict" },
      ],
    };
  });
}

export function priceQueryScenarios(menu: Menu, rng: Rng): Scenario[] {
  const items = rng.shuffle(allItems(menu)).slice(0, 10);
  return items.map((item) => ({
    id: `price-query-${item.id}`,
    kind: "price-query",
    description: `Ask the price of ${item.name} without ordering`,
    steps: [{ op: "price", itemId: item.id }],
  }));
}

// Interrupt every checkout stage with a cart edit — the bounce-back-to-
// ORDER_REVIEW rule must hold at each of them.
export type InterruptStage = "ORDER_REVIEW" | "AWAITING_DELIVERY_PICKUP" | "AWAITING_ADDRESS" | "AWAITING_NAME" | "READY_TO_SUBMIT";

export function checkoutInterruptScenarios(menu: Menu, rng: Rng): Scenario[] {
  const stages: readonly InterruptStage[] = [
    "ORDER_REVIEW",
    "AWAITING_DELIVERY_PICKUP",
    "AWAITING_ADDRESS",
    "AWAITING_NAME",
    "READY_TO_SUBMIT",
  ];
  return stages.map((stage) => {
    const items = rng.shuffle(strictAddableItems(menu));
    const first = items[0];
    const extra = items[1];
    const stepsBefore: ScenarioStep[] = [{ op: "add", itemId: first.id, qty: rng.intBetween(1, 2), tier: "strict" }];
    const reach: ScenarioStep[] = [];
    if (stage !== "ORDER_REVIEW") reach.push({ op: "checkout" });
    else reach.push({ op: "checkout" });
    if (stage === "AWAITING_DELIVERY_PICKUP" || stage === "AWAITING_ADDRESS" || stage === "AWAITING_NAME" || stage === "READY_TO_SUBMIT") {
      reach.push({ op: "confirm" });
    }
    if (stage === "AWAITING_ADDRESS" || stage === "AWAITING_NAME" || stage === "READY_TO_SUBMIT") {
      reach.push({ op: "delivery" });
    }
    if (stage === "AWAITING_NAME" || stage === "READY_TO_SUBMIT") {
      reach.push({ op: "address" });
    }
    if (stage === "READY_TO_SUBMIT") {
      reach.push({ op: "name" });
    }
    return {
      id: `checkout-interrupt-${stage}`,
      kind: "checkout-interrupt",
      description: `Interrupt checkout at ${stage} with a cart edit, then finish the order`,
      steps: [
        ...stepsBefore,
        ...reach,
        { op: "add", itemId: extra.id, qty: 1, tier: "strict" }, // the interruption
        ...fullCheckoutSteps(rng), // re-confirm the whole updated order
      ],
    };
  });
}

export function replaceScenarios(menu: Menu, rng: Rng): Scenario[] {
  const scenarios: Scenario[] = [];
  const items = strictAddableItems(menu);
  for (let i = 0; i < 8; i++) {
    const [from, to] = rng.shuffle(items).slice(0, 2);
    scenarios.push({
      id: `replace-${i}-${from.id}-to-${to.id}`,
      kind: "replace-flow",
      description: `Add ${from.name}, replace it with ${to.name}`,
      steps: [
        { op: "add", itemId: from.id, qty: rng.intBetween(1, 2), tier: "strict" },
        { op: "replace", fromItemId: from.id, toItemId: to.id, tier: "strict" },
        { op: "showCart" },
      ],
    });
  }
  return scenarios;
}

export function removeScenarios(menu: Menu, rng: Rng): Scenario[] {
  const scenarios: Scenario[] = [];
  const items = strictAddableItems(menu);
  for (let i = 0; i < 8; i++) {
    const [a, b] = rng.shuffle(items).slice(0, 2);
    scenarios.push({
      id: `remove-${i}-${a.id}`,
      kind: "remove-flow",
      description: `Add ${a.name} and ${b.name}, remove ${a.name}`,
      steps: [
        { op: "add", itemId: a.id, qty: rng.intBetween(1, 2), tier: "strict" },
        { op: "add", itemId: b.id, qty: 1, tier: "strict" },
        { op: "remove", itemId: a.id, tier: "strict" },
        { op: "showCart" },
      ],
    });
  }
  return scenarios;
}

export function changeQtyScenarios(menu: Menu, rng: Rng): Scenario[] {
  const scenarios: Scenario[] = [];
  const items = strictAddableItems(menu);
  for (let i = 0; i < 6; i++) {
    const item = rng.pick(items);
    scenarios.push({
      id: `change-qty-${i}-${item.id}`,
      kind: "change-qty",
      description: `Add ${item.name}, then change its quantity`,
      steps: [
        { op: "add", itemId: item.id, qty: 1, tier: "strict" },
        { op: "changeQty", itemId: item.id, qty: rng.intBetween(2, 5), tier: "natural" },
      ],
    });
  }
  return scenarios;
}

export function removeAllScenarios(menu: Menu, rng: Rng): Scenario[] {
  const items = rng.shuffle(strictAddableItems(menu)).slice(0, 3);
  return [
    {
      id: "remove-all-basic",
      kind: "remove-all",
      description: "Fill the cart with 3 items, then clear it",
      steps: [
        ...items.map((item): ScenarioStep => ({ op: "add", itemId: item.id, qty: 1, tier: "strict" })),
        { op: "removeAll" },
        { op: "showCart" },
      ],
    },
  ];
}

export function clarificationChainScenarios(menu: Menu, rng: Rng): Scenario[] {
  return AMBIGUOUS_PHRASES.map((entry) => {
    const category = findCategory(menu, entry.categoryKey);
    // For the "zinger" family phrase only the three zinger burgers are
    // legitimate resolutions; picking any category item is fine otherwise.
    const options =
      entry.phrase === "zinger"
        ? category.items.filter((i) => i.name.toLowerCase().includes("zinger"))
        : category.items;
    const target = rng.pick(options);
    return {
      id: `clarification-${entry.phrase}`,
      kind: "clarification-chain",
      description: `Say just "${entry.phrase}" (ambiguous), answer the clarification with ${target.name}`,
      steps: [
        { op: "addAmbiguous", phrase: entry.phrase, categoryKey: entry.categoryKey, qty: rng.intBetween(1, 3) },
        { op: "answerClarification", itemId: target.id },
        { op: "showCart" },
      ],
    };
  });
}

export function infoScenarios(): Scenario[] {
  const topics: readonly InfoTopic[] = ["address", "timing", "phone", "delivery-fee", "delivery-time", "location"];
  return topics.map((topic) => ({
    id: `info-${topic}`,
    kind: "info",
    description: `Ask for restaurant info: ${topic}`,
    steps: [{ op: "askInfo", topic }],
  }));
}

export function invalidInputScenarios(): Scenario[] {
  return INVALID_INPUTS.map((text, i) => ({
    id: `invalid-${i}`,
    kind: "invalid-input",
    description: `Invalid input: ${JSON.stringify(text.slice(0, 40))}`,
    steps: [{ op: "invalid", text }],
  }));
}

export function offTopicScenarios(): Scenario[] {
  return [
    {
      id: "off-topic-chitchat",
      kind: "off-topic",
      description: "Pure chitchat, no order",
      steps: [{ op: "greet" }, { op: "chitchat" }],
    },
    {
      id: "off-topic-complaint",
      kind: "off-topic",
      description: "A complaint about a previous order",
      steps: [{ op: "complaint" }],
    },
  ];
}

export function longConversationScenarios(menu: Menu, rng: Rng): Scenario[] {
  const items = rng.shuffle(strictAddableItems(menu));
  const [a, b, c] = items;
  return [
    {
      id: "long-conversation",
      kind: "long-conversation",
      description: "A 14+ turn journey: browse, ask, add, edit, interrupt, finish",
      steps: [
        { op: "greet" },
        { op: "showMenu" },
        { op: "browseCategory", categoryKey: rng.pick(menu.categories).key },
        { op: "price", itemId: a.id },
        { op: "add", itemId: a.id, qty: rng.intBetween(1, 2), tier: "strict" },
        { op: "askInfo", topic: "delivery-time" },
        { op: "add", itemId: b.id, qty: 1, tier: "strict" },
        { op: "showCart" },
        { op: "remove", itemId: a.id, tier: "strict" },
        { op: "add", itemId: c.id, qty: 1, tier: "strict" },
        ...fullCheckoutSteps(rng),
        { op: "postSubmitMessage" },
      ],
    },
  ];
}

export function shortConversationScenarios(menu: Menu, rng: Rng): Scenario[] {
  const item = rng.pick(strictAddableItems(menu));
  return [
    {
      id: "short-conversation",
      kind: "short-conversation",
      description: "The fastest possible order: add, checkout, done",
      steps: [
        { op: "add", itemId: item.id, qty: 1, tier: "strict" },
        { op: "checkout" },
        { op: "confirm" },
        { op: "pickup" },
        { op: "name" },
        { op: "submit" },
      ],
    },
  ];
}

// A randomized realistic journey — fills the bulk of the 20k run.
export function mixedJourneyScenario(menu: Menu, rng: Rng, index: number): Scenario {
  const items = rng.shuffle(strictAddableItems(menu));
  const steps: ScenarioStep[] = [];
  if (rng.chance(0.4)) steps.push({ op: "greet" });
  if (rng.chance(0.2)) steps.push({ op: "showMenu" });
  if (rng.chance(0.2)) steps.push({ op: "browseCategory", categoryKey: rng.pick(menu.categories).key });
  if (rng.chance(0.25)) steps.push({ op: "askInfo", topic: rng.pick(["address", "timing", "phone", "delivery-fee", "delivery-time", "location"] as const) });

  const addCount = rng.intBetween(1, 3);
  for (let i = 0; i < addCount; i++) {
    steps.push({ op: "add", itemId: items[i].id, qty: rng.intBetween(1, 3), tier: "strict" });
  }
  if (rng.chance(0.25)) steps.push({ op: "remove", itemId: items[0].id, tier: "strict" });
  if (rng.chance(0.15)) steps.push({ op: "replace", fromItemId: items[addCount - 1].id, toItemId: items[addCount].id, tier: "strict" });
  if (rng.chance(0.3)) steps.push({ op: "showCart" });

  // A journey that removed its only item can't check out — top the cart up.
  if (rng.chance(0.7)) {
    steps.push({ op: "add", itemId: items[addCount + 1].id, qty: 1, tier: "strict" });
    steps.push(...fullCheckoutSteps(rng));
    if (rng.chance(0.2)) steps.push({ op: "postSubmitMessage" });
  }

  return {
    id: `mixed-journey-${index}`,
    kind: "mixed-journey",
    description: "Randomized realistic customer journey",
    steps,
  };
}

// ---------------------------------------------------------------------------
// The simulation plan: which scenario + personality + language each of the
// N conversations runs. Guarantees every quota in the task, then fills the
// remainder with randomized mixed journeys.
// ---------------------------------------------------------------------------

export interface PlanEntry {
  scenario: Scenario;
  archetype?: string; // forced personality (quota buckets); random otherwise
  language?: "roman-urdu" | "english" | "hinglish" | "mixed"; // forced language
  quotaBucket?: string; // which quota this entry satisfies (for coverage stats)
}

export function buildSimulationPlan(menu: Menu, totalConversations: number, rng: Rng): PlanEntry[] {
  const plan: PlanEntry[] = [];

  // Quotas are sized for the full 20,000-conversation production run and
  // scale down proportionally (never below 1) so a small smoke run (e.g.
  // the test suite's 300) still samples every bucket.
  const scale = Math.min(1, totalConversations / 20000);

  // 1. Coverage sweeps — every menu item, alias, category, quantity style,
  //    interruption stage, replacement, removal, clarification, info topic,
  //    invalid input. Repeated a few times so each also runs under several
  //    different personalities.
  const sweeps: Scenario[] = [
    ...everyMenuItemScenarios(menu, rng),
    ...aliasScenarios(menu, rng),
    ...quantityStyleScenarios(menu, rng),
    ...multiItemScenarios(menu, rng),
    ...hugeOrderScenarios(menu, rng),
    ...categoryTourScenarios(menu, rng),
    ...priceQueryScenarios(menu, rng),
    ...checkoutInterruptScenarios(menu, rng),
    ...replaceScenarios(menu, rng),
    ...removeScenarios(menu, rng),
    ...changeQtyScenarios(menu, rng),
    ...removeAllScenarios(menu, rng),
    ...clarificationChainScenarios(menu, rng),
    ...infoScenarios(),
    ...invalidInputScenarios(),
    ...offTopicScenarios(),
    ...longConversationScenarios(menu, rng),
    ...shortConversationScenarios(menu, rng),
  ];
  const sweepRepeats = scale >= 0.75 ? 3 : 1;
  const sweepPool = scale >= 0.05 ? sweeps : rng.shuffle(sweeps).slice(0, Math.max(20, Math.floor(sweeps.length * scale * 20)));
  for (let repeat = 0; repeat < sweepRepeats; repeat++) {
    for (const scenario of sweepPool) {
      plan.push({ scenario, quotaBucket: "coverage-sweep" });
    }
  }

  // 2. Explicit quota buckets from the task (500 each at full scale).
  const QUOTA = Math.max(1, Math.round(500 * scale));
  const languageBuckets = [
    { bucket: "roman-urdu", language: "roman-urdu" as const },
    { bucket: "english", language: "english" as const },
    { bucket: "hinglish", language: "hinglish" as const },
    { bucket: "mixed", language: "mixed" as const },
  ];
  for (const { bucket, language } of languageBuckets) {
    for (let i = 0; i < QUOTA; i++) {
      plan.push({ scenario: mixedJourneyScenario(menu, rng, plan.length), language, quotaBucket: bucket });
    }
  }
  const archetypeBuckets = [
    { bucket: "typo-heavy", archetype: "bad-spelling" },
    { bucket: "voice-style", archetype: "voice-typing" },
    { bucket: "emoji", archetype: "emoji-heavy" },
  ];
  for (const { bucket, archetype } of archetypeBuckets) {
    for (let i = 0; i < QUOTA; i++) {
      plan.push({ scenario: mixedJourneyScenario(menu, rng, plan.length), archetype, quotaBucket: bucket });
    }
  }
  const scenarioBuckets: Array<{ bucket: string; make: () => Scenario }> = [
    { bucket: "checkout-interruptions", make: () => rng.pick(checkoutInterruptScenarios(menu, rng)) },
    { bucket: "replace-flows", make: () => rng.pick(replaceScenarios(menu, rng)) },
    { bucket: "remove-flows", make: () => rng.pick(removeScenarios(menu, rng)) },
    { bucket: "clarification-chains", make: () => rng.pick(clarificationChainScenarios(menu, rng)) },
    { bucket: "long-conversations", make: () => longConversationScenarios(menu, rng)[0] },
    { bucket: "short-conversations", make: () => shortConversationScenarios(menu, rng)[0] },
  ];
  for (const { bucket, make } of scenarioBuckets) {
    for (let i = 0; i < QUOTA; i++) {
      plan.push({ scenario: make(), quotaBucket: bucket });
    }
  }

  // 3. Every personality archetype gets a dedicated slice.
  const PERSONALITY_QUOTA = Math.max(1, Math.round(100 * scale));
  const personalities = [
    "fast-typer", "slow-typer", "roman-urdu", "english", "hinglish", "mixed-language",
    "old-customer", "first-time-customer", "confused-customer", "angry-customer",
    "polite-customer", "emoji-heavy", "voice-typing", "bad-spelling",
    "very-short-messages", "very-long-messages", "mind-changer",
    "checkout-interrupter", "question-asker", "spacing-mistakes", "shortform-heavy",
  ];
  for (const archetype of personalities) {
    for (let i = 0; i < PERSONALITY_QUOTA; i++) {
      plan.push({ scenario: mixedJourneyScenario(menu, rng, plan.length), archetype, quotaBucket: `personality-${archetype}` });
    }
  }

  // 4. Fill the remainder with randomized mixed journeys.
  while (plan.length < totalConversations) {
    plan.push({ scenario: mixedJourneyScenario(menu, rng, plan.length), quotaBucket: "mixed-journey-fill" });
  }

  // Deterministic shuffle so buckets interleave (a crash at conversation N
  // shouldn't mean an entire bucket was never reached). For very small smoke
  // runs the fixed buckets can exceed the requested total — the shuffle
  // makes the truncation an even sample rather than dropping whole buckets.
  return rng.shuffle(plan).slice(0, totalConversations);
}
