// V3 AI Conversation Agent — one-call orchestrator.
//
// Customer message -> ONE Gemini call (unless a 429 cooldown is active) ->
// { reply, cartActions, checkoutAction } -> validate & apply against the
// real cart/menu/order-state -> correct the reply's facts -> normalize ->
// customer. Never more than one Gemini call per customer message, and
// there is no keyword-classification gate deciding whether Gemini gets
// consulted at all — it is the primary conversation engine for every real
// message, clarification answers included.
//
// Fallback rule: if the LLM path isn't available or fails at ANY point
// (no key configured, network error, timeout, invalid JSON, or a
// process-wide 429 cooldown), the WHOLE turn falls back to the full,
// already-proven V2 deterministic pipeline (v2/core/process-message.ts,
// including its own response builder) running on the ORIGINAL
// conversation — never a half-mutated, half-templated hybrid, and never a
// robotic template standing in for Gemini's own words unless Gemini
// genuinely failed.

import { Logger } from "../../v2/logger";
import { processCustomerMessage } from "../../v2/core/process-message";
import type { Menu, RestaurantConfig } from "../../v2/types/menu";
import type { FetchLike } from "../../v2/llm/types";
import { appendTurn, type AgentContext, type AgentSession } from "./context";
import { callAgent } from "./llm-call";
import { applyAgentActions } from "./actions";
import { correctReply } from "./correct-reply";
import { normalizeReply } from "./reply-normalizer";
import { isCooldownActive, recordRateLimitHit, resetCooldown, COOLDOWN_BUSY_REPLY } from "./cooldown";
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
  const withCustomerTurn = appendTurn({ conversation: nextConversation, history: session.history }, { role: "customer", text: message });
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
    const { context: nextOrderContext, facts } = applyAgentActions(
      session.conversation.order,
      outcome.plan.cartActions,
      outcome.plan.checkoutAction,
      menu,
      restaurantConfig
    );
    const nextConversation = { ...session.conversation, order: nextOrderContext };
    const sessionAfterActions: AgentSession = { conversation: nextConversation, history: session.history };

    const corrected = correctReply(outcome.plan.reply, facts, menu);
    const reply = normalizeReply(corrected);

    if (reply.length > 0) {
      const withCustomerTurn = appendTurn(sessionAfterActions, { role: "customer", text: message });
      const finalSession = appendTurn(withCustomerTurn, { role: "agent", text: reply });
      return finalize({
        session: finalSession,
        reply,
        usedLLM: true,
        cartActions: outcome.plan.cartActions,
        checkoutAction: outcome.plan.checkoutAction,
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
