// V3 Phase 2 — Fact Verifier.
//
// Extends correct-reply.ts's existing bounded-correction posture (item
// names/totals/clarification outcomes — Phase 1) with the THREE new
// verification categories Phase 2 needs: recommendation items must be real,
// a category-browse request must show only that category (or the full
// menu), and restaurant-info questions must state the real config values.
// Same rule as correct-reply.ts: narrow, explicit, deterministic checks —
// never a second LLM call, never a generic rewrite.

import type { Menu, MenuCategory, MenuItem, RestaurantConfig } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { OrderState } from "../../v2/types/order";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { recommendItems } from "./recommendation-engine";
import type { RecommendationOutcome } from "./multi-intent";
import type { PendingRemovalContext } from "./conversation-memory";
import type { CheckoutAction, RecommendationTheme } from "./schema";

// Shared by every renderer below that needs an itemized cart + real total —
// one formatting rule so "current order" always looks the same everywhere
// it's shown (no-more-items prompt, checkout review, final review).
export function renderOrderItemsBlock(cart: CartState, menu: Menu): string {
  const { subtotal } = calculateTotal(cart, menu);
  const lines = cart.items.map((line) => `• ${line.name} × ${line.qty} — PKR ${line.price * line.qty}`).join("\n");
  return `${lines}\n\nTotal: PKR ${subtotal}`;
}

// ─── Recommendation verification ────────────────────────────────────────────
//
// The reply was drafted by the model BEFORE recommendation-engine.ts
// resolved real items for the request, so it may have named nothing real
// at all (or invented something) — or, a real live gap, named the right
// items but with NO price at all ("Spicy Stuff Burger aur Hot Shot try
// karein" — no PKR anywhere), which used to slip through unmodified since
// this only ever checked whether the NAME was mentioned, never the price.
// Requirement: "never show a menu item without its price." Every
// recommended item must appear with its exact "PKR <price>" — if even ONE
// is missing its price (or missing entirely, or invented), the model's
// draft is discarded outright in favor of a clean, deterministic, fully
// price-tagged list — menu accuracy is safety-critical, phrasing isn't,
// same posture as every other override in this file.
export function verifyRecommendation(reply: string, recommendation: RecommendationOutcome | null): string {
  if (!recommendation || recommendation.items.length === 0) return reply;
  const allNamedWithPrice = recommendation.items.every(
    (item) => reply.toLowerCase().includes(item.name.toLowerCase()) && reply.includes(`PKR ${item.price}`)
  );
  if (allNamedWithPrice) return reply;

  const lines = recommendation.items.map((item) => `• ${item.name} — PKR ${item.price}`).join("\n");
  return `Aap yeh try kar sakte hain:\n${lines}`;
}

// ─── Theme-suggestion fallback (deterministic, raw-text-driven) ────────────
//
// verifyRecommendation above only fires when the MODEL itself set
// `recommendationRequest` on its plan — but a live bug showed the model can
// simply fail to classify a themed request at all ("hot and spicy ma kuch
// batao mujhe" got a bare, contentless deflection — "Backend aapko menu se
// spicy items dikha dega." — instead of any real items). This mirrors
// renderCategoryBrowseIfApplicable's posture: detect the theme straight from
// the customer's own raw text as a SEPARATE, independent signal, and when
// the model's own structured classification missed it, replace the whole
// reply with the real, menu-verified suggestion outright — never trust the
// model's free-form deflection to already contain real content.
const THEME_PATTERNS: { pattern: RegExp; theme: RecommendationTheme }[] = [
  { pattern: /\bspicy\b|\bhot\s*(and|aur|&)\s*spicy\b|\bteekha\b|\btikha\b|\bchatpata\b/i, theme: "spicy" },
  { pattern: /\bmild\b|\bhalka\b|\bkam\s*teekha\b|\bkam\s*tikha\b|\bnot\s*spicy\b/i, theme: "mild" },
  { pattern: /\bpopular\b|\bbest\s*seller\b|\bmashhoor\b|\bfamous\b|\bspecial(ity)?\b/i, theme: "popular" },
  { pattern: /\bkids?\b|\bbach[ao]n\b|\bbache\b/i, theme: "kids" },
  { pattern: /\bvegetarian\b|\bveg\b|\bbina\s*gosht\b/i, theme: "vegetarian" },
];

