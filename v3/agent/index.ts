// V3 AI Conversation Agent — one-call orchestrator.
//
// Customer message -> ONE AI Gateway call (unless a 429 cooldown is active)
// -> { reply, cartActions, checkoutAction } -> validate & apply against the
// real cart/menu/order-state -> correct the reply's facts -> normalize ->
// customer. V3 never calls Gemini/Groq/OpenRouter directly — llm-call.ts's
// `callAgent` routes the single call through ai-gateway/index.ts, which
// owns provider selection/failover/cooldown internally; this file only
// ever sees "got a plan" or "didn't." Never more than one model call per
// customer message, and there is no keyword-classification gate deciding
// whether the gateway gets consulted at all — it is the primary
// conversation engine for every real message, clarification answers
// included.
//
// Fallback rule: if the gateway path isn't available or fails at ANY point
// (no provider configured, network error, timeout, invalid JSON, every
// gateway provider failing, or a process-wide 429 cooldown), the WHOLE
// turn falls back to the full, already-proven V2 deterministic pipeline
// (v2/core/process-message.ts, including its own response builder) running
// on the ORIGINAL conversation — never a half-mutated, half-templated
// hybrid, and never a robotic template standing in for the model's own
// words unless every provider genuinely failed.

import { Logger } from "../../v2/logger";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { appendTurn, type AgentContext, type AgentSession } from "./context";
import { callAgent } from "./llm-call";
import { applyAgentActions } from "./actions";
import { correctReply } from "./correct-reply";
import {
  verifyRecommendation,
  verifyRestaurantInfo,
  renderPendingRemovalIfApplicable,
  renderStillAmbiguousIfApplicable,
  verifyCheckoutRejection,
  renderCategoryBrowseIfApplicable,
  renderMenuIntroOnlyFallbackIfApplicable,
  renderThemeSuggestionIfApplicable,
  renderRestaurantInfoIfApplicable,
  renderTotalReplyIfApplicable,
  renderCurrentOrderIfApplicable,
  isNoMoreItemsReply,
  renderNoMoreItemsReplyIfApplicable,
  renderClarificationPromptIfApplicable,
  renderCheckoutReviewIfApplicable,
  renderFinalSubmitReplyIfApplicable,
  renderPostOrderAckReply,
} from "./fact-verifier";
import { orchestrateReply } from "./reply-orchestrator";
import { splitPlanIntents } from "./multi-intent";
import { resolveCheckoutCapture, checkoutActionForCapture, buildCheckoutCaptureReply } from "./checkout-guard";
import { updateMemoryAfterTurn } from "./conversation-memory";
import { normalizeReply } from "./reply-normalizer";
import { isCooldownActive, recordRateLimitHit, COOLDOWN_BUSY_REPLY } from "./cooldown";
import type { CartAction, CheckoutAction } from "./schema";

export interface ProcessAgentMessageOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export interface AgentTurnResult {
  session: AgentSession;
  reply: string;
  // True only when the single Gemini call successfully answered this turn
  // — false whenever the cooldown or the V2 fallback answered instead.
  usedLLM: boolean;
  cartActions: CartAction[];
  checkoutAction: CheckoutAction | null;
  apiCallsThisTurn: number; // always 0 or 1 — never more
  providerAttempted: boolean;
  cooldownActive: boolean;
  fallbackUsed: boolean;
  providerError: boolean;
  rateLimited429: boolean;
}

function finalize(base: {
  session: AgentSession;
  reply: string;
  usedLLM?: boolean;
  cartActions?: CartAction[];
  checkoutAction?: CheckoutAction | null;
  apiCallsThisTurn: number;
  providerAttempted: boolean;
  cooldownActive: boolean;
  fallbackUsed: boolean;
  providerError: boolean;
  rateLimited429: boolean;
}): AgentTurnResult {
  return {
    session: base.session,
    reply: base.reply,
    usedLLM: base.usedLLM ?? false,
    cartActions: base.cartActions ?? [],
    checkoutAction: base.checkoutAction ?? null,
    apiCallsThisTurn: base.apiCallsThisTurn,
    providerAttempted: base.providerAttempted,
    cooldownActive: base.cooldownActive,
    fallbackUsed: base.fallbackUsed,
    providerError: base.providerError,
    rateLimited429: base.rateLimited429,
  };
}

