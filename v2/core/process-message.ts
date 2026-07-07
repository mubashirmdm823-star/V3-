// V2 phase 8 — the process message orchestrator.
// V2 phase 11 update — capable of resolving intent via EITHER the
// deterministic parser or an LLM provider, transparently.
//
// The central brain of V2: the ONLY component that coordinates the other
// layers into one customer turn. It contains no business rules of its
// own — every decision about parsing, safety, cart mutation, state
// transitions, or reply wording is made entirely inside the module that
// already owns it. This file only sequences those calls, times them,
// validates their output, logs everything, and recovers safely if a stage
// misbehaves.
//
// Pipeline: Customer Message -> Context Builder -> Prompt Builder -> LLM
// Router -> Selected Provider -> Validated JSON -> ParseResult Mapper ->
// Safety Layer -> Cart Engine -> Order State Engine -> Response Builder ->
// Logger -> Final Customer Reply.
//
// (Safety runs INSIDE parseMessage/the ParseResult mapper, and the cart
// engine runs INSIDE processMessage in this codebase's already-shipped
// architecture — see v2/logger/performance.ts's header for why — so "call
// the safety layer" and "execute the cart engine" are represented here as
// validation checkpoints immediately around the router/state calls, not
// separate function calls that would otherwise have to re-run their logic.
//
// This orchestrator never knows or cares whether runRouterStage resolved
// the message via v2/llm/ or the deterministic parser — both produce the
// exact same ParseResult contract (v2/llm/parse-result-mapper.ts's whole
// job), so everything from checkSafetyStage onward is completely
// unchanged from phase 8.)

import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import { Logger, type BuildLogEntryParams } from "../logger/logger";
import { now, elapsed } from "../logger/performance";
import { unknownRequestMessage } from "../response-builder";
import { clarifyUnclearMessage } from "../intent-parser/clarification";
import type { ConversationContext } from "./context-manager";
import { withOrder } from "./context-manager";
import {
  runRouterStage,
  checkSafetyStage,
  runStateStage,
  runResponseStage,
  runLoggerStage,
} from "./executor";
import { recordEvent } from "./pipeline";
import { isPipelineError, toPipelineError, type PipelineStage } from "./errors";
import type { ProcessMessageResult, PipelineTiming, PipelineEventLog } from "./result";
import type { FetchLike } from "../llm/types";
import type { LLMCache } from "../llm/cache";

export interface ProcessMessageInput {
  rawMessage: string;
  conversation: ConversationContext;
  menu: Menu;
  restaurantConfig: RestaurantConfig;
  logger: Logger;
  // Optional LLM-routing knobs — all default to "no LLM configured" (env
  // defaults to process.env, which has no LLM_PROVIDER set anywhere in
  // this repo yet) so every existing caller/test that doesn't pass these
  // keeps behaving exactly as it did before this phase: deterministic
  // parsing only.
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  llmCache?: LLMCache;
}

export interface ProcessMessageOutput {
  result: ProcessMessageResult;
  conversation: ConversationContext;
}

// A safe, professional fallback reply for a stage that threw or returned a
// malformed result — never the technical reason, never the stage name.
function fallbackReplyForStage(stage: PipelineStage): string {
  if (stage === "PARSER") return clarifyUnclearMessage();
  return unknownRequestMessage();
}

// Only used when the parser itself failed, so there's no real ParseResult
// to log/report against — a well-formed, inert placeholder (no items, no
// actions, no cart authority) rather than a nullable field every consumer
// of ProcessMessageResult would otherwise have to guard against.
function fallbackParseResult(rawMessage: string): ParseResult {
  return {
    intent: "UNKNOWN",
    confidence: 0,
    items: [],
    actions: [],
    needsClarification: false,
    safetyDecision: "NO_CART_ACTION",
    rawUserMessage: rawMessage,
    normalizedMessage: rawMessage.trim().toLowerCase(),
  };
}