function renderThemeSuggestion(theme: RecommendationTheme, menu: Menu, categoryHint?: string): string | null {
  let items = recommendItems(menu, theme, categoryHint);
  if (items.length === 0) items = recommendItems(menu, theme);
  if (items.length === 0) return null;
  const lines = items.map((item) => `• ${item.name} — PKR ${item.price}`).join("\n");
  return `Ji, ${theme} options mein aap ye try kar sakte hain:\n${lines}\n\nIn mein se koi add karna ho to naam bata dein.`;
}

// Only fires when the model's OWN plan produced no recommendation this turn
// (recommendation === null, checked by the caller) — never overrides a
// request the model already classified and resolved correctly. Precedence
// against every other tier (never firing on a turn that already did
// something structural, never beating a higher-priority order/total/menu
// request) is now the reply-orchestrator's job (see reply-orchestrator.ts)
// — this function only ever answers "does the raw text look like a themed
// suggestion request," nothing else.
export function renderThemeSuggestionIfApplicable(customerMessage: string, menu: Menu, categoryHint: string | undefined): string | null {
  const match = THEME_PATTERNS.find((t) => t.pattern.test(customerMessage));
  return match ? renderThemeSuggestion(match.theme, menu, categoryHint) : null;
}

// ─── Category-browse verification ───────────────────────────────────────────

// Originally anchored to end-of-string with only a narrow set of allowed
// trailing words ("menu\s*(dikhao|dikha do|batao)?\s*$") — any OTHER
// trailing filler ("menu please", "show menu please", "menu yaar") broke
// the `$` anchor entirely, so the message matched neither this nor the
// outer gate's full-menu branch and fell through to the model's own
// (sometimes intro-only) draft. Simplified to a bare "menu" word check: by
// the time this is reached, the outer gate already required a listing/
// availability signal AND no specific CATEGORY_KEYWORD matched, so any
// remaining mention of the word "menu" at all safely means "show
// everything," regardless of what comes before or after it.
const FULL_MENU_PATTERN = /\bmenu\b/i;
// "kya kya"/"kia kia" is an Urdu/Roman-Urdu reduplication idiom meaning
// "what all" — "kia" is a very common alternate spelling of "kya" that the
// original pattern didn't recognize at all (live bug: "or kia kia available
// hai hamre pass" matched neither this gate nor FULL_MENU_PATTERN below,
// so it fell through to the model's own free-form draft with nothing to
// keep it honest). Also covers a single (non-reduplicated) "kya"/"kia"
// paired with "available" ("kya available hai") — the same generic "what
// do you have" question without the reduplication idiom.
const GENERAL_AVAILABILITY_PATTERN = /\b(?:kya|kia)\s*(?:kya|kia)\b|\b(?:kya|kia)\b\s*available\b|\bavailable\b\s*(?:kya|kia)\b/i;
// "chahiye"/"chahye"/"chaiye" ("I want") paired with a bare category name
// and nothing else specific ("mujhe pasta chahiye") is a genuine live gap:
// the model sometimes answers this conversationally instead of emitting any
// cartAction at all, so `facts.newlyQueued` never gets set and the
// clarification-prompt override below never runs — this override is the
// ONLY backend safety net left for that case. Safe to fold into the same
// gate as dikhao/batao/menu: this function only ever RENDERS when a real
// CATEGORY_KEYWORD also matches (see below) or a full-menu/general-
// availability phrase matches — a bare "chahiye" alone (no category) still
// renders nothing. When `hadStructuredAction` is already true (the model DID
// successfully act on a specific item), this override never even runs, so
// it can't clobber a legitimate "Zinger Burger add ho gaya" reply.
const LISTING_INTENT_PATTERN =
  /\b(dikhao|dikha\s*do|dikha\s*den|batao|bata\s*do|show|list|options?|kya\s*kya|kia\s*kia|menu|chahiye|chahye|chaiye)\b/i;

