// V2 logging & analytics layer.
//
// Purely observational: it wraps the already-built pipeline (intent parser
// -> order state engine, which itself calls the cart engine) to time it and
// record what happened. It never changes what the pipeline returns — every
// function here either takes already-computed results and derives a log
// entry, or aggregates over previously-recorded entries. Nothing is wired
// into the UI or `app/api/chat/route.ts`.

import type { Menu } from "../types/menu";
import type { OrderContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import { parseMessage } from "../intent-parser/parser";
import { processMessage } from "../order-state-engine";
import { now, elapsed, type PerformanceMetrics } from "./performance";
import { buildLogEntry, Logger } from "./logger";
import type { MessageLogEntry } from "./events";

export interface ProcessMessageWithLoggingResult {
  context: OrderContext;
  parseResult: ParseResult;
  logEntry: MessageLogEntry;
}

// Convenience entry point demonstrating the intended integration: runs the
// real pipeline exactly as it would run without logging, times each stage
// it has visibility into from the outside, and records a MessageLogEntry.
// `context` (and therefore cart/state behavior) is never altered by the
// presence of a logger.
export function processMessageWithLogging(
  rawMessage: string,
  context: OrderContext,
  menu: Menu,
  logger: Logger
): ProcessMessageWithLoggingResult {
  const overallStart = now();

  const parserStart = now();
  const parseResult = parseMessage(rawMessage, context.cart, menu);
  const parserMs = elapsed(parserStart);

  const stateStart = now();
  const nextContext = processMessage(context, parseResult, menu);
  const stateMs = elapsed(stateStart);

  const totalMs = elapsed(overallStart);

  const performanceMetrics: PerformanceMetrics = {
    parserMs,
    // See performance.ts's header comment: safety/cart execution are fused
    // into parserMs/stateMs respectively in this pipeline and aren't
    // separately measurable from outside without re-running work.
    safetyMs: 0,
    cartMs: 0,
    stateMs,
    responseMs: 0,
    totalMs,
  };

  const logEntry = buildLogEntry({
    sessionId: logger.sessionId,
    conversationId: logger.conversationId,
    rawMessage,
    parseResult,
    before: context,
    after: nextContext,
    menu,
    performance: performanceMetrics,
  });

  logger.log(logEntry);

  return { context: nextContext, parseResult, logEntry };
}

export type { MessageLogEntry, DetectedLanguage, ItemReplacedLog, QuantityChangeLog } from "./events";
export { detectLanguage } from "./events";

export type { PerformanceMetrics, PerformanceStats } from "./performance";
export { time, now, elapsed, computePerformanceStats } from "./performance";

export type { SessionAnalyticsState, SessionAnalyticsSummary } from "./session";
export { createSessionAnalyticsState, recordMessageInSession, getSessionAnalytics } from "./session";

export type { BuildLogEntryParams, CartAnalytics } from "./logger";
export { Logger, buildLogEntry, computeCartAnalytics } from "./logger";

export { buildReasoningSummary, buildDebugReport } from "./debug";

export { exportAsJSON, exportAsCSV, exportDebugReport } from "./export";