export async function processCustomerMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { rawMessage, conversation, menu, restaurantConfig, logger } = input;
  const before: OrderContext = conversation.order;

  const overallStart = now();
  let events: PipelineEventLog[] = recordEvent([], "PIPELINE_STARTED");

  const timing: PipelineTiming = {
    parserMs: 0, safetyMs: 0, cartMs: 0, stateMs: 0, responseMs: 0, loggerMs: 0, totalMs: 0,
  };

  let parseResult: ParseResult | undefined;
  let parserSource: ProcessMessageResult["parserSource"] = "deterministic";
  let after: OrderContext = before;
  let reply: string;
  let recovered = false;
  let failedStage: PipelineStage | undefined;

  try {
    const routerTimed = await runRouterStage({
      rawMessage,
      cart: before.cart,
      state: before.state,
      pendingClarification: before.pendingClarification,
      menu,
      restaurantConfig,
      env: input.env,
      fetchImpl: input.fetchImpl,
      cache: input.llmCache,
    });
    parseResult = routerTimed.result.parseResult;
    parserSource = routerTimed.result.source;
    timing.parserMs = routerTimed.ms;
    events = recordEvent(events, "PARSER_COMPLETE", routerTimed.ms);

    // Safety fused into the parser call above — validated, not re-decided.
    checkSafetyStage(parseResult);
    events = recordEvent(events, "SAFETY_COMPLETE", 0);

    // Cart execution fused into the state call below — validated, not
    // re-decided; the order-state-engine only mutates the cart when the
    // safety layer already cleared the message (SAFE_TO_EXECUTE).
    const stateTimed = runStateStage(before, parseResult, menu);
    after = stateTimed.result;
    timing.stateMs = stateTimed.ms;
    events = recordEvent(events, "CART_COMPLETE", 0);
    events = recordEvent(events, "STATE_COMPLETE", stateTimed.ms);

    const responseTimed = runResponseStage({ parseResult, before, after, menu, restaurantConfig });
    reply = responseTimed.result;
    timing.responseMs = responseTimed.ms;
    events = recordEvent(events, "RESPONSE_COMPLETE", responseTimed.ms);
  } catch (error) {
    const pipelineError = isPipelineError(error) ? error : toPipelineError("STATE", error);
    recovered = true;
    failedStage = pipelineError.stage;
    // PARSER/STATE failures roll back to the last valid context: `after`
    // only ever gets reassigned once its stage succeeds, so it's still
    // `before` here unless RESPONSE was the stage that failed — in which
    // case the state transition was already valid and is deliberately kept.
    if (pipelineError.stage === "RESPONSE") {
      // keep the already-computed valid `after`
    } else {
      after = before;
    }
    reply = fallbackReplyForStage(pipelineError.stage);
    // The parser itself may have thrown before ever producing a result —
    // fall back to an inert placeholder so downstream fields (logging, the
    // returned result) never have to deal with a missing ParseResult.
    parseResult = parseResult ?? fallbackParseResult(rawMessage);
    events = recordEvent(events, "PIPELINE_FAILED");
  }

  // Always assigned by this point: either the try block's successful parser
  // call, or the catch block's fallbackParseResult().
  const finalParseResult: ParseResult = parseResult!;

  // Logging never blocks or alters the customer's reply — a logging failure
  // is recorded (recovered/failedStage) but the already-good reply/context
  // stand.
  let logEntry: ProcessMessageResult["logEntry"];
  {
    try {
      const logParams: BuildLogEntryParams = {
        sessionId: logger.sessionId,
        conversationId: logger.conversationId,
        rawMessage,
        parseResult: finalParseResult,
        before,
        after,
        menu,
        performance: {
          parserMs: timing.parserMs,
          safetyMs: timing.safetyMs,
          cartMs: timing.cartMs,
          stateMs: timing.stateMs,
          responseMs: timing.responseMs,
          totalMs: elapsed(overallStart),
        },
      };
      const loggerTimed = runLoggerStage(logger, logParams);
      logEntry = loggerTimed.result;
      timing.loggerMs = loggerTimed.ms;
      events = recordEvent(events, "LOGGER_COMPLETE", loggerTimed.ms);
    } catch (error) {
      const pipelineError = toPipelineError("LOGGER", error);
      recovered = true;
      failedStage = failedStage ?? pipelineError.stage;
    }
  }

  timing.totalMs = elapsed(overallStart);
  events = recordEvent(events, "PIPELINE_FINISHED");

  const nextConversation = withOrder(conversation, after, rawMessage);

  const result: ProcessMessageResult = {
    reply,
    context: after,
    parseResult: finalParseResult,
    logEntry,
    timing,
    events,
    recovered,
    failedStage,
    parserSource,
  };

  return { result, conversation: nextConversation };
}