const CATEGORY_KEYWORDS: { pattern: RegExp; key: string }[] = [
  { pattern: /\bburgers?\b/i, key: "burgers" },
  { pattern: /\bsandwich(es)?\b/i, key: "sandwiches" },
  { pattern: /\bpizza\s*fries\b/i, key: "pizzaFries" },
  { pattern: /\bpizzas?\b/i, key: "pizza" },
  { pattern: /\broll(s)?\b|\bgyro\b|\bwrap\b/i, key: "rolls" },
  { pattern: /\bpasta\b/i, key: "pasta" },
  { pattern: /\bnoodles?\b|\bchowmein\b/i, key: "noodles" },
  { pattern: /\brice\b/i, key: "rice" },
  { pattern: /\bstarters?\b/i, key: "starters" },
  { pattern: /\bsteaks?\b/i, key: "steaks" },
  { pattern: /\btoppings?\b/i, key: "toppings" },
];

function renderCategory(category: MenuCategory): string {
  const lines = category.items.map((item) => `• ${item.name} — PKR ${item.price}`).join("\n");
  return `${category.title}:\n${lines}`;
}

function renderFullMenu(menu: Menu): string {
  return menu.categories.map(renderCategory).join("\n\n");
}

// Deterministically detects a category/full-menu browse request straight
// from the customer's own message (never from the model's interpretation
// of it) and renders the REAL item list — replacing the model's draft
// entirely for this one, narrow, safety-critical case (menu accuracy),
// rather than trying to verify arbitrary free-text item listings after the
// fact. Returns null (leave the model's reply alone) whenever this isn't
// confidently a pure browse request, so it never fires on an order
// ("burger add karo") or a price question. Precedence against cart/
// checkout/order-review/recommendation is the reply-orchestrator's job
// (see reply-orchestrator.ts) — this function only ever answers "does the
// raw text look like a menu/category browse request."
export function renderCategoryBrowseIfApplicable(customerMessage: string, menu: Menu): string | null {
  if (!LISTING_INTENT_PATTERN.test(customerMessage) && !GENERAL_AVAILABILITY_PATTERN.test(customerMessage)) return null;

  // A specific category word always wins over a bare "menu" mention
  // ("pizza menu dikhao" must show only Pizza, not everything) — only a
  // message naming NO specific category falls through to the full-menu check.
  const match = CATEGORY_KEYWORDS.find((c) => c.pattern.test(customerMessage));
  if (match) {
    const category = menu.categories.find((c) => c.key === match.key);
    return category ? renderCategory(category) : null;
  }

  // A general "what all do you have" question (no specific category, no
  // literal word "menu" either) still means "show me everything" — live bug:
  // "or kia kia available hai hamre pass" used to fall through here with a
  // blank/empty-content reply from the model ("Hamare paas poora menu yeh
  // hai:" with nothing listed after it).
  return FULL_MENU_PATTERN.test(customerMessage) || GENERAL_AVAILABILITY_PATTERN.test(customerMessage) ? renderFullMenu(menu) : null;
}

// ─── Menu intro-only fallback (last-resort safety net) ─────────────────────
//
// Live bug: "Menu please" got "Sure, here's our full menu for you!" — an
// intro line with ZERO actual items. renderCategoryBrowseIfApplicable above
// already covers every phrasing this project has found so far, but the
// customer can always phrase a menu request in some way that pattern hasn't
// been taught yet — and a model that talks ABOUT showing the menu without
// actually listing it is a distinct failure mode from "didn't recognize
// this as a menu request" at all. This is the backstop for exactly that:
// if the (already fact-checked) draft reply mentions "menu" anywhere but
// contains not a single real, priced item line, the model is treated as
// having failed to deliver menu content — replaced outright with the real,
// fully-priced menu, never trusting the model's own claim that it showed
// one. Precedence against every higher tier is the reply-orchestrator's
// job (see reply-orchestrator.ts) — EXCEPT one thing this function must
// still decide for itself: it inspects the DRAFT REPLY text, not the
// customer's own message, so a completely unrelated question (a live
// regression: "kahan hai" — pure location, nothing menu-related about it
// at all) whose model draft happens to hallucinate the word "menu" while
// deflecting must never be mistaken for a failed menu request. Guarded by
// requiring the customer's OWN message not already be a restaurant-info
// ask (INFO_TOPICS, defined below) — a genuinely untaught menu phrasing
// ("hey what do you guys offer around here") never matches an info topic,
// so this backstop still fires for exactly the cases it was built for.
function hasAnyPricedItemLine(text: string): boolean {
  return text.split("\n").some((line) => line.trim().startsWith("•") && /PKR\s*\d+/.test(line));
}

