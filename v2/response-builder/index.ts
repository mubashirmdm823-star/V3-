// V2 phase 6 — response builder.
//
// The ONLY module allowed to generate customer-facing text. It never
// parses customer language, never mutates the cart, never changes order
// state — it only reads the already-computed structured results (ParseResult,
// before/after OrderContext, Menu/RestaurantConfig) and returns a plain
// string reply. Internal identifiers, intent names, safety decisions,
// confidence scores, and raw JSON are read here for DISPATCH decisions only
// — never printed to the customer.
//
// Pipeline: Intent Parser -> Safety Layer -> Cart Engine -> Order State
// Engine -> Response Builder (this) -> Logger -> Customer.

import type { CartState } from "../types/cart";
import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderContext } from "../types/order";
import type { ParseResult, IntentName } from "../types/parser";
import { findMenuItem } from "../cart-engine/validate";
import {
  addSingleItemConfirmation,
  addMultipleItemsConfirmation,
  removeItemConfirmation,
  removeMultipleItemsConfirmation,
  clearCartConfirmation,
  replaceItemConfirmation,
  changeQuantityConfirmation,
  cartUpdatedConfirmation,
} from "./templates";
import { buildOrderSummary, EMPTY_CART_MESSAGE } from "./order-summary";
import { calculateTotal } from "../cart-engine/totals";
import {
  buildClarificationReply,
  buildClarificationUnavailableReply,
  buildCategoryOptionsReply,
  CLARIFICATION_BLOCKS_CHECKOUT_NUDGE,
} from "./clarification";
import {
  unavailableItemMessage,
  itemNotInCartMessage,
  unknownRequestMessage,
  invalidQuantityMessage,
  invalidReplacementMessage,
  invalidCheckoutStepMessage,
} from "./errors";
import {
  buildOrderReviewReply,
  DELIVERY_OR_PICKUP_PROMPT,
  ADDRESS_REQUEST_PROMPT,
  NAME_REQUEST_PROMPT,
  buildFinalReviewReply,
  PENDING_VERIFICATION_REPLY,
  alreadyFinalizedMessage,
} from "./checkout";
import { buildRestaurantInfoReply } from "./restaurant";
import {
  THANKS_REPLY,
  GOODBYE_REPLY,
  SMALL_TALK_REPLY,
  IRRELEVANT_REDIRECT_REPLY,
  ORDER_CANCELLED_REPLY,
  NOTHING_TO_CANCEL_REPLY,
  buildHelpReply,
  buildHumanSupportReply,
  buildComplaintReply,
  buildRecommendationReply,
  buildWaitReply,
  buildYesReply,
  buildNoReply,
} from "./conversation";
import { formatCurrency, bulletList, joinParagraphs } from "./formatter";
import { pickEndingVariation } from "./variation";

export interface ResponseBuilderInput {
  parseResult: ParseResult;
  before: OrderContext;
  after: OrderContext;
  menu: Menu;
  restaurantConfig: RestaurantConfig;
}

const CHECKOUT_FLOW_INTENTS: ReadonlySet<IntentName> = new Set([
  "CHECKOUT_START",
  "CONFIRM_ORDER",
  "SELECT_DELIVERY",
  "SELECT_PICKUP",
  "PROVIDE_ADDRESS",
  "PROVIDE_NAME",
]);

// A bare salutation gets a welcome, not an apology. The parser guarantees
// GREETING only ever fires on a whole-message greeting, so this reply never
// displaces an order/question response.
export const GREETING_REPLY =
  'Assalam o Alaikum! Think Food mein khush aamdeed. Menu dekhne ke liye "menu" likhein, ya apna order type kar dein.';

// The V2 Customer Conversation Layer's intents — none of these ever mutate
// the cart; YES/NO may have already produced a state transition (confirm/
// submit) in the order state engine, in which case buildConversationalReply
// returns null and the transition prompt takes over.
const CONVERSATIONAL_INTENTS: ReadonlySet<IntentName> = new Set([
  "GREETING", "THANKS", "YES", "NO", "WAIT", "CANCEL_ORDER", "HUMAN_SUPPORT",
  "COMPLAINT", "RECOMMENDATION_REQUEST", "CONFUSED_CUSTOMER", "SMALL_TALK",
  "IRRELEVANT_QUERY", "HELP", "GOODBYE",
]);

