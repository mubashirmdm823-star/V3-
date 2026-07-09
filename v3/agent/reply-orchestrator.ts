// V3 Reply Orchestrator — the SINGLE deterministic reply-priority pipeline.
//
// Root cause this module fixes: fact-verifier.ts had grown ~15 independent
// "replacing" overrides, each deciding on its own (via a scattered mix of
// `hadStructuredAction` flags and ad-hoc cross-checks like
// `looksLikeMenuOrOrderRequest`) whether it was safe to fire. Two concrete
// production regressions came from that design: (1) "order dikhao" had NO
// override at all verifying it, so an intro-only LLM draft ("Aapka current
// order yeh hai:" with no items) passed straight through; (2) "kahan hai
// current order" — restaurant-info's own self-check for "does this message
// also look like something else" didn't know about order/cart requests, so
// "kahan" alone was enough to replace the WHOLE reply with just the
// address, silently discarding "current order."
//
// The fix: every fact-verifier.ts render function now ONLY answers "does
// this look like tier X's request," nothing about precedence. This module
// is the ONE place that decides precedence, via a fixed, numbered priority
// list — exactly one candidate ever wins per turn (the first non-null one),
// and every render function stays pure/independent (add a new tier here,
// never scatter a new cross-check into an unrelated function).
//
// See v3/agent/rules.ts's PRIORITY_RULES for the canonical, human-readable
// 10-tier summary of the list below (this file's actual tiers array is more
// granular — 18 entries, since checkout and recommendation each split into
// sub-tiers for reasons documented inline below — collapsing it back down
// to exactly 10 would risk behaviour, so it stays as-is and cross-links
// rules.ts instead of importing it).
//
// Priority order (highest first) — do not reorder without re-reading the
// header of every tier below; this list IS the product requirement:
//   1. Post-order / PENDING_VERIFICATION acknowledgment
//   2. Checkout: final submit > capture (name/address) > delivery-selection
//      > order review (start_checkout) > rejection
//   3. Order review / current cart requests (+ "no more items")
//   4. Total/bill requests
//   5. Clarification: newly-queued ADD ambiguity > newly-queued REMOVE
//      ambiguity > a still-ambiguous clarification answer
//   6. Recommendation requests the MODEL ITSELF classified (a confident,
//      intentional signal — see the note below on why this outranks 7)
//   7. A real cart mutation this turn (add/remove/replace/quantity change)
//   8. Menu/category/full-menu requests (+ intro-only-draft backstop)
//   8b. Recommendation raw-text FALLBACK (only when the model failed to
//      classify a themed request at all — a much weaker bare-keyword
//      signal, see the note below on why this is NOT tier 6)
//   9. Restaurant info / location / timing / delivery fee
//  10. The general AI reply (the fact-checked LLM draft), unconditionally
//
// Model-classified recommendation (6) is deliberately ABOVE cart-mutation
// (7), one place this deviates from a strict reading of "recommendation is
// tier 8" — preserved from Phase 2's own explicit, tested requirement:
// "pasta hata do aur kuch spicy suggest karo" must show BOTH the removal
// (which happens regardless, applied to the real cart before any reply
// text is picked) AND the spicy suggestion in the SAME reply. It still
// never outranks checkout/order-review/total/clarification (1-5), which is
// what rule "recommendation must not override checkout/cart review"
// actually protects against — it only wins over a plain cart-mutation
// confirmation sentence, exactly the compound-message case tested since
// Phase 2. The raw-text FALLBACK (8b) is a different, much weaker signal
// (a bare keyword match, e.g. "spicy") only meant to catch a PURE
// recommendation question the model failed to classify at all — a live
// regression showed it must NOT sit at tier 6: "ek zinger burger dedo,
// spicy chahiye" incidentally contains "spicy," and promoting the fallback
// to tier 6 buried the real add confirmation under an unrelated suggestion.

export interface ReplyOrchestratorInput {
  // Tier 1
  postOrderAckReply: string | null;
  // Tier 2 — checkout (already in this exact internal precedence)
  finalSubmitOverride: string | null;
  captureReply: string | null;
  deliverySelectionOverride: string | null;
  checkoutReviewOverride: string | null;
  rejectionOverride: string | null;
  // Tier 3 — order review / current cart
  orderReviewOverride: string | null;
  noMoreItemsOverride: string | null;
  // Tier 4 — total/bill
  totalOverride: string | null;
  // Tier 5 — clarification
  clarificationOverride: string | null;
  pendingRemovalOverride: string | null;
  stillAmbiguousOverride: string | null;
  // Tier 6 — model-classified recommendation (see the deliberate-ordering
  // note above)
  recommendationOverride: string | null;
  // Tier 7 — real cart mutation this turn
  cartActuallyChanged: boolean;
  // Tier 8 — menu/category
  browseOverride: string | null;
  menuIntroOnlyOverride: string | null;
  // Tier 8b — recommendation raw-text fallback (see the note above on why
  // this is NOT the same tier as recommendationOverride)
  themeOverride: string | null;
  // Tier 9 — restaurant info
  restaurantInfoOverride: string | null;
  // Tier 10 — the fact-checked LLM draft; also reused as tier 7's value,
  // since a real cart mutation's confirmation IS the (already item/total-
  // corrected, see correct-reply.ts) LLM draft, not a separate template.
  correctedDraft: string;
}

export interface OrchestratedReply {
  reply: string;
  // Which tier actually won this turn — exposed purely for testability
  // (rule: "exactly one final reply source should win per turn," and this
  // is how a test proves it deterministically rather than guessing from
  // reply text alone).
  source: string;
}

interface Tier {
  name: string;
  value: string | null;
}

export function orchestrateReply(input: ReplyOrchestratorInput): OrchestratedReply {
  const tiers: Tier[] = [
    { name: "post_order_ack", value: input.postOrderAckReply },
    { name: "checkout_final_submit", value: input.finalSubmitOverride },
    { name: "checkout_capture", value: input.captureReply },
    { name: "checkout_delivery_selection", value: input.deliverySelectionOverride },
    { name: "checkout_review", value: input.checkoutReviewOverride },
    { name: "checkout_rejection", value: input.rejectionOverride },
    { name: "order_review", value: input.orderReviewOverride },
    { name: "no_more_items", value: input.noMoreItemsOverride },
    { name: "total", value: input.totalOverride },
    { name: "clarification_new", value: input.clarificationOverride },
    { name: "clarification_pending_removal", value: input.pendingRemovalOverride },
    { name: "clarification_still_ambiguous", value: input.stillAmbiguousOverride },
    { name: "recommendation", value: input.recommendationOverride },
    { name: "cart_mutation", value: input.cartActuallyChanged ? input.correctedDraft : null },
    { name: "menu_browse", value: input.browseOverride },
    { name: "menu_intro_only_fallback", value: input.menuIntroOnlyOverride },
    { name: "recommendation_theme_fallback", value: input.themeOverride },
    { name: "restaurant_info", value: input.restaurantInfoOverride },
  ];

  for (const tier of tiers) {
    if (tier.value !== null) return { reply: tier.value, source: tier.name };
  }
  return { reply: input.correctedDraft, source: "general_ai_reply" };
}