export function renderMenuIntroOnlyFallbackIfApplicable(customerMessage: string, reply: string, menu: Menu): string | null {
  if (!/\bmenu\b/i.test(reply)) return null;
  if (hasAnyPricedItemLine(reply)) return null;
  if (INFO_TOPICS.some((topic) => topic.pattern.test(customerMessage))) return null;
  return renderFullMenu(menu);
}

// ─── Total-query verification (Phase 3, requirement #2) ────────────────────
//
// "kitna total hua"/"bill kitna hai"/"total batao"/"mera order kitne ka
// hua" must NEVER get a vague, numberless reply (a real gap this session's
// live validation found: the model sometimes deferred with "backend se
// calculate hoga" instead of just stating the number it already has). This
// deterministically renders the REAL cart summary + total straight from
// the backend, replacing the model's draft outright — the exact same
// "menu accuracy is safety-critical" trade-off as the category-browse
// override above.
// Deliberately scoped to "total"/"bill"/"order" (never a bare "kitna ka
// hai", which is usually asking a single ITEM's price, not the cart total)
// — this is what keeps it from misfiring on a per-item price question.
const TOTAL_QUERY_PATTERN = /\btotal\b|\bbill\b|\border\b.*\b(kitna|kitne|hua)\b|\b(kitna|kitne)\b.*\border\b/i;

const EMPTY_CART_TOTAL_REPLY = "Aapka cart abhi khali hai. Kuch order karna chahenge?";

function renderCartTotal(cart: CartState, menu: Menu): string {
  if (cart.items.length === 0) return EMPTY_CART_TOTAL_REPLY;
  const { subtotal } = calculateTotal(cart, menu);
  const lines = cart.items.map((line) => `• ${line.name} x${line.qty} — PKR ${line.price * line.qty}`).join("\n");
  return `${lines}\n\nTotal: PKR ${subtotal}`;
}

// Precedence against a legitimate "added X, your total is now Y" cart-
// mutation reply (and everything else) is the reply-orchestrator's job —
// this only ever answers "is this a total/bill question," nothing else.
export function renderTotalReplyIfApplicable(customerMessage: string, cart: CartState, menu: Menu): string | null {
  if (!TOTAL_QUERY_PATTERN.test(customerMessage)) return null;
  return renderCartTotal(cart, menu);
}

// ─── Current-order / cart-review request (reply-orchestrator tier 3) ──────
//
// Live bug: "order dikhao" got "Aapka current order yeh hai:" with the
// items and total simply never following it — nothing in this file
// deterministically verified a bare "show me my order/cart" request at
// all, so a model that drafted only the intro sentence (never actually
// listing anything) passed straight through unmodified. Same "backend
// facts override the LLM's narration" posture as every other override
// here: detects the request straight from the customer's raw text and
// renders the REAL itemized cart + total (or a friendly empty-cart
// message), never trusting the model's own claim that it already showed
// the order.
const ORDER_REVIEW_PATTERN =
  /\b(order|cart)\b[\s\S]{0,20}\b(dikhao|dikha\s*do|dikha\s*den|batao|bata\s*do|show)\b|\b(dikhao|dikha\s*do|dikha\s*den|batao|bata\s*do|show)\b[\s\S]{0,20}\b(order|cart)\b|\bcurrent\s*order\b|\bmera\s*order\b|\bmy\s*order\b|\bkya\s*(order|cart)\s*hai\b|\b(order|cart)\s*kya\s*hai\b/i;

export function renderCurrentOrderIfApplicable(customerMessage: string, cart: CartState, menu: Menu): string | null {
  if (!ORDER_REVIEW_PATTERN.test(customerMessage)) return null;
  if (cart.items.length === 0) return EMPTY_CART_TOTAL_REPLY;
  return `Aapka current order yeh hai:\n${renderOrderItemsBlock(cart, menu)}`;
}