async function runV2Fallback(
  session: AgentSession,
  message: string,
  menu: Menu,
  restaurantConfig: RestaurantConfig
): Promise<{ session: AgentSession; reply: string }> {
  const logger = new Logger(session.conversation.sessionId, session.conversation.conversationId);
  const { result, conversation: nextConversation } = await processCustomerMessage({
    rawMessage: message,
    conversation: session.conversation,
    menu,
    restaurantConfig,
    logger,
    // CRITICAL: V2's own pipeline has its OWN independent LLM router that
    // defaults to the real process.env when no env is passed — passing an
    // empty env here forces it to see "not configured" so this fallback
    // never makes an untracked second network call of its own.
    env: {},
  });
  // The fallback pipeline is V2's own deterministic engine, not V3's
  // reference-resolver/recommendation-engine — but the customer's message
  // is still worth remembering preferences from (facts: null preserves
  // every other memory field unchanged, see conversation-memory.ts).
  const nextMemory = updateMemoryAfterTurn({ memory: session.memory, customerMessage: message, plan: null, facts: null, menu });
  const withCustomerTurn = appendTurn({ conversation: nextConversation, history: session.history, memory: nextMemory }, { role: "customer", text: message });
  const finalSession = appendTurn(withCustomerTurn, { role: "agent", text: result.reply });
  return { session: finalSession, reply: result.reply };
}