function buildConversationalReply(
  intent: IntentName,
  before: OrderContext,
  after: OrderContext,
  menu: Menu,
  restaurantConfig: RestaurantConfig
): string | null {
  const stateChanged = before.state !== after.state;
  switch (intent) {
    case "GREETING":
      return GREETING_REPLY;
    case "THANKS":
      return THANKS_REPLY;
    case "GOODBYE":
      return GOODBYE_REPLY;
    case "SMALL_TALK":
      return SMALL_TALK_REPLY;
    case "IRRELEVANT_QUERY":
      return IRRELEVANT_REDIRECT_REPLY;
    case "HELP":
    case "CONFUSED_CUSTOMER":
      return buildHelpReply();
    case "HUMAN_SUPPORT":
      return buildHumanSupportReply(restaurantConfig);
    case "COMPLAINT":
      return buildComplaintReply(restaurantConfig);
    case "RECOMMENDATION_REQUEST":
      return buildRecommendationReply(menu);
    case "WAIT":
      return buildWaitReply(before);
    case "CANCEL_ORDER":
      return after.state === "CANCELLED" ? ORDER_CANCELLED_REPLY : NOTHING_TO_CANCEL_REPLY;
    case "YES":
      // A YES that already confirmed/submitted produced a transition — let
      // the transition prompt speak.
      return stateChanged ? null : buildYesReply(before);
    case "NO":
      return buildNoReply(before);
    default:
      return null;
  }
}

// Question-shaped intents whose answer must not be displaced by a same-turn
// state transition (see the informational-priority branch in buildResponse).
const INFORMATIONAL_INTENTS: ReadonlySet<IntentName> = new Set([
  "SHOW_MENU",
  "SHOW_OPTIONS",
  "SHOW_CART",
  "PRICE_QUERY",
  "HYPOTHETICAL_TOTAL",
  "ASK_RESTAURANT_INFO",
]);

function cartsDiffer(before: CartState, after: CartState): boolean {
  const key = (c: CartState) => c.items.map((i) => `${i.itemId}:${i.qty}`).sort().join(",");
  return key(before) !== key(after);
}

// What actually landed in the cart this turn, read from the real before/
// after diff rather than trusting parseResult's own item references —
// those can point at a candidate id from BEFORE clarification narrowed the
// answer down to a specific category (e.g. a bare "mexican" reply resolves
// to 3 menu-wide candidates — Sandwich/Pizza/Pasta — before the pending
// "which pasta?" question scopes it down to just Mexican Pasta; the raw
// ParseResult's candidateItemIds[0] still says "mexican-sandwich").
function cartGainedLines(before: CartState, after: CartState): { name: string; delta: number }[] {
  const beforeQty = new Map(before.items.map((line) => [line.itemId, line.qty]));
  return after.items
    .map((line) => ({ name: line.name, delta: line.qty - (beforeQty.get(line.itemId) ?? 0) }))
    .filter((entry) => entry.delta > 0);
}

// Mirrors cartGainedLines for the opposite direction — a line whose
// quantity dropped (including to zero, i.e. the line disappearing
// entirely) is read from `before`, since `after` no longer has it to name.
function cartLostLines(before: CartState, after: CartState): { name: string; delta: number }[] {
  const afterQty = new Map(after.items.map((line) => [line.itemId, line.qty]));
  return before.items
    .map((line) => ({ name: line.name, delta: (afterQty.get(line.itemId) ?? 0) - line.qty }))
    .filter((entry) => entry.delta < 0)
    .map((entry) => ({ name: entry.name, delta: -entry.delta }));
}