// ─── Ambiguous-removal verification (Phase 3, requirement #5) ──────────────
//
// A newly-queued V3-only removal clarification (see actions.ts/
// clarification-engine.ts) means the cart did NOT change this turn — but
// the model drafted its reply BEFORE that was known, so it may have
// falsely claimed something was removed. The definitively-known "still
// need to ask which one" fact always wins, same posture as correct-reply.ts's
// correctClarificationOutcome/correctUnavailable. Returns null (rather than
// the original reply) when not applicable, so the reply-orchestrator can
// treat this as a normal tier candidate.
export function renderPendingRemovalIfApplicable(pendingRemoval: PendingRemovalContext | null | undefined): string | null {
  if (!pendingRemoval) return null;
  const options = pendingRemoval.options.map((o) => o.name).join(", ");
  return `Aapke cart mein ${pendingRemoval.options.length} items match karte hain: ${options}. Kaunsa hata dein?`;
}

// ─── Still-ambiguous clarification-answer verification (Phase 4 live-audit
// finding) ────────────────────────────────────────────────────────────────
//
// A follow-up reply that's STILL ambiguous within the pending options
// (e.g. it matches 2+ of the exact options this question offered) means
// nothing was added this turn — but the model drafted its reply before
// that was known and may have falsely claimed success (the live-acceptance
// run caught this exact case). Same posture as renderPendingRemovalIfApplicable
// above: the definitively-known "still need to ask" fact always wins, and
// null (not the original reply) signals "not applicable" to the orchestrator.
export function renderStillAmbiguousIfApplicable(stillAmbiguous: { category: string; options: MenuItem[] } | null): string | null {
  if (!stillAmbiguous) return null;
  const options = stillAmbiguous.options.map((o) => o.name).join(", ");
  return `Yeh abhi bhi clear nahi hai. Meherbani karke in mein se poora naam batayein: ${options}.`;
}

// ─── Rejected checkout action verification (Phase 3B, general case) ───────
//
// checkout-guard.ts already forces the RIGHT action while AWAITING_NAME/
// AWAITING_ADDRESS, so it can't misfire there — but the model can still
// pick the wrong checkoutAction verb at any OTHER checkout step (live
// validation caught this: it retried start_checkout instead of
// confirm_order in ORDER_REVIEW, got correctly rejected by the existing
// guards in actions.ts, then falsely told the customer their address was
// already saved while still stuck in ORDER_REVIEW). Any time
// `facts.checkoutRejected` is set — REGARDLESS of which state — the
// backend definitively knows nothing changed, so the reply is always
// replaced with an honest, reason-specific message rather than trusting
// whatever the model drafted for the action it WISHED had worked.
function checkoutRejectionMessage(reason: string): string {
  switch (reason) {
    case "empty_cart":
      return "Aapka cart abhi khali hai — pehle kuch order karein, phir checkout karte hain.";
    case "nothing_to_cancel":
      return "Abhi cancel karne ke liye kuch nahi hai.";
    case "invalid":
      return "Yeh valid nahi hai, meherbani karke dobara batayein.";
    default:
      return "Yeh abhi possible nahi hai — chaliye order jaari rakhte hain.";
  }
}

export function verifyCheckoutRejection(reply: string, checkoutRejected: { action: CheckoutAction["type"]; reason: string } | null): string {
  return checkoutRejected ? checkoutRejectionMessage(checkoutRejected.reason) : reply;
}

