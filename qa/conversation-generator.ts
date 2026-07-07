// QA phase 14A — conversation generator.
//
// Renders a semantic Scenario (qa/scenario-library.ts) into an actual
// message-by-message conversation in one specific customer's voice
// (qa/customer-generator.ts): their language picks the phrase template,
// their personality injects noise turns (questions between items, changed
// minds, checkout interruptions), and their corruption style damages the
// final text (typos/emoji/voice/spacing).
//
// Tier discipline (what keeps the assertion layer honest):
// - A template marked "strict" below is one the engine's own existing test
//   suites prove; if a clean render of it misses, that's a bug.
// - The moment a turn is corrupted or decorated with personality filler,
//   its tier is DEMOTED (strict -> corrupted/natural) — we never blame the
//   engine for text we deliberately damaged, but we still catch it doing
//   something actively WRONG with that text (wrong item, wrong quantity).
// - Identity turns (address/name) are never corrupted: the engine is
//   REQUIRED to store what the customer typed, so damaging those turns
//   would only test our own corruption code.

import type { Menu } from "../v2/types/menu";
import { significantTokens } from "../v2/intent-parser/matching";
import restaurantConfigData from "../v2/data/restaurant-config.json" with { type: "json" };
import { Rng, corruptMessage } from "./randomizer";
import {
  CUSTOMER_ADDRESSES,
  CUSTOMER_NAMES,
  customerForArchetype,
  generateCustomer,
  withLanguage,
  type CustomerProfile,
  type Language,
} from "./customer-generator";
import {
  allItems,
  findCategory,
  findItem,
  type InfoTopic,
  type PlanEntry,
  type Scenario,
  type ScenarioKind,
  type ScenarioStep,
  type Tier,
} from "./scenario-library";
import type { TurnExpectation } from "./assertions";

export interface PlannedTurn {
  message: string;
  expectation: TurnExpectation;
}

export interface GeneratedConversation {
  id: string;
  seed: number;
  scenarioId: string;
  scenarioKind: ScenarioKind;
  quotaBucket?: string;
  personality: string;
  language: Language;
  turns: PlannedTurn[];
}

interface Template {
  id: string;
  language: Language;
  tier: Tier;
  render: (vars: Record<string, string>) => string;
}

