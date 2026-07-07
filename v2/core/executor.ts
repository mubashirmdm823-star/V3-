// V2 phase 8 — timed, validated calls into each already-built module.
//
// Every function here does exactly two things around the real call: time it,
// and validate its output shape (v2/core/validator.ts). It never re-decides
// what the parser/state engine/response builder/logger should have done —
// see those modules for the actual rules. A validation failure or thrown
// exception is normalized into a PipelineError tagged with the stage that
// was running, for process-message.ts's safe-failure handling to catch.

import type { CartState } from "../types/cart";
import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderContext, OrderState, PendingClarificationContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import { parseMessage } from "../intent-parser/parser";
import { processMessage } from "../order-state-engine";
import { buildResponse, type ResponseBuilderInput } from "../response-builder";
import { buildLogEntry, Logger, type BuildLogEntryParams } from "../logger/logger";
import type { MessageLogEntry } from "../logger/events";
import { time, now, elapsed } from "../logger/performance";
import { isValidParseResult, isValidOrderContext, isValidCustomerResponse } from "./validator";
import { PipelineError, toPipelineError } from "./errors";
import { routeMessage, type RouteMessageResult } from "../llm/router";
import type { FetchLike } from "../llm/types";
import type { LLMCache } from "../llm/cache";

export interface TimedResult<T> {
  result: T;
  ms: number;
}

export function runParserStage(rawMessage: string, cart: CartState, menu: Menu): TimedResult<ParseResult> {
  const { result, ms } = time(() => {
    try {
      return parseMessage(rawMessage, cart, menu);
    } catch (error) {
      throw toPipelineError("PARSER", error);
    }
  });
  if (!isValidParseResult(result)) {
    throw new PipelineError("PARSER", "Intent parser returned a malformed ParseResult.");
  }
  return { result, ms };
}

export interface RunRouterStageParams {
  rawMessage: string;
  cart: CartState;
  state: OrderState;
  pendingClarification?: PendingClarificationContext;
  menu: Menu;
  restaurantConfig: RestaurantConfig;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  cache?: LLMCache;
}

// The phase-11 replacement for what the orchestrator actually calls: same
// PARSER stage tag, same validation, same timing contract as
// runParserStage above (which is left completely untouched and still used
// directly by anything that only ever wants the deterministic parser) —
// the only difference is this one goes through v2/llm/router.ts first,
// which itself calls the deterministic parser whenever no LLM provider is
// configured or the LLM's answer isn't usable. Async because a real
// provider call is a network request; runParserStage stays synchronous.
export async function runRouterStage(params: RunRouterStageParams): Promise<TimedResult<RouteMessageResult>> {
  const start = now();
  let result: RouteMessageResult;
  try {
    result = await routeMessage(params);
  } catch (error) {
    throw toPipelineError("PARSER", error);
  }
  const ms = elapsed(start);
  if (!isValidParseResult(result.parseResult)) {
    throw new PipelineError("PARSER", "LLM router produced a malformed ParseResult.");
  }
  return { result, ms };
}

// SAFETY is fused into the parser call above (evaluateSafety runs inside
// parseMessage) — this just re-validates the field the safety layer is
// responsible for, giving the orchestrator's pipeline events something real
// to report for the "Safety Complete" step without re-running any logic.
export function checkSafetyStage(parseResult: ParseResult): void {
  const decision = parseResult.safetyDecision;
  const valid = decision === "SAFE_TO_EXECUTE" || decision === "ASK_CLARIFICATION" ||
    decision === "REJECT_UNAVAILABLE" || decision === "REJECT_NOT_IN_CART" || decision === "NO_CART_ACTION";
  if (!valid) {
    throw new PipelineError("SAFETY", `Parser produced an unrecognized safety decision: ${String(decision)}.`);
  }
}

// CART is fused into the state call below (executeParseResult runs inside
// processMessage) — see runStateStage.
export function runStateStage(context: OrderContext, parseResult: ParseResult, menu: Menu): TimedResult<OrderContext> {
  const { result, ms } = time(() => {
    try {
      return processMessage(context, parseResult, menu);
    } catch (error) {
      throw toPipelineError("STATE", error);
    }
  });
  if (!isValidOrderContext(result)) {
    throw new PipelineError("STATE", "Order state engine returned a malformed OrderContext.");
  }
  return { result, ms };
}

export function runResponseStage(input: ResponseBuilderInput): TimedResult<string> {
  const { result, ms } = time(() => {
    try {
      return buildResponse(input);
    } catch (error) {
      throw toPipelineError("RESPONSE", error);
    }
  });
  if (!isValidCustomerResponse(result)) {
    throw new PipelineError("RESPONSE", "Response builder returned an empty/malformed reply.");
  }
  return { result, ms };
}

export function runLoggerStage(logger: Logger, params: BuildLogEntryParams): TimedResult<MessageLogEntry> {
  const { result, ms } = time(() => {
    try {
      const entry = buildLogEntry(params);
      logger.log(entry);
      return entry;
    } catch (error) {
      throw toPipelineError("LOGGER", error);
    }
  });
  return { result, ms };
}
