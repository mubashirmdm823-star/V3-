// V2 phase 3 — the actual NLU: turns raw customer text into a ParseResult
// (v2/types/parser.ts). This is deterministic, rule-based matching (menu
// vocabulary + phrase/keyword triggers) — not a model call — but it plays
// the same role a real NLU step would: understand the message, resolve item
// mentions to candidate menu ids, and hand everything to the safety layer
// (./safety.ts) for the actual go/no-go decision. It never mutates cart or
// order state itself.

import type { Menu, MenuCategory } from "../types/menu";
import type { CartState } from "../types/cart";
import type { Intent, IntentItemRef, IntentType, ReplaceIntentDetail } from "../types/intent";
import type { IntentName, ParsedAction, ParseResult, CartActionName } from "../types/parser";
import { evaluateSafety, SHOW_WORDS, PRICE_WORDS, type SafetyDecision } from "./safety";
import { clarifyUnclearMessage } from "./clarification";
import { normalizeMessage, splitIntoQtySegments, stripPhrases, type QtySegmentOptions } from "./normalize";
import {
  resolveItemQuery,
  resolveItemQueryWithinCategory,
  buildMenuVocabulary,
  buildProtectedQtyPhrases,
  findCategoryForItemId,
  findCategoryByName,
  significantTokens,
} from "./matching";

// ─── IntentName <-> legacy Intent.type bridge ────────────────────────────────
// The safety layer already ships with its own (lowercase) IntentType and is
// fully tested against it — rather than touch that contract, the parser maps
// its public IntentName onto it internally. Exported so v2/llm/parse-result-mapper.ts
// (phase 11) can build the exact same legacy Intent shape from a validated
// LLM response and run it through the same evaluateSafety() — reusing this
// bridge rather than maintaining a second copy of it.
export function toLegacyType(name: IntentName): IntentType {
  switch (name) {
    case "GREETING":
    case "THANKS":
    case "YES":
    case "NO":
    case "WAIT":
    case "CANCEL_ORDER":
    case "HUMAN_SUPPORT":
    case "COMPLAINT":
    case "RECOMMENDATION_REQUEST":
    case "CONFUSED_CUSTOMER":
    case "SMALL_TALK":
    case "IRRELEVANT_QUERY":
    case "HELP":
    case "GOODBYE":
      // The safety layer's IntentType has no conversational vocabulary —
      // "unknown" guarantees NO_CART_ACTION, which is exactly what every
      // conversational intent means for the cart. Any state effect (YES
      // confirming a review, CANCEL_ORDER ending the order) is the order
      // state engine's decision, never the cart engine's.
      return "unknown";
    case "ADD_ITEM":
    case "ADD_MULTIPLE_ITEMS":
      return "add_item";
    case "REMOVE_ITEM":
      return "remove_item";
    case "REMOVE_ALL":
      return "clear_cart";
    case "REPLACE_ITEM":
      return "replace_item";
    case "CHANGE_QUANTITY":
      return "update_quantity";
    case "SHOW_OPTIONS":
      return "show_options";
    case "SHOW_MENU":
    case "SHOW_CART":
      return "show_menu";
    case "PRICE_QUERY":
    case "HYPOTHETICAL_TOTAL":
      return "price_query";
    case "CHECKOUT_START":
      return "checkout";
    case "CONFIRM_ORDER":
      return "confirm_order";
    case "SELECT_DELIVERY":
    case "SELECT_PICKUP":
      return "provide_order_type";
    case "PROVIDE_ADDRESS":
      return "provide_address";
    case "PROVIDE_NAME":
      return "provide_name";
    case "ASK_RESTAURANT_INFO":
      return "ask_info";
    case "ASK_CLARIFICATION":
    case "UNKNOWN":
      return "unknown";
  }
}

function runSafety(
  name: IntentName,
  rawText: string,
  confidence: number,
  cart: CartState,
  menu: Menu,
  items?: IntentItemRef[],
  replace?: ReplaceIntentDetail
): SafetyDecision {
  const intent: Intent = { type: toLegacyType(name), rawText, confidence, items, replace };
  return evaluateSafety(intent, cart, menu);
}

const DECISION_PRIORITY: SafetyDecision["decision"][] = [
  "REJECT_UNAVAILABLE",
  "REJECT_NOT_IN_CART",
  "ASK_CLARIFICATION",
  "NO_CART_ACTION",
  "SAFE_TO_EXECUTE",
];

function worstDecision(decisions: SafetyDecision[]): SafetyDecision {
  for (const type of DECISION_PRIORITY) {
    const match = decisions.find((d) => d.decision === type);
    if (match) return match;
  }
  return decisions[0];
}

// ─── Trigger detection ───────────────────────────────────────────────────────

// Order-initiating verbs — their PRESENCE is what turns a bare category
// name from "browsing" ("burger") into "ordering" ("burger add karo").
// Exported for order-state-engine/clarification.ts, which reuses this exact
// signal to distinguish a genuinely new, explicit order from a bare
// attempt to answer a pending "which one?" question.
export const ORDER_VERB_PATTERN =
  /\b(add|karo|kar\s*do|kardo|krdo|krado|dedo|de\s*do|dena|dijiye|chahiye|chahye|chaiye|want|order|mangwa\w*|laga\w*)\b/;