// Diff-based "what actually changed" confirmation — used for the
// multi-action case (this turn changed the cart AND still has a question
// pending for a DIFFERENT item), where parseResult.actions still describes
// the FULL original request (including parts that didn't resolve) rather
// than just what actually happened. Reading the real cart diff instead is
// robust regardless of how many items were requested or how many resolved.
//
// Originally only checked GAINED lines (added items) — a pure removal
// (REMOVE_ITEM/CHANGE_QUANTITY-down) while a different clarification stayed
// pending fell through to the generic "cart updated" confirmation without
// ever naming what was removed (live QA bug: "vegetable rice remove kar kar
// do" removed the item correctly but the reply said only "cart updated,"
// never "Vegetable Rice"). Now checks every direction: exactly one item
// gained AND exactly one lost reads as a replace (e.g. "gyro hata kar steak
// add karo" while a different clarification is pending) and gets the same
// replaceItemConfirmation phrasing used elsewhere in this file; a genuinely
// mixed multi-item turn beyond that single-for-single shape still falls
// back to the generic confirmation, since naming only part of a more
// complex change would be its own kind of misleading.
function buildAddedItemsSummary(before: CartState, after: CartState, menu: Menu): string {
  const gained = cartGainedLines(before, after);
  const lost = cartLostLines(before, after);
  if (gained.length === 1 && lost.length === 1) {
    return replaceItemConfirmation(lost[0].name, gained[0].name);
  }
  if (gained.length > 0 && lost.length === 0) {
    return gained.length === 1 ? addSingleItemConfirmation(gained[0].name, gained[0].delta) : addMultipleItemsConfirmation();
  }
  if (lost.length > 0 && gained.length === 0) {
    return lost.length === 1 ? removeItemConfirmation(lost[0].name) : removeMultipleItemsConfirmation();
  }
  return cartUpdatedConfirmation();
}

function resolvedName(menu: Menu, itemId: string | undefined, fallback: string): string {
  if (!itemId) return fallback;
  return findMenuItem(menu, itemId)?.name ?? fallback;
}

function buildMutationConfirmation(parseResult: ParseResult, before: OrderContext, after: OrderContext, menu: Menu): string {
  if (parseResult.actions.length > 1) {
    return cartUpdatedConfirmation();
  }

  const action = parseResult.actions[0];
  switch (action?.action) {
    case "ADD_ITEM": {
      // Confirm what actually LANDED, read from the real cart diff — never
      // trust action.items[0].candidateItemIds[0] directly. That id can be
      // stale: a clarification reply like bare "mexican" first resolves at
      // the menu-wide level to 3 candidates (Sandwich/Pizza/Pasta, in menu
      // order) before the pending "which pasta?" question scopes it down to
      // Mexican Pasta specifically — the raw ParseResult keeps reporting
      // "mexican-sandwich" (candidateItemIds[0]) even though the cart
      // engine correctly added Mexican Pasta, which used to make the
      // confirmation text name the wrong item while the cart itself was
      // right.
      const gained = cartGainedLines(before.cart, after.cart);
      if (gained.length === 1) {
        return addSingleItemConfirmation(gained[0].name, gained[0].delta);
      }
      const ref = action.items?.[0];
      const itemId = ref?.candidateItemIds?.[0];
      const name = resolvedName(menu, itemId, ref?.query ?? "Item");
      const qtyOf = (cart: CartState) => cart.items.find((line) => line.itemId === itemId)?.qty ?? 0;
      const fallbackGained = itemId ? qtyOf(after.cart) - qtyOf(before.cart) : 0;
      return addSingleItemConfirmation(name, fallbackGained > 0 ? fallbackGained : ref?.quantity ?? 1);
    }
    case "ADD_MULTIPLE_ITEMS":
      return addMultipleItemsConfirmation();
    case "REMOVE_ITEM": {
      const ref = action.items?.[0];
      const name = resolvedName(menu, ref?.candidateItemIds?.[0], ref?.query ?? "Item");
      return removeItemConfirmation(name);
    }
    case "REMOVE_ALL":
      return clearCartConfirmation();
    case "REPLACE_ITEM": {
      const replace = action.replace;
      const sourceIdInCart = (replace?.sourceCandidateItemIds ?? []).find((id) =>
        before.cart.items.some((line) => line.itemId === id)
      );
      const fromName = resolvedName(menu, sourceIdInCart, replace?.sourceQuery ?? "Item");
      const toName = resolvedName(menu, replace?.targetCandidateItemIds?.[0], replace?.targetQuery ?? "Item");
      return replaceItemConfirmation(fromName, toName);
    }
    case "CHANGE_QUANTITY":
      return changeQuantityConfirmation();
    default:
      return addMultipleItemsConfirmation();
  }
}