// ─── Clarification-prompt verification (Phase 3C, requirement #1; widened
// for the menu-price-formatting fix) ────────────────────────────────────
//
// "mujhe pasta chahiye" must list ALL matching options (all 5 Pasta
// flavours/sizes) WITH PRICES, never just a narrowed, price-less subset
// the model happened to mention (live validation caught it asking only
// "chota ya bara?"; a later live bug showed even the family-scoped case
// could reach the customer with no prices at all, since this override used
// to skip it entirely). Originally only fired when the ambiguity spanned
// the WHOLE menu category (options count matches the category's own item
// count) — a narrower, family-scoped ambiguity (bare "zinger" matching 3 of
// 6 burger items) was deliberately left to the model's own phrasing, since
// forcing the broad category NAME on a narrower option list would
// reintroduce the exact "kaunsa Burgers chahenge" (should say "Zinger")
// mismatch bug documented elsewhere in this project's history. That
// mismatch was only ever about which LABEL to use, not whether to show
// real prices — fixed by using the real category's title when the
// ambiguity spans the whole category, and a title-cased version of the
// parser's own already-correctly-scoped family label (e.g. "zinger" ->
// "Zinger") otherwise, while ALWAYS rendering every real option with its
// price regardless of scope.
function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renderClarificationPromptIfApplicable(
  newlyQueued: { category: string; quantity: number; options: MenuItem[] }[],
  menu: Menu
): string | null {
  if (newlyQueued.length === 0) return null;
  const first = newlyQueued[0];
  if (first.options.length === 0) return null;
  const category = menu.categories.find((c) => c.key === first.category);
  const label = category ? category.title : titleCase(first.category);

  const lines = first.options.map((o) => `• ${o.name} — PKR ${o.price}`).join("\n");
  return `Aap kaunsa ${label} chahenge?\n${lines}`;
}

// ─── "Nahi more items" verification (Phase 3C, requirement #2) ────────────
//
// A short "nahi"/"no"/"bas"/"bas yahi"/"aur kuch nahi" after adding
// something must always move the conversation toward checkout — never sit
// idle waiting on the model's own (unreliable) read of a one-word reply.
const NO_MORE_ITEMS_REPLIES: ReadonlySet<string> = new Set([
  "nahi", "no", "nope", "bas", "bas yahi", "aur kuch nahi", "bas hogaya", "bas ho gaya", "nahi bas",
]);

export function isNoMoreItemsReply(customerMessage: string): boolean {
  return NO_MORE_ITEMS_REPLIES.has(customerMessage.trim().toLowerCase());
}

export function renderNoMoreItemsReplyIfApplicable(customerMessage: string, cart: CartState, menu: Menu): string | null {
  if (cart.items.length === 0) return null;
  if (!isNoMoreItemsReply(customerMessage)) return null;
  return `Theek hai. Aapka current order ye hai:\n${renderOrderItemsBlock(cart, menu)}\n\nAgar order proceed karna hai to 'checkout' likh dein.`;
}

// ─── Checkout-start verification (Phase 3C, requirement #3) ───────────────
//
// Checkout must ALWAYS open with the full, real order review before ever
// asking delivery/pickup — never let the model skip straight to that
// question on its own initiative.
export function renderCheckoutReviewIfApplicable(checkoutApplied: CheckoutAction["type"] | null, cart: CartState, menu: Menu): string | null {
  if (checkoutApplied !== "start_checkout") return null;
  return `Order Review:\n${renderOrderItemsBlock(cart, menu)}\n\nDelivery chahiye ya pickup?`;
}

// ─── Final-submission verification (Phase 3C, requirement #6) ─────────────
//
// The ONLY moment "order confirmed"-type language is ever accurate is the
// instant the backend state actually reaches PENDING_VERIFICATION — every
// other confirm_order (the earlier ORDER_REVIEW -> AWAITING_DELIVERY_PICKUP
// one) must never say this. Even here, the honest wording is "sent for
// verification", not "confirmed" (per this restaurant's real
// requiresManualVerification flow — staff still has to call and confirm).
export function renderFinalSubmitReplyIfApplicable(checkoutApplied: CheckoutAction["type"] | null, nextState: OrderState): string | null {
  if (checkoutApplied !== "confirm_order" || nextState !== "PENDING_VERIFICATION") return null;
  return "Order verification ke liye send ho gaya hai. Staff confirm karega.";
}

// ─── Post-order acknowledgment verification (Phase 3C, requirement #5) ────
//
// Once PENDING_VERIFICATION, a plain "okay"/"thanks" must get ONE polite
// acknowledgment, never a repeat of the finalization message — and every
// repeat after that gets a short, distinct "already in verification" reply.
const POST_ORDER_ACK_REPLIES: ReadonlySet<string> = new Set([
  "okay", "ok", "k", "kk", "theek hai", "thanks", "thank you", "shukriya", "shukriya!",
]);

