// V3 central rules reference.
//
// This file exists so future fixes don't scatter word lists / regexes / the
// reply-priority order across v3/agent/*.ts. It is a REFACTOR, not a new
// behaviour layer: every list below is either (a) the actual source a
// module now imports and extends, or (b) a documented canonical reference
// that a module cross-links via a comment because rewiring it would risk
// changing behaviour (each such spot says why). Nothing here invents a new
// trigger path on its own — see each section's note for how it's actually
// consumed, if at all.

// 1. Acknowledgements — must never mutate cart.
// Actually wired: conversation-memory.ts's BARE_ACKNOWLEDGMENT_WORDS
// imports this as its base and extends it with additional synonyms
// ("k", "kk", "achha", "thik hai", "theek", "haan", "continue", ...) that
// were already recognised before this refactor — the superset is a strict
// extension, never a narrowing, so behaviour is unchanged.
// NOT rewired: fact-verifier.ts's POST_ORDER_ACK_REPLIES (a different,
// narrower set for the one-time post-order "thank you" reply) is left
// untouched — extending it to the full canonical list would add "acha",
// "done", and "👍" as new triggers there, which is a real behaviour change,
// so it only gets a TODO comment pointing here instead.
export const ACKNOWLEDGEMENT_MESSAGES: readonly string[] = [
  "ok",
  "okay",
  "theek hai",
  "acha",
  "done",
  "thanks",
  "thank you",
  "👍",
];
export const ACKNOWLEDGEMENT_RULE =
  "Acknowledgements must never mutate cart.";

// 2. Add-intent words.
// No v3-local keyword matcher exists for "is this an add" — V3 cart
// mutations come from the model's own structured cartActions, not from
// keyword-scanning the raw customer text. The deterministic analogue is
// V2's ORDER_VERB_PATTERN (v2/intent-parser/parser.ts), which V2's own
// clarification.ts already reuses — V2 is out of scope for this refactor.
// Exported here purely as the documented canonical reference / for tests.
export const ADD_INTENT_WORDS: readonly string[] = [
  "add",
  "kar do",
  "kardo",
  "daal do",
  "order karo",
  "chahiye",
  "dena",
  "dedo",
];

// 3. Recommendation words — recommendation must never auto-add.
// Partially overlaps fact-verifier.ts's THEME_PATTERNS (the raw-text
// fallback used only when the model fails to classify a recommendation
// request): "kuch spicy" / "hot and spicy" -> the "spicy" theme, and
// "kids ke liye" -> the "kids" theme. The generic trigger words here
// ("suggest", "recommend", "batao", "kuch acha") are NOT wired into
// THEME_PATTERNS: bare "batao" is already a menu/category browsing signal
// (LISTING_INTENT_PATTERN) and retrofitting it as a recommendation trigger
// too would create a real classification conflict — out of scope for a
// behaviour-preserving refactor, so THEME_PATTERNS only carries a TODO
// pointing here rather than importing this list directly.
export const RECOMMENDATION_WORDS: readonly string[] = [
  "suggest",
  "recommend",
  "batao",
  "kuch acha",
  "kuch spicy",
  "hot and spicy",
  "kids ke liye",
];
export const RECOMMENDATION_RULE = "Recommendation must never auto-add.";

// 4. Order/cart review words — order/cart intent has priority over location.
// NOT wired into ORDER_REVIEW_PATTERN: 6 of these 7 phrases already match
// the existing regex; "order bataen" is a known, pre-existing gap (a verb
// conjugation the regex's alternation doesn't include) documented in an
// earlier phase's QA notes. Closing it would be a real behaviour change
// (a message that currently falls through to the general AI reply would
// start rendering the order block instead), which this centralization-only
// task must not do — left as a TODO cross-reference in fact-verifier.ts
// instead of being folded into the pattern.
export const ORDER_REVIEW_WORDS: readonly string[] = [
  "order dikhao",
  "current order",
  "mera order",
  "cart dikhao",
  "order batao",
  "order bataen",
  "kahan hai current order",
];
export const ORDER_REVIEW_RULE = "Order/cart intent has priority over location.";

// 5. Restaurant info words — only applies when the message doesn't already
// carry order/cart/checkout/menu intent (enforced structurally by the
// reply-orchestrator's tier order, see PRIORITY_RULES below — restaurant
// info sits below order review, cart mutation, and menu/category tiers).
// NOT wired: every phrase here already matches one of fact-verifier.ts's
// existing INFO_TOPICS regexes (address/location/kahan, phone, timing,
// delivery time, delivery charges), so there is nothing to fix — but each
// INFO_TOPICS entry maps to its own specific RestaurantConfig field
// (address/phone/timing/...), so a generic substring check against this
// flat list can't cleanly replace that per-field structure without
// rewriting it. Cross-referenced via a TODO comment instead.
export const RESTAURANT_INFO_WORDS: readonly string[] = [
  "kahan hai",
  "address",
  "location",
  "timing",
  "delivery charges",
  "delivery time",
  "phone",
];
export const RESTAURANT_INFO_RULE =
  "Restaurant info only applies when message does not contain order/cart/checkout/menu intent.";