function buildCartMutationReply(parseResult: ParseResult, before: OrderContext, after: OrderContext, menu: Menu): string {
  const confirmation = buildMutationConfirmation(parseResult, before, after, menu);

  // Landing in ORDER_REVIEW (either starting checkout, or bouncing back to
  // it after an edit made during a later checkout step) always means the
  // customer needs to re-confirm against the updated cart — the review's
  // own call-to-action takes the place of the generic dynamic ending.
  if (after.state === "ORDER_REVIEW") {
    const summary = buildOrderSummary(after.cart, menu, "Updated Order");
    return joinParagraphs(confirmation, summary, 'Agar sab theek hai to "Confirm Order" likhein.');
  }

  const summary = buildOrderSummary(after.cart, menu, "Current Order");
  const ending = pickEndingVariation(parseResult.rawUserMessage);
  return joinParagraphs(confirmation, summary, ending);
}

function buildStateTransitionReply(after: OrderContext, menu: Menu): string {
  switch (after.state) {
    case "ORDER_REVIEW":
      return buildOrderReviewReply(after.cart, menu);
    case "AWAITING_DELIVERY_PICKUP":
      return DELIVERY_OR_PICKUP_PROMPT;
    case "AWAITING_ADDRESS":
      return ADDRESS_REQUEST_PROMPT;
    case "AWAITING_NAME":
      return NAME_REQUEST_PROMPT;
    case "READY_TO_SUBMIT":
      return buildFinalReviewReply(after.cart, menu, after.deliveryType, after.address, after.customerName);
    case "PENDING_VERIFICATION":
      return PENDING_VERIFICATION_REPLY;
    case "CANCELLED":
      // The turn that CANCELS gets a proper cancellation confirmation;
      // messages arriving after cancellation still get
      // alreadyFinalizedMessage via buildResponse's first branch.
      return ORDER_CANCELLED_REPLY;
    case "CART_EDITING":
      return buildOrderSummary(after.cart, menu, "Current Order");
    default:
      return unknownRequestMessage();
  }
}

function buildFullMenuReply(menu: Menu): string {
  const sections = menu.categories.map((cat) => {
    const lines = cat.items.map((i) => `${i.name} — ${formatCurrency(i.price)}`);
    return `${cat.title}\n${bulletList(lines)}`;
  });
  return joinParagraphs("Hamara Menu:", ...sections);
}

function buildPriceReply(parseResult: ParseResult, menu: Menu): string {
  const ref = parseResult.items[0];
  const itemId = ref?.candidateItemIds?.length === 1 ? ref.candidateItemIds[0] : undefined;
  if (itemId) {
    const item = findMenuItem(menu, itemId);
    if (item) return `${item.name} ki price ${formatCurrency(item.price)} hai.`;
  }
  return "Is item ki price ke liye barah-e-meherbani item ka sahi naam batayein.";
}

// "kitna total hua"/"total kitna hoga" always means the CART's total, never
// a single item's price — unlike PRICE_QUERY, this must not fall back to
// "give me the item name" just because no specific item was mentioned.
function buildHypotheticalTotalReply(cart: CartState, menu: Menu): string {
  if (cart.items.length === 0) return EMPTY_CART_MESSAGE;
  const totals = calculateTotal(cart, menu);
  return `Total: ${formatCurrency(totals.subtotal)}`;
}