// "Everything"/"whole thing" intensifiers — stripped alongside SHOW_WORDS
// so "full menu"/"complete menu"/"sab menu"/"poora menu" leave NO leftover
// text (and therefore show the whole menu) instead of being misread as an
// attempt to browse a category literally named "full"/"sab"/"poora".
const FULL_MENU_WORDS = ["full", "complete", "sab", "sub", "poora", "pura", "puri", "pori"];

function isRemoveAllTrigger(text: string): boolean {
  if (text.includes("remove everything")) return true;
  if (text.includes("clear cart") || text.includes("clear my cart")) return true;
  if (text.includes("sab hata do") || text.includes("sab hatao")) return true;
  // "khali kar do" = empty the cart — the most common Roman Urdu clear
  // phrase. Requires the action verb ("kar/karo/kardo") so a QUESTION like
  // "cart khali hai?" never clears anything.
  if (/khali\s*(kar|karo|kardo|krdo|kr)\b/.test(text)) return true;
  const hasAll = /\bsab\b/.test(text) || text.includes("everything");
  const hasRemoveVerb = /\bremove\b|\bhata\b|\bclear\b/.test(text);
  return hasAll && hasRemoveVerb;
}

// Replacement phrase variants, each capturing (source, target). Ordered by
// specificity; every group must come back non-empty for the pattern to
// count (an empty source is what used to turn "replace X with Y" into a
// malformed not-in-cart reply with a blank item name).
const REPLACE_PATTERNS: readonly RegExp[] = [
  /^(.+?)\s+ha+ta+\s*kar\s+(.+)$/, // "X hata kar Y add karo" (typo-tolerant: "haata"/"hataa")
  /^(.+?)\s+(?:(?:is|us)ki|ki)\s+jagah\s+(.+)$/, // "X ki jagah Y kar do"
  /^(.+?)\s+ke\s+bajaye\s+(.+)$/, // "X ke bajaye Y"
  /^(?:.*\b)?replace\s+(.+?)\s+with\s+(.+)$/, // "replace X with Y"
  /^(?:.*\b)?change\s+(.+?)\s+to\s+(.+)$/, // "change X to Y"
];

function matchReplace(text: string): { sourceText: string; targetText: string } | null {
  // "change ... quantity ..." is a quantity update, not a replacement.
  if (/\bquantity\b|\bqty\b/.test(text)) return null;
  for (const pattern of REPLACE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1].trim() && match[2].trim()) {
      return { sourceText: match[1].trim(), targetText: match[2].trim() };
    }
  }
  return null;
}