// 6. Checkout words.
// No v3-local keyword matcher exists: checkout-guard.ts and actions.ts key
// off the model's structured CheckoutAction["type"] enum values
// ("start_checkout", "confirm_order", ...) and deterministic state
// (AWAITING_NAME/AWAITING_ADDRESS), not free-text word lists. The rules
// below are already enforced by that state-machine code
// (checkout-guard.ts, fact-verifier.ts's renderCheckoutReviewIfApplicable /
// renderFinalSubmitReplyIfApplicable) — exported here as the documented
// canonical reference the task asks for, cross-linked via TODO comments
// rather than rewired, since there is no existing keyword list to
// deduplicate against.
export const CHECKOUT_WORDS: readonly string[] = [
  "checkout",
  "place order",
  "order proceed",
  "confirm karna hai",
];
export const CHECKOUT_RULES: readonly string[] = [
  "Checkout must show full review first.",
  "Delivery requires address and name.",
  "Never say confirmed before backend verification state.",
];

// 7. Banned customer-reply terms — internal/system leakage must never reach
// the customer.
// Actually wired: reply-normalizer.ts's INTERNAL_TERM_WORDS imports this as
// its base and appends "front[- ]?end" locally (a pre-existing entry not in
// the canonical list) — strict superset, no behaviour change.
export const BANNED_CUSTOMER_REPLY_TERMS: readonly string[] = [
  "backend",
  "tool",
  "json",
  "provider",
  "gateway",
  "internal",
  "system",
  "debug",
  "V2",
  "V3",
  "engine",
];

// 8. Menu price line format — all menu/category/recommendation/
// clarification lines must render as "• Item Name — PKR Price".
// Actually wired: fact-verifier.ts's renderCategory, verifyRecommendation,
// renderThemeSuggestion, and renderClarificationPromptIfApplicable all call
// formatMenuLine() instead of repeating the template literal — identical
// output, real deduplication. (Cart/order line renderers use a different,
// quantity-bearing format and are out of this rule's scope.)
export const MENU_PRICE_FORMAT_RULE =
  "All menu/category/recommendation/clarification lines must use: • Item Name — PKR Price";

export function formatMenuLine(name: string, price: number): string {
  return `• ${name} — PKR ${price}`;
}

// 9. Clarification lifecycle rules.
// Already enforced by clarification-engine.ts (resolvePendingAdd /
// resolvePendingAddMulti / resolvePendingRemoval) and actions.ts (runAdd) —
// documented here, cross-linked via TODO comments, not rewritten.
export const CLARIFICATION_RULES: readonly string[] = [
  "Pending clarification answers resolve only the pending queue.",
  "Queued actions are single-use.",
  "The queue clears after successful resolution.",
  "Clarification answers must not create an independent add plan unless they match no pending option.",
];

// 10. Cart mutation rules.
// Already enforced by actions.ts's applyAgentActions (effectiveCartActions
// gating via isBareAcknowledgment) and conversation-memory.ts — documented
// here, cross-linked via TODO comments, not rewritten.
export const CART_MUTATION_RULES: readonly string[] = [
  "Only explicit add/remove/replace/quantity messages can mutate cart.",
  "Acknowledgements cannot mutate.",
  "Post-order acknowledgements cannot mutate.",
  "Committed mutations cannot replay.",
];

// 11. Reply priority order.
// reply-orchestrator.ts's actual `tiers` array is more granular (18
// entries, including checkout sub-states and a split between
// model-classified recommendation vs. the raw-text theme fallback — see
// that file's header comment for why) but preserves this same relative
// ordering. Documented here as the canonical, human-readable 10-tier
// summary; reply-orchestrator.ts cross-links via a TODO comment rather than
// being restructured around this exact list, since collapsing its 18 tiers
// down to 10 would risk behaviour (two deliberately-separated recommendation
// tiers would need to merge back into one).
export const PRIORITY_RULES: readonly string[] = [
  "1. Post-order",
  "2. Checkout",
  "3. Order review / cart",
  "4. Total / bill",
  "5. Clarification",
  "6. Cart mutation",
  "7. Menu / category / full menu",
  "8. Recommendation",
  "9. Restaurant info",
  "10. General reply",
];