export async function processAgentMessage(
  session: AgentSession,
  message: string,
  menu: Menu,
  restaurantConfig: RestaurantConfig,
  options: ProcessAgentMessageOptions = {}
): Promise<AgentTurnResult> {
  // The 429 cooldown is the one case where we skip a call we already know
  // will fail — not a keyword shortcut, a genuine-failure short-circuit
  // straight to the same fallback a real failure would take.
  if (isCooldownActive()) {
    const reply = normalizeReply(COOLDOWN_BUSY_REPLY);
    const withCustomerTurn = appendTurn(session, { role: "customer", text: message });
    const finalSession = appendTurn(withCustomerTurn, { role: "agent", text: reply });
    return finalize({
      session: finalSession,
      reply,
      apiCallsThisTurn: 0,
      providerAttempted: false,
      cooldownActive: true,
      fallbackUsed: true,
      providerError: false,
      rateLimited429: false,
    });
  }

  const agentContext: AgentContext = { session, menu, restaurantConfig, customerMessage: message };
  const outcome = await callAgent(agentContext, options);
  const apiCallsThisTurn = outcome.attempted ? 1 : 0;
  if (outcome.errorStatus === 429) recordRateLimitHit();

  if (outcome.plan) {
    const priorState = session.conversation.order.state;

    // Phase 2: fan the one plan out into its independent streams — cart
    // mutation and recommendation resolution never block or overwrite each
    // other (requirement #3, "pasta hata do aur kuch spicy suggest karo").
    const split = splitPlanIntents(outcome.plan, menu, session.memory);
    let { cartActions, checkoutAction } = split;
    const { recommendation } = split;

    // Phase 3C, requirement #2: a bare "nahi"/"bas"/"aur kuch nahi" must
    // always move toward checkout, never accidentally mutate the cart —
    // stripped BEFORE checkout-guard/applyAgentActions ever see them, same
    // "Suggest != Add" precedent as multi-intent.ts. Left untouched during
    // an active clarification/name/address capture, where the SAME word
    // could legitimately mean something else and those flows already own
    // their own strict handling.
    const isCaptureOrClarificationState = priorState === "AWAITING_CLARIFICATION" || priorState === "AWAITING_NAME" || priorState === "AWAITING_ADDRESS";
    const noMoreItemsThisTurn = !isCaptureOrClarificationState && isNoMoreItemsReply(message);
    if (noMoreItemsThisTurn) {
      cartActions = [];
      checkoutAction = null;
    }

    // Phase 3C, requirement #4: the customer often answers "delivery ya
    // pickup?" in the SAME message that would otherwise just confirm the
    // order review, or names it a turn early (still ORDER_REVIEW, one
    // confirm short of AWAITING_DELIVERY_PICKUP) — a single turn can only
    // carry one checkoutAction, but the customer has effectively already
    // answered the next question either way. Detected from the state we
    // were ALREADY in, independent of whichever single action the model
    // guessed (confirm_order, select_delivery too early, or nothing).
    const wantsDelivery = /\bdelivery\b/i.test(message);
    const wantsPickup = /\bpick\s*up\b|\bpickup\b/i.test(message);
    const answeringDeliveryPickupEarly = priorState === "ORDER_REVIEW" && (wantsDelivery || wantsPickup);

    // Phase 3B: while AWAITING_NAME/AWAITING_ADDRESS, the customer's raw
    // text — never the model's chosen action type — decides what happens.
    // confirm_order (or anything else the model might pick) simply cannot
    // execute in these two states; see checkout-guard.ts.
    const capture = resolveCheckoutCapture(priorState, message, checkoutAction);
    const effectiveCheckoutAction = answeringDeliveryPickupEarly
      ? ({ type: "confirm_order" } as const)
      : checkoutActionForCapture(capture, checkoutAction);

    let { context: nextOrderContext, facts } = applyAgentActions(
      session.conversation.order,
      cartActions,
      effectiveCheckoutAction,
      menu,
      restaurantConfig,
      session.memory
    );

    // Combine the two existing, unchanged V2 transitions
    // (confirm_order then select_delivery/pickup) into this one customer
    // turn rather than making the customer repeat themselves. Only fires
    // on the exact confirm-into-AWAITING_DELIVERY_PICKUP transition, never
    // anywhere else.
    let deliverySelectionOverride: string | null = null;
    if (facts.checkoutApplied === "confirm_order" && nextOrderContext.state === "AWAITING_DELIVERY_PICKUP" && (wantsDelivery || wantsPickup)) {
      const autoAction: CheckoutAction = wantsDelivery ? { type: "select_delivery" } : { type: "select_pickup" };
      const advanced = applyAgentActions(nextOrderContext, [], autoAction, menu, restaurantConfig, session.memory);
      nextOrderContext = advanced.context;
      facts = {
        ...facts,
        checkoutApplied: advanced.facts.checkoutApplied ?? facts.checkoutApplied,
        checkoutRejected: advanced.facts.checkoutRejected ?? facts.checkoutRejected,
      };
      deliverySelectionOverride = wantsDelivery
        ? "Theek hai, delivery! Meherbani karke apna delivery address batayein."
        : "Theek hai, pickup! Meherbani karke apna naam batayein.";
    }

    const nextConversation = { ...session.conversation, order: nextOrderContext };

    // Phase 3C, requirement #5: the one-time post-order acknowledgment —
    // computed from the STATE BEFORE this turn (PENDING_VERIFICATION is
    // terminal, so it can't have just been reached this turn and also be
    // "prior").
    const postOrderAck = renderPostOrderAckReply(priorState, message, session.memory.postOrderThanked);

    const nextMemory = updateMemoryAfterTurn({
      memory: session.memory,
      customerMessage: message,
      plan: outcome.plan,
      facts,
      menu,
      recommendedItemIds: recommendation?.items.map((i) => i.id),
      pendingRemoval: facts.pendingRemoval,
      postOrderThanked: postOrderAck?.markThanked,
    });
    const sessionAfterActions: AgentSession = { conversation: nextConversation, history: session.history, memory: nextMemory };

    const corrected = correctReply(outcome.plan.reply, facts, menu);

    // Whether a REAL cart mutation actually landed this turn (tier 6) —
    // read from the real outcome (`facts`), never the model's raw
    // cartActions, since a spurious/failed model cartAction attached to an
    // otherwise pure request must never be mistaken for a real mutation.
    const cartActuallyChanged =
      facts.addedLines.length > 0 ||
      facts.removedNames.length > 0 ||
      facts.replacedNames.length > 0 ||
      facts.changedQuantity.length > 0 ||
      facts.clearedCart;

    // Every candidate below only ever answers "does THIS tier's own request
    // shape match," nothing about precedence against any other tier — that
    // is reply-orchestrator.ts's ONE job (see its header for the full
    // numbered priority list this mirrors exactly). Root cause this
    // replaces: these used to each carry their own ad-hoc
    // `hadStructuredAction`/cross-tier gate, which is exactly how "kahan
    // hai current order" and "order dikhao" regressed (restaurant-info's
    // own self-check didn't know about order/cart requests; nothing at all
    // verified a bare order-review request).
    const totalOverride = renderTotalReplyIfApplicable(message, nextConversation.order.cart, menu);
    const orderReviewOverride = renderCurrentOrderIfApplicable(message, nextConversation.order.cart, menu);
    const noMoreItemsOverride = renderNoMoreItemsReplyIfApplicable(message, nextConversation.order.cart, menu);
    const browseOverride = renderCategoryBrowseIfApplicable(message, menu);
    const menuIntroOnlyOverride = renderMenuIntroOnlyFallbackIfApplicable(message, corrected, menu);
    const restaurantInfoOverride = renderRestaurantInfoIfApplicable(message, restaurantConfig);
    // Recommendation: the model's OWN classification (verified/price-
    // corrected) is a confident, intentional signal — preserved above a
    // same-turn cart mutation (see reply-orchestrator.ts's header) so
    // "pasta hata do aur kuch spicy suggest karo" still shows the
    // suggestion. The raw-text theme FALLBACK is a much weaker, bare
    // keyword-match heuristic (only meant to catch a PURE recommendation
    // question the model failed to classify at all, e.g. "hot and spicy ma
    // kuch batao mujhe") — it must never outrank a real cart mutation this
    // turn (a live regression: "ek zinger burger dedo, spicy chahiye"
    // incidentally containing "spicy" must not bury the add confirmation),
    // so it sits at its own, lower tier instead.
    const recommendationOverride = recommendation ? verifyRecommendation(corrected, recommendation) : null;
    const themeOverride = recommendation ? null : renderThemeSuggestionIfApplicable(message, menu, session.memory.lastMentionedCategory);
    // Phase 3C, requirement #1: a NEW whole-category ambiguity always shows
    // every real option, never a narrowed subset the model happened to ask.
    const clarificationOverride = renderClarificationPromptIfApplicable(facts.newlyQueued, menu);
    const pendingRemovalOverride = renderPendingRemovalIfApplicable(facts.pendingRemoval);
    const stillAmbiguousOverride = renderStillAmbiguousIfApplicable(facts.clarificationStillAmbiguous);
    // Phase 3C, requirement #3: checkout always opens with the full real
    // order review before ever asking delivery/pickup.
    const checkoutReviewOverride = renderCheckoutReviewIfApplicable(facts.checkoutApplied, nextConversation.order.cart, menu);
    // Phase 3C, requirement #6: the ONLY moment "confirmed"-type language is
    // accurate — reaching PENDING_VERIFICATION this turn.
    const finalSubmitOverride = renderFinalSubmitReplyIfApplicable(facts.checkoutApplied, nextConversation.order.state);
    // Phase 3B: the checkout-capture outcome (now also carrying the Phase 3C
    // requirement #4 final review after a name save) is the single most
    // safety-critical fact this turn (a false "order confirmed" claim is
    // worse than any other reply mistake) — it wins over every other
    // override, never just appended alongside them.
    const captureApplied = capture.kind !== "pass_through" && facts.checkoutApplied === effectiveCheckoutAction?.type;
    const captureReply = buildCheckoutCaptureReply(capture, captureApplied, nextConversation.order, menu);
    // General case (any state): a rejected checkoutAction always means
    // nothing changed — the reply must say so honestly, never claim
    // success for what was actually rejected. Only checked when
    // checkout-guard.ts didn't already produce a more specific reply.
    const rejectionOverride = !captureReply && facts.checkoutRejected ? verifyCheckoutRejection(corrected, facts.checkoutRejected) : null;

    const orchestrated = orchestrateReply({
      postOrderAckReply: postOrderAck?.reply ?? null,
      finalSubmitOverride,
      captureReply,
      deliverySelectionOverride,
      checkoutReviewOverride,
      rejectionOverride,
      orderReviewOverride,
      noMoreItemsOverride,
      totalOverride,
      clarificationOverride,
      pendingRemovalOverride,
      stillAmbiguousOverride,
      recommendationOverride,
      cartActuallyChanged,
      browseOverride,
      menuIntroOnlyOverride,
      themeOverride,
      restaurantInfoOverride,
      correctedDraft: corrected,
    });
    // Additive-only, never replacing (see verifyRestaurantInfo's own header)
    // — appends a restaurant fact the customer also asked about, but ONLY
    // when nothing more specific already won this turn (rule 3: restaurant
    // info must never override — or even visually crowd — an order/cart/
    // total/checkout/menu/recommendation reply; a live regression showed
    // "kahan hai current order" appending the address after an otherwise-
    // correct order review still reads as location intent partially
    // winning). Every tier from post-order-ack through the theme fallback
    // outranks this enrichment entirely; it only ever adds value on top of
    // the restaurant-info tier itself or the general AI fallback.
    const shouldEnrichWithRestaurantInfo = orchestrated.source === "restaurant_info" || orchestrated.source === "general_ai_reply";
    const factChecked = shouldEnrichWithRestaurantInfo
      ? verifyRestaurantInfo(message, orchestrated.reply, restaurantConfig)
      : orchestrated.reply;
    const reply = normalizeReply(factChecked);

    if (reply.length > 0) {
      const withCustomerTurn = appendTurn(sessionAfterActions, { role: "customer", text: message });
      const finalSession = appendTurn(withCustomerTurn, { role: "agent", text: reply });
      return finalize({
        session: finalSession,
        reply,
        usedLLM: true,
        cartActions,
        checkoutAction: effectiveCheckoutAction,
        apiCallsThisTurn,
        providerAttempted: outcome.attempted,
        cooldownActive: false,
        fallbackUsed: false,
        providerError: false,
        rateLimited429: outcome.errorStatus === 429,
      });
    }
    // An empty reply after normalization (e.g. the model returned nothing
    // usable) is treated the same as a failed call — fall through below,
    // discarding the action-plan mutation so the fallback runs on the
    // ORIGINAL session and the reply always matches the actual cart.
  }

  const { session: nextSession, reply } = await runV2Fallback(session, message, menu, restaurantConfig);
  return finalize({
    session: nextSession,
    reply,
    apiCallsThisTurn,
    providerAttempted: outcome.attempted,
    cooldownActive: false,
    fallbackUsed: true,
    providerError: outcome.attempted,
    rateLimited429: outcome.errorStatus === 429,
  });
}

export type { AgentSession, AgentTurn, AgentContext } from "./context";
export { createAgentSession } from "./context";
export { resetCooldown, isCooldownActive, COOLDOWN_BUSY_REPLY } from "./cooldown";