function buildInformationalReply(
  parseResult: ParseResult,
  before: OrderContext,
  menu: Menu,
  restaurantConfig: RestaurantConfig
): string {
  switch (parseResult.intent) {
    case "GREETING":
      return GREETING_REPLY;
    case "SHOW_MENU":
      return buildFullMenuReply(menu);
    case "SHOW_OPTIONS": {
      const ref = parseResult.items[0];
      const options = (ref?.candidateItemIds ?? [])
        .map((id) => findMenuItem(menu, id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      return buildCategoryOptionsReply(parseResult.category ?? ref?.query ?? "item", options);
    }
    case "SHOW_CART":
      return buildOrderSummary(before.cart, menu, "Aapki Cart");
    case "PRICE_QUERY":
      return buildPriceReply(parseResult, menu);
    case "HYPOTHETICAL_TOTAL":
      return buildHypotheticalTotalReply(before.cart, menu);
    case "ASK_RESTAURANT_INFO":
      return buildRestaurantInfoReply(restaurantConfig);
    default:
      if (CHECKOUT_FLOW_INTENTS.has(parseResult.intent)) return invalidCheckoutStepMessage();
      return unknownRequestMessage();
  }
}

export function buildResponse(input: ResponseBuilderInput): string {
  const { parseResult, before, after, menu, restaurantConfig } = input;

  if (before.state === "PENDING_VERIFICATION" || before.state === "CANCELLED") {
    return alreadyFinalizedMessage(before.state);
  }

  const cartChanged = cartsDiffer(before.cart, after.cart);

  if (after.state === "AWAITING_CLARIFICATION" && after.pendingClarification) {
    // The reply named something real but from a different category than
    // the one being asked about (e.g. "club" while "which pasta?" is
    // pending) — say so explicitly instead of just repeating the question
    // with no context (rule 5).
    if (after.lastAction === "CLARIFICATION_UNAVAILABLE_IN_CATEGORY") {
      return buildClarificationUnavailableReply(after.pendingClarification);
    }

    const clarification = buildClarificationReply(after.pendingClarification);

    // Rule 8 (Clarification Queue): informational/conversational messages
    // sent while a clarification is preserved still get answered — never
    // silently swallowed just because a question is pending. Excludes YES
    // and NO: both are handled by the order state engine ITSELF against
    // the pending queue (YES is ambiguous mid-clarification — doesn't say
    // WHICH item; NO declines the current question and may have already
    // advanced to the next one) — showing the (possibly-advanced)
    // clarification question below is always the right reply for either,
    // never a generic "sure!"/"okay!" conversational reply.
    if (!cartChanged && CONVERSATIONAL_INTENTS.has(parseResult.intent) && parseResult.intent !== "YES" && parseResult.intent !== "NO") {
      const conversational = buildConversationalReply(parseResult.intent, before, after, menu, restaurantConfig);
      if (conversational) return conversational;
    }
    if (!cartChanged && INFORMATIONAL_INTENTS.has(parseResult.intent)) {
      return buildInformationalReply(parseResult, before, menu, restaurantConfig);
    }
    // Checkout-flow intents are blocked while a clarification is pending —
    // nudge the customer to resolve it first instead of silently ignoring
    // the checkout attempt.
    if (!cartChanged && CHECKOUT_FLOW_INTENTS.has(parseResult.intent)) {
      return joinParagraphs(CLARIFICATION_BLOCKS_CHECKOUT_NUDGE, clarification);
    }

    // The multi-action case: this turn both added something exact AND still
    // has a question pending for a DIFFERENT item — confirm what landed,
    // then ask (rule 7: "tell customer what was added and what still needs
    // confirmation").
    if (cartChanged) {
      return joinParagraphs(buildAddedItemsSummary(before.cart, after.cart, menu), clarification);
    }

    return clarification;
  }

  if (parseResult.safetyDecision === "REJECT_UNAVAILABLE") {
    const rejected = parseResult.items.filter((i) => (i.candidateItemIds?.length ?? 0) === 0).map((i) => i.query);
    const replaceAction = parseResult.actions.find((a) => a.action === "REPLACE_ITEM");
    const target = replaceAction?.replace?.targetCandidateItemIds?.length === 0 ? replaceAction.replace.targetQuery : undefined;
    // || (not ??) so an EMPTY query string still falls through to the
    // generic label instead of printing a blank slot in the reply.
    return unavailableItemMessage(rejected[0] || target || "yeh item");
  }

  if (parseResult.safetyDecision === "REJECT_NOT_IN_CART") {
    const replaceAction = parseResult.actions.find((a) => a.action === "REPLACE_ITEM");
    const missing = parseResult.items[0]?.query || replaceAction?.replace?.sourceQuery;
    return itemNotInCartMessage(missing || "yeh item");
  }

  // Conversation layer — conversational intents get their reply before any
  // state-transition narration (a YES that confirmed the review returns
  // null here and falls through to the AWAITING_DELIVERY_PICKUP prompt).
  if (!cartChanged && CONVERSATIONAL_INTENTS.has(parseResult.intent)) {
    const conversational = buildConversationalReply(parseResult.intent, before, after, menu, restaurantConfig);
    if (conversational) return conversational;
  }

  // Informational questions (price, restaurant info, menu, cart) get their
  // ANSWER even when the turn also produced a bookkeeping state change —
  // e.g. asking the timing mid-clarification drops the stale clarification
  // (AWAITING_CLARIFICATION -> CART_EDITING), but the customer still asked
  // a question, and answering it beats narrating the state transition. The
  // QA simulator caught both that case and price questions during checkout
  // going unanswered.
  if (!cartChanged && INFORMATIONAL_INTENTS.has(parseResult.intent)) {
    return buildInformationalReply(parseResult, before, menu, restaurantConfig);
  }

  if (parseResult.safetyDecision === "SAFE_TO_EXECUTE" && parseResult.actions.length > 0 && !cartChanged) {
    const primary = parseResult.actions[0]?.action;
    if (primary === "REMOVE_ALL") return clearCartConfirmation();
    if (primary === "CHANGE_QUANTITY") return invalidQuantityMessage();
    if (primary === "REPLACE_ITEM") return invalidReplacementMessage();
    return unknownRequestMessage();
  }

  if (cartChanged) {
    return buildCartMutationReply(parseResult, before, after, menu);
  }

  if (before.state !== after.state) {
    return buildStateTransitionReply(after, menu);
  }

  // Stuck in the same state with nothing else resolving it — while
  // awaiting a specific answer (address/name), re-prompt for exactly that
  // rather than falling through to a generic "I don't understand."
  if (before.state === "AWAITING_ADDRESS") return ADDRESS_REQUEST_PROMPT;
  if (before.state === "AWAITING_NAME") return NAME_REQUEST_PROMPT;

  return buildInformationalReply(parseResult, before, menu, restaurantConfig);
}

export { formatCurrency, EMOJI, bulletList, joinParagraphs } from "./formatter";
export {
  addSingleItemConfirmation,
  addMultipleItemsConfirmation,
  removeItemConfirmation,
  clearCartConfirmation,
  replaceItemConfirmation,
  changeQuantityConfirmation,
  cartUpdatedConfirmation,
} from "./templates";
export { buildOrderSummary, EMPTY_CART_MESSAGE } from "./order-summary";
export { buildClarificationReply, buildCategoryOptionsReply } from "./clarification";
export {
  unavailableItemMessage,
  itemNotInCartMessage,
  unknownRequestMessage,
  invalidQuantityMessage,
  invalidReplacementMessage,
  invalidCheckoutStepMessage,
} from "./errors";
export {
  buildOrderReviewReply,
  DELIVERY_OR_PICKUP_PROMPT,
  ADDRESS_REQUEST_PROMPT,
  NAME_REQUEST_PROMPT,
  buildFinalReviewReply,
  PENDING_VERIFICATION_REPLY,
  alreadyFinalizedMessage,
} from "./checkout";
export { buildRestaurantInfoReply } from "./restaurant";
export { pickEndingVariation, pickVariation, ENDING_VARIATIONS } from "./variation";
export {
  THANKS_REPLY,
  GOODBYE_REPLY,
  SMALL_TALK_REPLY,
  IRRELEVANT_REDIRECT_REPLY,
  ORDER_CANCELLED_REPLY,
  NOTHING_TO_CANCEL_REPLY,
  buildHelpReply,
  buildHumanSupportReply,
  buildComplaintReply,
  buildRecommendationReply,
  pickPopularItems,
  buildWaitReply,
  buildYesReply,
  buildNoReply,
} from "./conversation";
