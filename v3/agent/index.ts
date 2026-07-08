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
  verifyPendingRemoval,
  verifyClarificationStillAmbiguous,
  verifyCheckoutRejection,
  renderCategoryBrowseIfApplicable,
  renderThemeSuggestionIfApplicable,
  renderRestaurantInfoIfApplicable,
  renderTotalReplyIfApplicable,
  isNoMoreItemsReply,
  renderNoMoreItemsReplyIfApplicable,
  renderClarificationPromptIfApplicable,
  renderCheckoutReviewIfApplicable,
  renderFinalSubmitReplyIfApplicable,
  renderPostOrderAckReply,
} from "./fact-verifier";
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
    // A confidently-detected category/full-menu browse request always wins
    // (requirement #6, menu accuracy is safety-critical) — but never fires
    // on a turn that already did something structural (cart edit, checkout,
    // recommendation), so it can't clobber a legitimate reply.
    //
    // Deliberately reads the real outcome (`facts`), not the model's RAW
    // cartActions/checkoutAction — a live bug showed the model can attach a
    // spurious, unrelated cartAction (or the wrong checkoutAction) onto an
    // otherwise pure "pizza menu dikhao"/"burgers dikhao" browse request;
    // since that action either failed or never really applied, judging
    // "structural" off the raw plan wrongly blocked the price-safe browse
    // override and let a price-less LLM draft through instead.
    const cartActuallyChanged =
      facts.addedLines.length > 0 ||
      facts.removedNames.length > 0 ||
      facts.replacedNames.length > 0 ||
      facts.changedQuantity.length > 0 ||
      facts.clearedCart;
    const hadStructuredAction = cartActuallyChanged || facts.checkoutApplied !== null || recommendation !== null;
    // Phase 3, requirement #2: a total question NEVER gets a vague reply —
    // checked first since it's the more specific ask when both patterns
    // could theoretically fire.
    const totalOverride = renderTotalReplyIfApplicable(message, nextConversation.order.cart, menu, hadStructuredAction);
    const browseOverride = totalOverride ? null : renderCategoryBrowseIfApplicable(message, menu, hadStructuredAction);
    // A pure "kahan hai"/"address"/"timing"/etc. question always wins over a
    // themed-suggestion or menu-browse guess — checked next since it's the
    // most specific of the three when more than one could theoretically
    // match, mirroring totalOverride's own priority over browseOverride.
    const restaurantInfoOverride =
      totalOverride || browseOverride ? null : renderRestaurantInfoIfApplicable(message, restaurantConfig, hadStructuredAction);
    // Fallback for when the model's OWN plan failed to classify a themed
    // suggestion request (recommendation stays null) — never overrides a
    // recommendation the model already resolved correctly.
    const themeOverride =
      recommendation || totalOverride || browseOverride || restaurantInfoOverride
        ? null
        : renderThemeSuggestionIfApplicable(message, menu, hadStructuredAction, session.memory.lastMentionedCategory);
    const noMoreItemsOverride = renderNoMoreItemsReplyIfApplicable(message, nextConversation.order.cart, menu, hadStructuredAction);
    // Phase 3C, requirement #1: a NEW whole-category ambiguity always shows
    // every real option, never a narrowed subset the model happened to ask.
    const clarificationOverride = renderClarificationPromptIfApplicable(facts.newlyQueued, menu);
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
    let factChecked =
      postOrderAck?.reply ??
      finalSubmitOverride ??
      captureReply ??
      deliverySelectionOverride ??
      checkoutReviewOverride ??
      clarificationOverride ??
      noMoreItemsOverride ??
      rejectionOverride ??
      totalOverride ??
      browseOverride ??
      restaurantInfoOverride ??
      themeOverride ??
      corrected;
    factChecked = verifyPendingRemoval(factChecked, facts.pendingRemoval);
    factChecked = verifyClarificationStillAmbiguous(factChecked, facts.clarificationStillAmbiguous);
    factChecked = verifyRecommendation(factChecked, recommendation);
    factChecked = verifyRestaurantInfo(message, factChecked, restaurantConfig);
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