function t(id: string, language: Language, tier: Tier, pattern: string): Template {
  return {
    id,
    language,
    tier,
    render: (vars) => pattern.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Template pools. tier values here were verified against the real pipeline
// with a probe run (see v2/README.md phase 14A notes): "strict" templates
// landed 100% across sampled menu items; everything else is "natural".
// ---------------------------------------------------------------------------

const ADD_TEMPLATES: readonly Template[] = [
  t("ru-add-karo", "roman-urdu", "strict", "{qty} {item} add karo"),
  t("ru-add-kar-do", "roman-urdu", "strict", "{qty} {item} add kar do"),
  t("ru-add-dedo", "roman-urdu", "strict", "{qty} {item} dedo"),
  t("en-add", "english", "strict", "add {qty} {item}"),
  // Promoted after fix pass 1: conversational noise ("i want", "bhai") no
  // longer poisons the add as an unavailable item.
  t("en-want", "english", "strict", "i want {qty} {item}"),
  t("en-please", "english", "natural", "{qty} {item} please"),
  t("hg-add-please", "hinglish", "strict", "{qty} {item} add karo please"),
  t("hg-bhai-add", "hinglish", "strict", "bhai {qty} {item} add kar do"),
];

const ADD_QTY1_TEMPLATES: readonly Template[] = [
  t("ru-ek-dedo", "roman-urdu", "strict", "ek {item} dedo"),
  t("en-one", "english", "natural", "one {item} please"),
];

const REMOVE_TEMPLATES: readonly Template[] = [
  t("ru-hata-do", "roman-urdu", "strict", "{item} hata do"),
  t("ru-remove-kar-do", "roman-urdu", "strict", "{item} remove kar do"),
  t("en-remove", "english", "strict", "remove {item}"),
  t("hg-remove-yaar", "hinglish", "natural", "yaar {item} hatado"),
];

// All five variants verified working after fix pass 1 (the parser's
// REPLACE_PATTERNS now extracts source+target from each form).
const REPLACE_TEMPLATES: readonly Template[] = [
  t("ru-hata-kar", "roman-urdu", "strict", "{from} hata kar {to} add karo"),
  t("ru-ki-jagah", "roman-urdu", "strict", "{from} ki jagah {to} kar do"),
  t("ru-ke-bajaye", "roman-urdu", "strict", "{from} ke bajaye {to}"),
  t("en-replace-with", "english", "strict", "replace {from} with {to}"),
  t("en-change-to", "english", "strict", "change {from} to {to}"),
];

const CHANGE_QTY_TEMPLATES: readonly Template[] = [
  t("ru-quantity-kar-do", "roman-urdu", "natural", "{item} ki quantity {qty} kar do"),
  t("ru-item-n-kar-do", "roman-urdu", "natural", "{item} {qty} kar do"),
  t("en-make-qty", "english", "natural", "make {item} quantity {qty}"),
];

const REMOVE_ALL_TEMPLATES: readonly Template[] = [
  t("en-clear-cart", "english", "strict", "clear cart"),
  // Fixed in fix pass 1: "khali kar" is now a clear-cart trigger.
  t("ru-cart-khali", "roman-urdu", "strict", "cart khali kar do"),
  t("ru-sab-hata-do", "roman-urdu", "natural", "sab kuch hata do"),
];

const SHOW_CART_TEMPLATES: readonly Template[] = [
  t("ru-cart-dikhao", "roman-urdu", "strict", "cart dikhao"),
  t("en-show-cart", "english", "strict", "show my cart"),
  t("hg-mera-order", "hinglish", "natural", "mera order kya bana ab tak"),
];

const SHOW_MENU_TEMPLATES: readonly Template[] = [
  t("ru-menu-dikhao", "roman-urdu", "strict", "menu dikhao"),
  t("en-show-menu", "english", "strict", "show menu"),
  t("ru-menu-bhejo", "roman-urdu", "natural", "menu bhej dein"),
];

const BROWSE_TEMPLATES: readonly Template[] = [
  t("ru-cat-dikhao", "roman-urdu", "strict", "{category} dikhao"),
  t("en-cat-show", "english", "natural", "show me the {category}"),
  t("hg-cat-options", "hinglish", "natural", "{category} mein kya options hain"),
];

const PRICE_TEMPLATES: readonly Template[] = [
  t("ru-price-kya-hai", "roman-urdu", "strict", "{item} ki price kya hai"),
  t("ru-kitne-ka", "roman-urdu", "natural", "{item} kitne ka hai"),
  // Fixed in fix pass 1: "how much" is a price word now — never an ADD.
  t("en-how-much", "english", "strict", "how much is {item}"),
];

const GREET_TEMPLATES: readonly Template[] = [
  t("greet-salam", "roman-urdu", "natural", "salam"),
  t("greet-aoa", "roman-urdu", "natural", "assalam o alaikum"),
  t("greet-hello", "english", "natural", "hello"),
  t("greet-hi", "english", "natural", "hi"),
];

const CHECKOUT_TEMPLATES: readonly Template[] = [
  t("checkout-plain", "english", "strict", "checkout"),
  t("checkout-place-order", "english", "strict", "place order"),
  t("checkout-ru", "roman-urdu", "strict", "order place kardo"),
  t("checkout-bs-yehi", "roman-urdu", "natural", "bs yehi order hai"),
];

const CONFIRM_TEMPLATES: readonly Template[] = [
  t("confirm-order", "english", "strict", "confirm order"),
  t("confirm-haan", "roman-urdu", "strict", "haan confirm"),
  t("confirm-kar-do", "roman-urdu", "strict", "confirm kar do"),
];

const DELIVERY_TEMPLATES: readonly Template[] = [
  t("delivery-plain", "english", "strict", "delivery"),
  t("delivery-chahiye", "roman-urdu", "natural", "delivery chahiye"),
  t("delivery-home", "english", "natural", "home delivery kar do"),
];

const PICKUP_TEMPLATES: readonly Template[] = [
  t("pickup-plain", "english", "strict", "pickup"),
  t("pickup-khud", "roman-urdu", "natural", "main khud le lunga"),
];

const NAME_TEMPLATES: readonly Template[] = [
  t("name-bare", "english", "strict", "{name}"),
  t("name-mera-naam", "roman-urdu", "strict", "mera naam {name} hai"),
  t("name-my-name-is", "english", "strict", "my name is {name}"),
];

const SUBMIT_TEMPLATES: readonly Template[] = [
  t("submit-plain", "english", "strict", "submit"),
  t("submit-final", "english", "strict", "final submit"),
  t("submit-yes", "english", "strict", "yes submit"),
  t("submit-done", "english", "strict", "done"),
];

const AMBIGUOUS_TEMPLATES: readonly Template[] = [
  t("ambig-qty-phrase", "roman-urdu", "strict", "{qty} {phrase}"),
  t("ambig-dedo", "roman-urdu", "strict", "{phrase} dedo"),
  t("ambig-chahiye", "roman-urdu", "natural", "{qty} {phrase} chahiye"),
];

const ANSWER_TEMPLATES: readonly Template[] = [
  t("answer-full-name", "english", "strict", "{item}"),
  t("answer-wala", "roman-urdu", "natural", "{item} wala"),
];

const COMPLAINT_TEMPLATES: readonly Template[] = [
  t("complaint-ru", "roman-urdu", "natural", "pichli baar order thanda mila tha, dhyan rakhna"),
  t("complaint-en", "english", "natural", "my last order was cold and late"),
];

const CHITCHAT_TEMPLATES: readonly Template[] = [
  t("chit-haal", "roman-urdu", "natural", "kya haal hai"),
  t("chit-match", "roman-urdu", "natural", "aaj match dekha aapne"),
  t("chit-how", "english", "natural", "how are you doing"),
];

const POST_SUBMIT_TEMPLATES: readonly Template[] = [
  t("post-thanks", "roman-urdu", "natural", "shukriya"),
  t("post-thank-you", "english", "natural", "thank you"),
  t("post-how-long", "roman-urdu", "natural", "kitni der lagegi"),
];

// Per-topic info phrasings + facts the reply must contain (from the real
// restaurant-config.json — imported, not duplicated).
// All phrasings below verified answering from restaurant-config.json after
// fix pass 1 (info detection now runs before price/delivery classification
// and covers the location/timing/fee/time vocabulary).
const INFO_PHRASES: Record<InfoTopic, { templates: Template[]; facts: string[] }> = {
  address: {
    templates: [
      t("info-address-kahan", "roman-urdu", "strict", "restaurant kahan hai"),
      t("info-address-en", "english", "strict", "where are you located"),
      t("info-address-batao", "roman-urdu", "strict", "address batao"),
    ],
    facts: [restaurantConfigData.address],
  },
  timing: {
    templates: [
      t("info-timing-kya", "roman-urdu", "strict", "timing kya hai"),
      t("info-timing-en", "english", "strict", "what are your timings"),
      t("info-timing-open", "roman-urdu", "strict", "kitne baje tak open hain"),
    ],
    facts: [restaurantConfigData.timing],
  },
  phone: {
    templates: [
      t("info-phone-number", "roman-urdu", "strict", "aapka phone number kya hai"),
      t("info-phone-en", "english", "strict", "what is your contact number"),
    ],
    facts: [restaurantConfigData.phone],
  },
  "delivery-fee": {
    templates: [
      t("info-fee-charges", "roman-urdu", "strict", "delivery charges kitne hain"),
      t("info-fee-en", "english", "strict", "what is the delivery fee"),
    ],
    facts: [String(restaurantConfigData.deliveryFee)],
  },
  "delivery-time": {
    templates: [
      t("info-time-kitna", "roman-urdu", "strict", "delivery mein kitna time lagta hai"),
      t("info-time-en", "english", "strict", "how long does delivery take"),
    ],
    facts: [restaurantConfigData.deliveryTime, "35"],
  },
  location: {
    templates: [
      t("info-location-bhejo", "roman-urdu", "strict", "location bhej dein"),
      t("info-maps-link", "english", "strict", "send me the maps link"),
    ],
    facts: [restaurantConfigData.address, "maps"],
  },
};

const URDU_QTY_WORDS = ["", "ek", "do", "teen", "char", "panch"];
const ENGLISH_QTY_WORDS = ["", "one", "two", "three", "four", "five"];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pickTemplate(pool: readonly Template[], language: Language, rng: Rng, preferStrict: boolean): Template {
  const effectiveLanguage: Language = language === "mixed" ? rng.pick(["roman-urdu", "english", "hinglish"] as const) : language;
  const inLanguage = pool.filter((tpl) => tpl.language === effectiveLanguage);
  const candidates = inLanguage.length > 0 ? inLanguage : [...pool];
  if (preferStrict) {
    const strictOnes = candidates.filter((tpl) => tpl.tier === "strict");
    if (strictOnes.length > 0) return rng.pick(strictOnes);
    const strictAnywhere = pool.filter((tpl) => tpl.tier === "strict");
    if (strictAnywhere.length > 0) return rng.pick(strictAnywhere);
  }
  return rng.pick(candidates);
}

// Items whose names share a significant token with the query text — the
// "not actively wrong" resolution set for loose-tier adds.
function tokenFamily(menu: Menu, texts: string[]): string[] {
  const queryTokens = new Set(texts.flatMap((text) => significantTokens(text.toLowerCase())));
  return allItems(menu)
    .filter((item) => significantTokens(item.name.toLowerCase()).some((tok) => queryTokens.has(tok)))
    .map((item) => item.id);
}

interface RenderedTurn {
  message: string;
  templateId: string;
  tier: Tier;
}

function decorate(message: string, profile: CustomerProfile, rng: Rng): { message: string; decorated: boolean } {
  let out = message;
  let decorated = false;
  if (profile.verbosity === "very-long" || (profile.verbosity === "long" && rng.chance(0.4))) {
    out = rng.pick(["bhai ", "sir ", ""]) + out + rng.pick([" please", " yaar", ""]);
    decorated = out !== message;
  }
  if (profile.politeness === "polite" && rng.chance(0.4)) {
    out = out + " please";
    decorated = true;
  }
  if (profile.politeness === "rude" && rng.chance(0.3)) {
    out = out + " jaldi karo";
    decorated = true;
  }
  return { message: out, decorated };
}

// Ops whose text is identity data — never corrupted, never decorated.
const PROTECTED_OPS: ReadonlySet<ScenarioStep["op"]> = new Set(["address", "name", "invalid"]);

function renderStep(
  step: ScenarioStep,
  profile: CustomerProfile,
  rng: Rng,
  menu: Menu
): { turn: RenderedTurn; expectation: TurnExpectation } {
  const language = profile.language;
  let rendered: RenderedTurn;
  let expectation: TurnExpectation;

  switch (step.op) {
    case "add": {
      const item = findItem(menu, step.itemId);
      const phrase = step.phraseOverride ?? item.name;
      let template: Template;
      let vars: Record<string, string>;
      if (step.qtyStyle === "urdu-word" && step.qty <= 5) {
        template = t(`qty-urdu-word`, "roman-urdu", step.tier, "{qty} {item} add kar do");
        vars = { qty: URDU_QTY_WORDS[step.qty], item: phrase };
      } else if (step.qtyStyle === "english-word" && step.qty <= 5) {
        template = t(`qty-english-word`, "english", step.tier, "add {qty} {item}");
        vars = { qty: ENGLISH_QTY_WORDS[step.qty], item: phrase };
      } else if (step.qtyStyle === "x-suffix") {
        template = t(`qty-x-suffix`, "english", step.tier, "{item} x{qty}");
        vars = { qty: String(step.qty), item: phrase };
      } else if (step.qty === 1 && rng.chance(0.3)) {
        template = pickTemplate(ADD_QTY1_TEMPLATES, language, rng, step.tier === "strict");
        vars = { item: phrase };
      } else {
        template = pickTemplate(ADD_TEMPLATES, language, rng, step.tier === "strict");
        vars = { qty: String(step.qty), item: phrase };
      }
      // A step can't be stricter than its template; an alias/misspelled
      // phrase can't be strict no matter the template.
      const tier: Tier =
        step.phraseOverride || template.tier !== "strict" ? (step.tier === "strict" ? "natural" : step.tier) : step.tier;
      rendered = { message: template.render(vars), templateId: template.id, tier };
      expectation = {
        op: "add",
        tier,
        templateId: template.id,
        language,
        itemId: step.itemId,
        qty: step.qty,
        allowedItemIds: tokenFamily(menu, [phrase, item.name]),
        ...(step.phraseOverride ? { phrase: step.phraseOverride } : {}),
      };
      break;
    }

    case "addAmbiguous": {
      const template = pickTemplate(AMBIGUOUS_TEMPLATES, language, rng, true);
      const tier = template.tier;
      rendered = {
        message: template.render({ qty: String(step.qty), phrase: step.phrase }),
        templateId: template.id,
        tier,
      };
      expectation = {
        op: "addAmbiguous",
        tier,
        templateId: template.id,
        language,
        phrase: step.phrase,
        qty: step.qty,
        categoryKey: step.categoryKey,
      };
      break;
    }

    case "answerClarification": {
      const item = findItem(menu, step.itemId);
      const template = pickTemplate(ANSWER_TEMPLATES, language, rng, true);
      rendered = { message: template.render({ item: item.name }), templateId: template.id, tier: template.tier };
      expectation = { op: "answerClarification", tier: template.tier, templateId: template.id, language, itemId: step.itemId };
      break;
    }

    case "remove": {
      const item = findItem(menu, step.itemId);
      const template = pickTemplate(REMOVE_TEMPLATES, language, rng, step.tier === "strict");
      const tier: Tier = template.tier === "strict" ? step.tier : "natural";
      rendered = { message: template.render({ item: item.name }), templateId: template.id, tier };
      expectation = { op: "remove", tier, templateId: template.id, language, itemId: step.itemId };
      break;
    }

    case "removeAll": {
      const template = pickTemplate(REMOVE_ALL_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "removeAll", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "replace": {
      const from = findItem(menu, step.fromItemId);
      const to = findItem(menu, step.toItemId);
      const template = pickTemplate(REPLACE_TEMPLATES, language, rng, step.tier === "strict");
      const tier: Tier = template.tier === "strict" ? step.tier : "natural";
      rendered = { message: template.render({ from: from.name, to: to.name }), templateId: template.id, tier };
      expectation = { op: "replace", tier, templateId: template.id, language, fromItemId: step.fromItemId, toItemId: step.toItemId };
      break;
    }

    case "changeQty": {
      const item = findItem(menu, step.itemId);
      const template = pickTemplate(CHANGE_QTY_TEMPLATES, language, rng, false);
      rendered = { message: template.render({ item: item.name, qty: String(step.qty) }), templateId: template.id, tier: "natural" };
      expectation = { op: "changeQty", tier: "natural", templateId: template.id, language, itemId: step.itemId, qty: step.qty };
      break;
    }

    case "showCart": {
      const template = pickTemplate(SHOW_CART_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "showCart", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "showMenu": {
      const template = pickTemplate(SHOW_MENU_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "showMenu", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "browseCategory": {
      const category = findCategory(menu, step.categoryKey);
      const template = pickTemplate(BROWSE_TEMPLATES, language, rng, false);
      rendered = { message: template.render({ category: category.title }), templateId: template.id, tier: template.tier };
      expectation = { op: "browseCategory", tier: template.tier, templateId: template.id, language, categoryKey: step.categoryKey };
      break;
    }

    case "price": {
      const item = findItem(menu, step.itemId);
      const template = pickTemplate(PRICE_TEMPLATES, language, rng, true);
      rendered = { message: template.render({ item: item.name }), templateId: template.id, tier: template.tier };
      expectation = {
        op: "price",
        tier: template.tier,
        templateId: template.id,
        language,
        itemId: step.itemId,
        replyMustContainOneOf: [String(item.price)],
      };
      break;
    }

    case "greet": {
      const template = pickTemplate(GREET_TEMPLATES, language, rng, false);
      rendered = { message: template.render({}), templateId: template.id, tier: "natural" };
      expectation = { op: "greet", tier: "natural", templateId: template.id, language };
      break;
    }

    case "checkout": {
      const template = pickTemplate(CHECKOUT_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "checkout", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "confirm": {
      const template = pickTemplate(CONFIRM_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "confirm", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "delivery": {
      const template = pickTemplate(DELIVERY_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "delivery", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "pickup": {
      const template = pickTemplate(PICKUP_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "pickup", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "address": {
      const address = rng.pick(CUSTOMER_ADDRESSES);
      rendered = { message: address, templateId: "address-real", tier: "strict" };
      expectation = { op: "address", tier: "strict", templateId: "address-real", language, sentText: address };
      break;
    }

    case "name": {
      const name = rng.pick(CUSTOMER_NAMES);
      const template = pickTemplate(NAME_TEMPLATES, language, rng, true);
      rendered = { message: template.render({ name }), templateId: template.id, tier: template.tier };
      expectation = { op: "name", tier: template.tier, templateId: template.id, language, sentText: name };
      break;
    }

    case "submit": {
      const template = pickTemplate(SUBMIT_TEMPLATES, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = { op: "submit", tier: template.tier, templateId: template.id, language };
      break;
    }

    case "askInfo": {
      const entry = INFO_PHRASES[step.topic];
      const template = pickTemplate(entry.templates, language, rng, true);
      rendered = { message: template.render({}), templateId: template.id, tier: template.tier };
      expectation = {
        op: "askInfo",
        tier: template.tier,
        templateId: template.id,
        language,
        infoTopic: step.topic,
        replyMustContainOneOf: entry.facts,
      };
      break;
    }

    case "complaint": {
      const template = pickTemplate(COMPLAINT_TEMPLATES, language, rng, false);
      rendered = { message: template.render({}), templateId: template.id, tier: "natural" };
      expectation = { op: "complaint", tier: "natural", templateId: template.id, language };
      break;
    }

    case "chitchat": {
      const template = pickTemplate(CHITCHAT_TEMPLATES, language, rng, false);
      rendered = { message: template.render({}), templateId: template.id, tier: "natural" };
      expectation = { op: "chitchat", tier: "natural", templateId: template.id, language };
      break;
    }

    case "postSubmitMessage": {
      const template = pickTemplate(POST_SUBMIT_TEMPLATES, language, rng, false);
      rendered = { message: template.render({}), templateId: template.id, tier: "natural" };
      expectation = { op: "postSubmitMessage", tier: "natural", templateId: template.id, language };
      break;
    }

    case "invalid": {
      rendered = { message: step.text, templateId: "invalid-literal", tier: "natural" };
      expectation = { op: "invalid", tier: "natural", templateId: "invalid-literal", language };
      break;
    }
  }

  return { turn: rendered, expectation };
}

// Personality-driven noise: extra turns the scenario didn't plan. All are
// natural-tier — the conditional assertions absorb whatever they do to the
// downstream flow.
function noiseSteps(profile: CustomerProfile, rng: Rng, menu: Menu, afterOp: ScenarioStep["op"]): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const isCartOp = afterOp === "add" || afterOp === "addAmbiguous";
  if (profile.asksQuestionsMidOrder && isCartOp && rng.chance(0.3)) {
    steps.push(
      rng.chance(0.5)
        ? { op: "askInfo", topic: rng.pick(["delivery-time", "delivery-fee", "timing"] as const) }
        : { op: "price", itemId: rng.pick(allItems(menu)).id }
    );
  }
  if (profile.changesMind && afterOp === "add" && rng.chance(0.3)) {
    const item = rng.pick(allItems(menu));
    steps.push({ op: "add", itemId: item.id, qty: 1, tier: "natural" });
    steps.push({ op: "remove", itemId: item.id, tier: "natural" });
  }
  const isCheckoutOp = afterOp === "confirm" || afterOp === "delivery" || afterOp === "pickup";
  if (profile.interruptsCheckout && isCheckoutOp && rng.chance(0.35)) {
    steps.push({ op: "add", itemId: rng.pick(allItems(menu)).id, qty: 1, tier: "natural" });
  }
  return steps;
}

export function generateConversation(
  plan: PlanEntry,
  id: string,
  seed: number,
  menu: Menu
): GeneratedConversation {
  const rng = new Rng(seed);
  let profile = plan.archetype ? customerForArchetype(plan.archetype, rng) : generateCustomer(rng);
  if (plan.language) profile = withLanguage(profile, plan.language);

  const scenario: Scenario = plan.scenario;
  const turns: PlannedTurn[] = [];

  const steps: ScenarioStep[] = [];
  if (profile.greets && scenario.steps[0]?.op !== "greet" && scenario.kind !== "invalid-input") {
    steps.push({ op: "greet" });
  }
  for (const step of scenario.steps) {
    steps.push(step);
    steps.push(...noiseSteps(profile, rng, menu, step.op));
  }

  for (const step of steps) {
    const { turn, expectation } = renderStep(step, profile, rng, menu);
    let message = turn.message;
    let tier = turn.tier;

    if (!PROTECTED_OPS.has(step.op)) {
      const { message: decorated, decorated: didDecorate } = decorate(message, profile, rng);
      if (didDecorate) {
        message = decorated;
        if (tier === "strict") tier = "natural";
      }
      if (profile.corruption !== "none" && rng.chance(profile.corruptionRate)) {
        const corrupted = corruptMessage(message, profile.corruption, rng);
        if (corrupted !== message) {
          message = corrupted;
          tier = "corrupted";
        }
      }
    }

    turns.push({
      message,
      expectation: { ...expectation, tier },
    });
  }

  return {
    id,
    seed,
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    quotaBucket: plan.quotaBucket,
    personality: profile.personality,
    language: profile.language,
    turns,
  };
}