// Damerau-Levenshtein distance capped at 1 — is `token` the keyword with at
// most one typo (insert/delete/substitute/adjacent-swap)? Covers every
// single-typo form of a verb ("remoove", "rmeove", "remve", "reove") without
// enumerating them.
function withinOneEdit(token: string, keyword: string): boolean {
  if (token === keyword) return true;
  const a = token, b = keyword;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  // substitution
  if (a.length === b.length && a.slice(i + 1) === b.slice(i + 1)) return true;
  // adjacent transposition
  if (a.length === b.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
  // insertion in a / deletion from a
  if (a.length === b.length + 1 && a.slice(i + 1) === b.slice(i)) return true;
  if (a.length + 1 === b.length && a.slice(i) === b.slice(i + 1)) return true;
  return false;
}

function isRemoveItemTrigger(text: string, compactText: string, vocabulary: ReadonlySet<string>): boolean {
  // Exact/regex forms first: \s* covers the joined forms real customers
  // type ("hatado", "nikaldo"); /\bh[at]+\s*do\b/ covers typo'd "hata"
  // ("haata do", "htaa do"). The compact check catches spacing-corrupted
  // verbs ("r emo ve", "zah atado") that survive de-spacing — none of
  // these letter sequences occur inside any menu word. Bare "hata" is
  // deliberately NOT checked compactly ("hata kar" — a replace — compacts
  // to "hatakar"). Finally, any token within one edit of "remove" counts
  // ("remoove", "rmeove", "remve").
  if (
    /\bremov\w*\b|\bh[at]+\s*do\b|\bhatao\b|\bnikal\s*do\b|\bhata\b/.test(text) ||
    /remove|hatado|hatao|nikaldo/.test(compactText)
  ) {
    return true;
  }
  return text
    .split(/\s+/)
    .some((tok) => tok.length >= 5 && !vocabulary.has(tok) && withinOneEdit(tok, "remove"));
}

function isConfirmOrderTrigger(text: string): boolean {
  return (
    text.includes("confirm order") ||
    text.includes("order confirm") ||
    text.includes("haan confirm") ||
    /confirm\s*kar\s*do/.test(text)
  );
}

function isCheckoutTrigger(text: string): boolean {
  return (
    text.includes("place order") ||
    text.includes("order place") ||
    text.includes("bas yahi hai") ||
    text.includes("checkout")
  );
}

function isShowCartTrigger(text: string): boolean {
  if (!text.includes("cart")) return false;
  return SHOW_WORDS.some((w) => text.includes(w)) || text.includes("mera cart") || text.includes("cart mein kya");
}

// Restaurant-information phrasings. Checked BEFORE price/delivery/pickup
// detection so "delivery charges kitne hain" answers with the configured
// facts instead of being misread as a SELECT_DELIVERY checkout action (the
// QA simulator's misleading-checkout-error bug), and "delivery mein kitna
// time lagta hai" isn't swallowed by the price-word check.
const RESTAURANT_INFO_PHRASES = [
  "address kya hai", "aapka address", "restaurant kahan", "kahan hai",
  "address batao", "where are you located", "where are you", "location",
  "maps ka link", "maps link", "map link",
  "timing", "kya time", "what are your hours", "kitne baje",
  "phone number", "contact number", "aapka number",
  "delivery charges", "delivery charge", "delivery fee", "delivery fees",
  "delivery time", "delivery mein kitna", "delivery me kitna",
  "how long does delivery", "kitna time lagta", "kitna time lagega",
  "kitni der lagegi", "kitni der lagti",
];

function isAskRestaurantInfoTrigger(text: string): boolean {
  return RESTAURANT_INFO_PHRASES.some((p) => text.includes(p));
}

// Raw structured text — JSON blobs, markup tags — is never a real customer
// order. Without this guard, token matching INSIDE the blob (e.g. "zinger"
// in {"id":"zinger-burger"}) could actually mutate the cart, which the QA
// simulator proved happens.
function looksLikeStructuredText(raw: string): boolean {
  return /[{}[\]]/.test(raw) || /<\/?[a-z]+[^>]*>/i.test(raw);
}

// ─── Conversational intent detection (V2 Customer Conversation Layer) ───────
//
// Two detection styles, chosen per intent by risk of hijacking an order:
//
// WHOLE-MESSAGE sets — the ENTIRE message must be one of the listed phrases
// (spaced or space-stripped). "hello, 2 zinger burger" deliberately fails
// these and flows through normal classification, so an order attached to a
// pleasantry still orders. Used for short/ambiguous words (YES's "haan",
// HELP's "help") that appear inside real orders all the time.
//
// CONTAINS phrase lists — the message merely mentions the phrase. Used only
// for phrases too specific to appear inside an order ("cancel", "shikayat",
// "kya acha hai") and checked late enough that every ordering intent has
// already had its chance.

function wholeMessageSet(phrases: string[]): { spaced: ReadonlySet<string>; compact: ReadonlySet<string> } {
  return {
    spaced: new Set(phrases),
    compact: new Set(phrases.map((p) => p.replace(/\s+/g, ""))),
  };
}

const GREETING_SET = wholeMessageSet([
  "hello", "hi", "hey", "salam", "salaam", "aoa",
  "assalam o alaikum", "assalamu alaikum", "asalam o alaikum",
  "assalam u alaikum", "salam o alaikum",
]);
const THANKS_SET = wholeMessageSet([
  "thanks", "thank you", "thanku", "thnx", "thx", "ty",
  "shukriya", "shukria", "bohat shukriya", "bahut shukriya",
  "thanks a lot", "thank you so much", "jazakallah", "meherbani",
]);
const YES_SET = wholeMessageSet([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "okk",
  "haan", "han", "haan ji", "han ji", "ji", "jee", "g", "ji haan",
  "theek hai", "thik hai", "theek", "bilkul", "zaroor", "acha", "achha",
]);
const NO_SET = wholeMessageSet([
  "no", "nope", "nah", "na", "nahi", "nahin", "nai",
  "nahi chahiye", "nahi karna", "no thanks", "nahi ji",
]);
const WAIT_SET = wholeMessageSet([
  "wait", "ruko", "ruk jao", "rukho", "ruk", "hold on", "one minute",
  "ek minute", "1 minute", "ek min", "1 min", "ek second", "1 second",
  "baad mein", "baad me", "later", "thora ruko", "thoda ruko",
  "abhi nahi", "not now", "abhi ruko",
]);
const GOODBYE_SET = wholeMessageSet([
  "bye", "bye bye", "goodbye", "good bye", "allah hafiz", "khuda hafiz",
  "allah hafez", "chalta hun", "chalti hun", "phir milenge", "good night",
  "gud night", "see you", "ok bye",
]);
const SMALL_TALK_SET = wholeMessageSet([
  "kya haal hai", "kya haal", "kaise ho", "kese ho", "kaisay ho", "kaise hain aap",
  "how are you", "how r u", "hows it going", "kya chal raha hai",
  "aap kaun ho", "tum kaun ho", "who are you", "kya kar rahe ho",
  "bot ho kya", "kya aap bot hain", "sab theek",
]);
const HELP_SET = wholeMessageSet([
  "help", "help karo", "help chahiye", "madad", "madad karo", "madad karein",
  "madad chahiye", "guide karo", "help me", "help plz", "help please",
]);

// Contains-detection phrase lists.
const CANCEL_PHRASES = ["cancel", "cansel", "canel", "rehne do", "rehnay do", "nahi mangwana", "order band karo", "khatam kar do order"];
const HUMAN_SUPPORT_PHRASES = [
  "manager", "admin", "human", "agent", "kisi se baat", "baat karwa", "baat karva",
  "kisi insan", "call karo", "mujhe call", "call karwa", "customer care", "helpline",
  "shop wale se", "owner se",
];
const COMPLAINT_PHRASES = [
  "complaint", "complain", "shikayat", "thanda tha", "thanda mila", "thanda aya",
  "kharab", "bakwas", "galat order", "ghalat order", "der se aya", "late aya",
  "late aaya", "bohat late", "bahut late", "taste acha nahi", "bad service",
];
const RECOMMENDATION_PHRASES = [
  "recommend", "suggest", "kya acha hai", "kya achha hai", "kya accha hai",
  "best kya", "kya best", "sab se acha", "sabse acha", "famous kya", "kya famous",
  "mashhoor", "speciality", "kuch acha", "kuch achha", "apki taraf se",
  "popular kya", "kya popular", "bestseller", "whats good", "what is good",
  "what should i order", "kya mangwaun", "kya mangwau",
];
const CONFUSED_PHRASES = [
  "samajh nahi", "samaj nahi", "kaise order", "order kaise", "kese order",
  "confuse", "confused", "pata nahi kya karna", "kya karna hai mujhe",
  "kuch samajh", "how do i order", "how to order",
];
const IRRELEVANT_PHRASES = [
  "weather", "mausam", "barish", "cricket", "match kaun", "match dekha",
  "football", "news", "khabar", "politics", "siyasat", "election", "movie",
  "film", "song", "gana", "bitcoin", "stock market", "exam", "homework",
];

function matchesWholeMessage(set: { spaced: ReadonlySet<string>; compact: ReadonlySet<string> }, text: string, compactText: string): boolean {
  return set.spaced.has(text) || set.compact.has(compactText);
}

function containsAnyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

// Whole-message conversational classification — returns null when the
// message is anything more than the pleasantry itself.
function classifyBareConversational(text: string, compactText: string): IntentName | null {
  if (matchesWholeMessage(GREETING_SET, text, compactText)) return "GREETING";
  if (matchesWholeMessage(THANKS_SET, text, compactText)) return "THANKS";
  if (matchesWholeMessage(YES_SET, text, compactText)) return "YES";
  if (matchesWholeMessage(NO_SET, text, compactText)) return "NO";
  if (matchesWholeMessage(WAIT_SET, text, compactText)) return "WAIT";
  if (matchesWholeMessage(GOODBYE_SET, text, compactText)) return "GOODBYE";
  if (matchesWholeMessage(SMALL_TALK_SET, text, compactText)) return "SMALL_TALK";
  if (matchesWholeMessage(HELP_SET, text, compactText)) return "HELP";
  return null;
}

const ADDRESS_WORDS = ["house", "street", "road", "block", "near", "nagar", "colony", "town", "phase", "sector", "gali", "mohalla"];

function isProvideAddressTrigger(text: string): boolean {
  return /\d/.test(text) && ADDRESS_WORDS.some((w) => text.includes(w));
}

function extractProvideNameTrigger(text: string): boolean {
  return /mera naam\s+\S/.test(text) || /my name is\s+\S/.test(text) || /^naam[:\s]+\S/.test(text);
}

function joinSegments(text: string, segOpts: QtySegmentOptions = {}): string {
  return splitIntoQtySegments(text, segOpts).map((s) => s.text).join(" ").trim();
}

// ─── Add-item resolution (with same-message category anchoring) ─────────────

function resolveAddSegments(
  segments: { qty: number; text: string }[],
  menu: Menu,
  vocabulary: Set<string>
): IntentItemRef[] {
  const firstPass = segments.map((seg) => ({
    seg,
    candidates: resolveItemQuery(seg.text, menu, vocabulary),
  }));

  // If any segment unambiguously resolved, its category "anchors" the rest
  // of the message — lets a bare "small"/"large" in the same message as
  // "alfredo" resolve to Pasta Small/Large instead of staying ambiguous
  // across every category that happens to have a "small"/"large" item.
  let anchorCategory: MenuCategory | undefined;
  for (const { candidates } of firstPass) {
    if (candidates.length === 1) {
      const cat = findCategoryForItemId(menu, candidates[0]);
      if (cat) {
        anchorCategory = cat;
        break;
      }
    }
  }

  return firstPass.map(({ seg, candidates }) => {
    let finalCandidates = candidates;
    if (candidates.length !== 1 && anchorCategory) {
      const scoped = resolveItemQueryWithinCategory(seg.text, anchorCategory);
      if (scoped.length > 0) finalCandidates = scoped;
    }
    return { query: seg.text, quantity: seg.qty, candidateItemIds: finalCandidates };
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function parseMessage(rawMessage: string, cart: CartState, menu: Menu): ParseResult {
  const normalizedMessage = normalizeMessage(rawMessage);
  // Space-stripped form: spacing-corrupted verbs ("r emo ve", "kipric e")
  // survive de-spacing, so triggers are checked against both forms.
  const compactMessage = normalizedMessage.replace(/\s+/g, "");
  const vocabulary = buildMenuVocabulary(menu);
  const segOpts: QtySegmentOptions = {
    protectedPhrases: buildProtectedQtyPhrases(menu),
    vocabulary,
  };

  function finalize(
    intentName: IntentName,
    confidence: number,
    opts: {
      actions?: ParsedAction[];
      items?: IntentItemRef[];
      category?: string;
      safety?: SafetyDecision;
      forceNeedsClarification?: boolean;
      forceClarificationMessage?: string;
    } = {}
  ): ParseResult {
    const actions = opts.actions ?? [];
    // Non-mutating intents (SHOW_OPTIONS/PRICE_QUERY/...) resolve candidate
    // items for the safety check and for downstream display (response
    // builder) but never produce a cart-mutating action — opts.items lets
    // those flow into the result without needing a fake action.
    const items = opts.items ?? actions.flatMap((a) => a.items ?? []);
    const safety = opts.safety ?? { decision: "NO_CART_ACTION" as const, reason: "No safety evaluation required." };
    return {
      intent: intentName,
      confidence,
      items,
      actions,
      category: opts.category,
      needsClarification: opts.forceNeedsClarification ?? safety.decision === "ASK_CLARIFICATION",
      clarificationQuestion: opts.forceClarificationMessage ?? safety.message,
      safetyDecision: safety.decision,
      rawUserMessage: rawMessage,
      normalizedMessage,
    };
  }

  // 0. Raw structured text (JSON blobs, markup) is unsafe customer input —
  //    never let token matching inside it reach the cart.
  if (looksLikeStructuredText(rawMessage)) {
    return finalize("UNKNOWN", 0.1, {
      forceNeedsClarification: false,
      forceClarificationMessage: clarifyUnclearMessage(),
      safety: { decision: "NO_CART_ACTION", reason: "Message is raw structured text, not natural language." },
    });
  }

  // 0.5. Bare conversational messages (greeting/thanks/yes/no/wait/goodbye/
  //      small-talk/help) — the WHOLE message is just the pleasantry.
  //      Whole-message equality means these can never hijack a message that
  //      also contains an order ("hello, 2 zinger burger" fails the check).
  const bareConversational = classifyBareConversational(normalizedMessage, compactMessage);
  if (bareConversational) {
    return finalize(bareConversational, 0.97, {
      safety: { decision: "NO_CART_ACTION", reason: "Conversational message — nothing to execute in the cart." },
    });
  }

  // 1. Compound "remove everything and add X" — must run before any single
  //    -intent check below, since both a remove and an add trigger appear.
  const connectorMatch = normalizedMessage.match(/\b(aur|and)\b/);
  if (connectorMatch) {
    const idx = connectorMatch.index ?? 0;
    const left = normalizedMessage.slice(0, idx).trim();
    const right = normalizedMessage.slice(idx + connectorMatch[0].length).trim();
    if (right && isRemoveAllTrigger(left)) {
      const addSegments = splitIntoQtySegments(right, segOpts);
      const addItems = resolveAddSegments(addSegments, menu, vocabulary);
      const addAction: CartActionName = addItems.length > 1 ? "ADD_MULTIPLE_ITEMS" : "ADD_ITEM";
      const removeSafety = runSafety("REMOVE_ALL", left, 0.9, cart, menu);
      const addSafety = runSafety(addAction, right, 0.9, cart, menu, addItems);
      return finalize("REMOVE_ALL", 0.9, {
        actions: [{ action: "REMOVE_ALL" }, { action: addAction, items: addItems }],
        safety: worstDecision([removeSafety, addSafety]),
      });
    }
  }

  // 2. Confirm order
  if (isConfirmOrderTrigger(normalizedMessage)) {
    return finalize("CONFIRM_ORDER", 0.95, { safety: runSafety("CONFIRM_ORDER", rawMessage, 0.95, cart, menu) });
  }

  // 3. Checkout start
  if (isCheckoutTrigger(normalizedMessage)) {
    return finalize("CHECKOUT_START", 0.93, { safety: runSafety("CHECKOUT_START", rawMessage, 0.93, cart, menu) });
  }

  // 4. Remove everything
  if (isRemoveAllTrigger(normalizedMessage)) {
    return finalize("REMOVE_ALL", 0.93, {
      actions: [{ action: "REMOVE_ALL" }],
      safety: runSafety("REMOVE_ALL", rawMessage, 0.93, cart, menu),
    });
  }

  // 4.5. Cancel the order — checked before replace/remove so "order cancel
  //      kar do" never reads as a cart edit. The state engine decides
  //      whether there is actually anything to cancel.
  if (containsAnyPhrase(normalizedMessage, CANCEL_PHRASES)) {
    return finalize("CANCEL_ORDER", 0.95, {
      safety: { decision: "NO_CART_ACTION", reason: "Order cancellation — handled by the state engine, not the cart." },
    });
  }

  // 5. Replace item — checked before plain "remove", since "hata kar" would
  //    otherwise also match the remove-item trigger below. All variants
  //    ("X hata kar Y add karo", "X ki jagah Y kar do", "X ke bajaye Y",
  //    "replace X with Y", "change X to Y") extract a non-empty source AND
  //    target or don't count as a replace at all.
  const replaceMatch = matchReplace(normalizedMessage);
  if (replaceMatch) {
    const sourceQuery = joinSegments(replaceMatch.sourceText, segOpts);
    const targetQuery = joinSegments(replaceMatch.targetText, segOpts);
    const replace: ReplaceIntentDetail = {
      sourceQuery,
      targetQuery,
      sourceCandidateItemIds: resolveItemQuery(sourceQuery, menu, vocabulary),
      targetCandidateItemIds: resolveItemQuery(targetQuery, menu, vocabulary),
    };
    return finalize("REPLACE_ITEM", 0.9, {
      actions: [{ action: "REPLACE_ITEM", replace }],
      safety: runSafety("REPLACE_ITEM", rawMessage, 0.9, cart, menu, undefined, replace),
    });
  }

  // 6. Remove a specific item
  if (isRemoveItemTrigger(normalizedMessage, compactMessage, vocabulary)) {
    const leftover = stripPhrases(normalizedMessage, ["removee", "remove", "hatado", "hata do", "hatao", "nikal do", "hata"]);
    const query = joinSegments(leftover, segOpts);
    const items: IntentItemRef[] = [{ query, candidateItemIds: resolveItemQuery(query, menu, vocabulary) }];
    return finalize("REMOVE_ITEM", 0.92, {
      actions: [{ action: "REMOVE_ITEM", items }],
      safety: runSafety("REMOVE_ITEM", rawMessage, 0.92, cart, menu, items),
    });
  }

  // 6.5. Change the quantity of an existing cart item
  if (/\bquantity\b|\bqty\b/.test(normalizedMessage)) {
    const numMatch = normalizedMessage.match(/\d+/);
    const quantity = numMatch ? parseInt(numMatch[0], 10) : undefined;
    const withoutNumbers = normalizedMessage.replace(/\d+/g, " ");
    const query = joinSegments(stripPhrases(withoutNumbers, ["quantity", "qty"]), segOpts);
    const items: IntentItemRef[] = [{ query, quantity, candidateItemIds: resolveItemQuery(query, menu, vocabulary) }];
    return finalize("CHANGE_QUANTITY", 0.9, {
      actions: [{ action: "CHANGE_QUANTITY", items }],
      safety: runSafety("CHANGE_QUANTITY", rawMessage, 0.9, cart, menu, items),
    });
  }

  // 6.8. Conversational contains-detection — human support, complaints,
  //      recommendations, confusion, and clearly off-topic queries. Checked
  //      BEFORE the show/price classifiers because these phrasings often
  //      carry a show-word or price-word ("kuch acha sa BATAO", "bitcoin ka
  //      RATE batao") while asking something else entirely — and none of
  //      them ever mutate the cart, so classifying early is the safe
  //      direction.
  if (containsAnyPhrase(normalizedMessage, HUMAN_SUPPORT_PHRASES)) {
    return finalize("HUMAN_SUPPORT", 0.92, {
      safety: { decision: "NO_CART_ACTION", reason: "Customer asked for a human." },
    });
  }
  if (containsAnyPhrase(normalizedMessage, COMPLAINT_PHRASES)) {
    return finalize("COMPLAINT", 0.92, {
      safety: { decision: "NO_CART_ACTION", reason: "Customer complaint — apologize and offer help." },
    });
  }
  if (containsAnyPhrase(normalizedMessage, RECOMMENDATION_PHRASES)) {
    return finalize("RECOMMENDATION_REQUEST", 0.92, {
      safety: { decision: "NO_CART_ACTION", reason: "Customer asked for a recommendation." },
    });
  }
  if (containsAnyPhrase(normalizedMessage, CONFUSED_PHRASES)) {
    return finalize("CONFUSED_CUSTOMER", 0.9, {
      safety: { decision: "NO_CART_ACTION", reason: "Customer is confused — explain how to order." },
    });
  }
  if (containsAnyPhrase(normalizedMessage, IRRELEVANT_PHRASES)) {
    return finalize("IRRELEVANT_QUERY", 0.85, {
      safety: { decision: "NO_CART_ACTION", reason: "Off-topic message — redirect to the menu." },
    });
  }

  // 7. Restaurant info questions — checked BEFORE the show/price/delivery
  //    classifiers: "address batao" contains the show-word "batao" but is
  //    an info question, "delivery charges kitne hain" contains "delivery"
  //    but is not a checkout action, and "delivery mein kitna time lagta
  //    hai" contains a price word but asks about time. Also before the
  //    address heuristic so "what's YOUR address" isn't mistaken for the
  //    customer giving theirs.
  if (isAskRestaurantInfoTrigger(normalizedMessage)) {
    return finalize("ASK_RESTAURANT_INFO", 0.9, { safety: runSafety("ASK_RESTAURANT_INFO", rawMessage, 0.9, cart, menu) });
  }

  // 7.5. Show cart
  if (isShowCartTrigger(normalizedMessage)) {
    return finalize("SHOW_CART", 0.95, { safety: runSafety("SHOW_CART", rawMessage, 0.95, cart, menu) });
  }

  // 7.9. Bare category browse — the WHOLE message (no order verb, no
  //      quantity) names a menu category directly ("burger", "pizza")
  //      rather than a specific item. A real customer browsing says the
  //      category name alone; treating that as an ambiguous ADD attempt
  //      would ask "which burger?" instead of just showing the category
  //      (rule: "if customer asks category menu like 'burger', show only
  //      that category"). Checked only when there's no show-word already
  //      present — "burger dikhao"/"burger menu" are handled by step 8
  //      below, which this same category matcher also improves.
  const hasShowWord = SHOW_WORDS.some((w) => normalizedMessage.includes(w));
  if (!hasShowWord && !/\d/.test(normalizedMessage) && !ORDER_VERB_PATTERN.test(normalizedMessage)) {
    const bareCategory = findCategoryByName(normalizedMessage, menu);
    if (bareCategory) {
      const items: IntentItemRef[] = [{ query: normalizedMessage, candidateItemIds: bareCategory.items.map((i) => i.id) }];
      return finalize("SHOW_OPTIONS", 0.95, {
        items,
        // The raw text, not the category's real title — matches this same
        // field's existing convention just below (step 8's leftover-based
        // SHOW_OPTIONS), which other consumers (context-builder's
        // getTurnsByCategory) already key off verbatim.
        category: normalizedMessage,
        safety: { decision: "NO_CART_ACTION", reason: "Bare category name — browsing, not ordering." },
      });
    }
  }

  // 8. Show menu / show options — a show-word plus a leftover category
  //    word means "show me THAT category"; a show-word with nothing left
  //    over means "show me the whole menu". Cart action is always NONE.
  //    Never shows the full menu when a specific category was actually
  //    named (rule: "never show full menu unless user says 'full menu' or
  //    'complete menu'").
  if (hasShowWord) {
    const stripped = stripPhrases(normalizedMessage, [...SHOW_WORDS, ...FULL_MENU_WORDS]);
    const leftover = joinSegments(stripped, segOpts);
    if (leftover) {
      // A leftover that names a whole category shows EVERY item in it
      // (the literal substring matcher below can miss items whose name
      // doesn't literally contain the category word, e.g. "Jumbo Zinger"
      // for "burger") rather than a partial, misleadingly-incomplete list.
      const leftoverCategory = findCategoryByName(leftover, menu);
      const candidates = leftoverCategory ? leftoverCategory.items.map((i) => i.id) : resolveItemQuery(leftover, menu, vocabulary);
      const items: IntentItemRef[] = candidates.length > 0 ? [{ query: leftover, candidateItemIds: candidates }] : [];
      return finalize("SHOW_OPTIONS", 0.9, {
        actions: [],
        items,
        category: leftover,
        safety: runSafety("SHOW_OPTIONS", rawMessage, 0.9, cart, menu, items),
      });
    }
    return finalize("SHOW_MENU", 0.95, { safety: runSafety("SHOW_MENU", rawMessage, 0.95, cart, menu) });
  }

  // 10. Price queries — also matched on the compact form so a spacing-
  //     corrupted "kipric eky ahai" still reads as a price question, and
  //     with one-edit typo tolerance ("how mucch", "pricee") so a typo'd
  //     price question never falls through to the ADD fallback and mutates
  //     the cart.
  const COMPACT_PRICE_TOKENS = ["price", "howmuch", "kitneka", "kitna", "kitni", "cost"];
  const messageTokens = normalizedMessage.split(/\s+/);
  // Exact menu-vocabulary tokens are never fuzzy-matched as price words —
  // "rice" is one edit from "price" and must stay an item, not a question.
  const typoPriceHit =
    messageTokens.some(
      (tok) =>
        !vocabulary.has(tok) &&
        // "price" tolerates 4-letter deletion typos ("prce") — the vocab
        // guard already keeps "rice" an item. The Urdu words stay gated at
        // 5 so common short words ("itna") can't fuzzy-match.
        ((tok.length >= 4 && withinOneEdit(tok, "price")) ||
          (tok.length >= 5 && (withinOneEdit(tok, "kitna") || withinOneEdit(tok, "kitne") || withinOneEdit(tok, "kitni"))))
    ) ||
    messageTokens.some((tok, i) => {
      const next = messageTokens[i + 1];
      return Boolean(next) && !vocabulary.has(tok) && !vocabulary.has(next) && withinOneEdit(tok, "how") && withinOneEdit(next, "much");
    });
  if (PRICE_WORDS.some((w) => normalizedMessage.includes(w)) || COMPACT_PRICE_TOKENS.some((w) => compactMessage.includes(w)) || typoPriceHit) {
    const isHypothetical = normalizedMessage.includes("agar") || normalizedMessage.includes("total");
    const intentName: IntentName = isHypothetical ? "HYPOTHETICAL_TOTAL" : "PRICE_QUERY";
    const leftover = joinSegments(stripPhrases(normalizedMessage, PRICE_WORDS), segOpts);
    const candidates = leftover ? resolveItemQuery(leftover, menu, vocabulary) : [];
    const items: IntentItemRef[] = candidates.length > 0 ? [{ query: leftover, candidateItemIds: candidates }] : [];
    return finalize(intentName, 0.9, { items, safety: runSafety(intentName, rawMessage, 0.9, cart, menu, items) });
  }

  // 11. Delivery / pickup selection
  if (/\bdelivery\b/.test(normalizedMessage)) {
    return finalize("SELECT_DELIVERY", 0.95, { safety: runSafety("SELECT_DELIVERY", rawMessage, 0.95, cart, menu) });
  }
  if (/\bpick\s*up\b/.test(normalizedMessage)) {
    return finalize("SELECT_PICKUP", 0.95, { safety: runSafety("SELECT_PICKUP", rawMessage, 0.95, cart, menu) });
  }

  // 12. Customer's name
  if (extractProvideNameTrigger(normalizedMessage)) {
    return finalize("PROVIDE_NAME", 0.9, { safety: runSafety("PROVIDE_NAME", rawMessage, 0.9, cart, menu) });
  }

  // 13. Customer's address
  if (isProvideAddressTrigger(normalizedMessage)) {
    return finalize("PROVIDE_ADDRESS", 0.9, { safety: runSafety("PROVIDE_ADDRESS", rawMessage, 0.9, cart, menu) });
  }

  // 14. Add item(s) — the general fallback for anything naming menu items.
  const segments = splitIntoQtySegments(normalizedMessage, segOpts);
  if (segments.length > 0) {
    const allItems = resolveAddSegments(segments, menu, vocabulary);
    const anyResolved = allItems.some((i) => (i.candidateItemIds?.length ?? 0) > 0);
    if (anyResolved) {
      // Drop pure-noise segments: an unresolvable chunk with no menu
      // vocabulary in it ("bhai", "i want") is conversational filler, not a
      // failed item — keeping it poisoned the whole add as unavailable.
      // A chunk that DOES mention menu vocabulary ("beef burger") is kept,
      // so genuinely-unavailable items still reject.
      const items = allItems.filter(
        (i) =>
          (i.candidateItemIds?.length ?? 0) > 0 ||
          significantTokens(i.query).some((t) => vocabulary.has(t))
      );
      const intentName: IntentName = items.length > 1 ? "ADD_MULTIPLE_ITEMS" : "ADD_ITEM";
      const ambiguous = items.find((i) => (i.candidateItemIds?.length ?? 0) > 1);
      return finalize(intentName, 0.9, {
        actions: [{ action: intentName, items }],
        category: ambiguous?.query,
        safety: runSafety(intentName, rawMessage, 0.9, cart, menu, items),
      });
    }
    // Nothing resolved at all. Only treat this as a specific-but-unavailable
    // item (rather than falling through to ASK_CLARIFICATION/UNKNOWN below)
    // when the text actually contains some food vocabulary — e.g. "beef
    // burger" mentions "burger" (real, just paired with an unavailable
    // qualifier), whereas generic filler or gibberish mentions nothing food-
    // related at all and shouldn't be misreported as a menu rejection.
    if (allItems.length === 1 && significantTokens(allItems[0].query).some((t) => vocabulary.has(t))) {
      const intentName: IntentName = "ADD_ITEM";
      return finalize(intentName, 0.9, {
        actions: [{ action: intentName, items: allItems }],
        safety: runSafety(intentName, rawMessage, 0.9, cart, menu, allItems),
      });
    }
  }

  // 15. Order-ish filler words with nothing resolvable — ask, don't guess.
  if (/\bchahiye\b|\bwant\b|\border\b|\bdedo\b|\bkrdo\b|\bkardo\b/.test(normalizedMessage)) {
    return finalize("ASK_CLARIFICATION", 0.5, {
      forceNeedsClarification: true,
      forceClarificationMessage: clarifyUnclearMessage(),
      safety: { decision: "ASK_CLARIFICATION", reason: "Order-like phrasing but no resolvable item." },
    });
  }

  // 16. Genuinely unrecognized.
  return finalize("UNKNOWN", 0.15, {
    forceNeedsClarification: false,
    forceClarificationMessage: clarifyUnclearMessage(),
    safety: { decision: "NO_CART_ACTION", reason: "Message could not be classified." },
  });
}