function isPostOrderAck(customerMessage: string): boolean {
  return POST_ORDER_ACK_REPLIES.has(customerMessage.trim().toLowerCase());
}

export interface PostOrderAckOutcome {
  reply: string;
  markThanked: true;
}

export function renderPostOrderAckReply(priorState: OrderState, customerMessage: string, alreadyThanked: boolean): PostOrderAckOutcome | null {
  if (priorState !== "PENDING_VERIFICATION") return null;
  if (!isPostOrderAck(customerMessage)) return null;
  return alreadyThanked
    ? { reply: "Ji, order already verification mein hai.", markThanked: true }
    : { reply: "Ji, shukriya. Aapka order verification ke liye send ho chuka hai. Staff jald confirm kar dega.", markThanked: true };
}

// ─── Restaurant info verification ───────────────────────────────────────────

const INFO_TOPICS: { pattern: RegExp; check: (reply: string, config: RestaurantConfig) => string | null }[] = [
  {
    pattern: /\b(address|location|kahan|kidhar)\b/i,
    check: (reply, config) => (reply.includes(config.address) ? null : `Address: ${config.address}`),
  },
  {
    pattern: /\b(phone|number|contact|rabta)\b/i,
    check: (reply, config) => (reply.includes(config.phone) ? null : `Phone: ${config.phone}`),
  },
  {
    pattern: /\b(timing|time|khulte|band|hours)\b/i,
    check: (reply, config) => (reply.includes(config.timing) ? null : `Timing: ${config.timing}`),
  },
  {
    pattern: /\bdelivery\s*(time|kitni\s*der)\b/i,
    check: (reply, config) => (reply.includes(config.deliveryTime) ? null : `Delivery time: ${config.deliveryTime}`),
  },
  {
    pattern: /\bdelivery\s*(fee|charge)/i,
    check: (reply, config) => (reply.includes(String(config.deliveryFee)) ? null : `Delivery fee: PKR ${config.deliveryFee}`),
  },
];

// Additive-only: if the customer clearly asked about a specific restaurant
// fact and the reply doesn't already state the real value verbatim, append
// the correct line — never removes or rewrites whatever the model already
// said.
export function verifyRestaurantInfo(customerMessage: string, reply: string, restaurantConfig: RestaurantConfig): string {
  const missing = INFO_TOPICS.filter((topic) => topic.pattern.test(customerMessage))
    .map((topic) => topic.check(reply, restaurantConfig))
    .filter((line): line is string => Boolean(line));
  return missing.length > 0 ? `${reply}\n\n${missing.join("\n")}` : reply;
}

// ─── Restaurant-info REPLACING override (live bug fix) ─────────────────────
//
// verifyRestaurantInfo above is additive-only by design (so it never
// clobbers a reply that also did something else), but a live bug showed
// that's not enough on its own: asked "kahan hai" (a PURE location
// question, nothing else going on), the model answered with a stray,
// contentless "poora menu yeh hai:" line — completely unrelated to the
// question — and the additive check only appended the real address AFTER
// that wrong sentence, never replacing it. Replaces the model's entire
// draft with the real fact(s) whenever the message matches an info topic
// — same "backend facts override the LLM's narration" posture as every
// other override in this file. Used to also self-check that the message
// didn't ALSO look like a menu/order/total request (a `looksLikeMenuOrOrderRequest`
// helper) before firing — that responsibility now belongs entirely to the
// reply-orchestrator's tier ordering (restaurant info is deliberately the
// LOWEST-priority replacing override, tier 9 of 10, so "kahan hai current
// order" is decided by the order-review tier before this one is ever
// consulted), which is a single, testable, one-place rule instead of this
// function re-deriving "is this message also something else" itself.
export function renderRestaurantInfoIfApplicable(customerMessage: string, restaurantConfig: RestaurantConfig): string | null {
  const lines = INFO_TOPICS.filter((topic) => topic.pattern.test(customerMessage))
    .map((topic) => topic.check("", restaurantConfig))
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}
