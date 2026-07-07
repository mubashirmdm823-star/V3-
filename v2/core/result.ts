// V2 phase 8 — shared result/event/timing shapes returned by the
// orchestrator (process-message.ts). Types only — no logic.

import type { OrderContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import type { MessageLogEntry } from "../logger/events";
import type { PipelineStage } from "./errors";

export type PipelineEventName =
  | "PIPELINE_STARTED"
  | "PARSER_COMPLETE"
  | "SAFETY_COMPLETE"
  | "CART_COMPLETE"
  | "STATE_COMPLETE"
  | "RESPONSE_COMPLETE"
  | "LOGGER_COMPLETE"
  | "PIPELINE_FINISHED"
  | "PIPELINE_FAILED";

export interface PipelineEventLog {
  name: PipelineEventName;
  timestamp: string;
  // Only set for the *_COMPLETE events that mark the end of a measured
  // stage; PIPELINE_STARTED/FINISHED/FAILED are pure markers.
  durationMs?: number;
}

// SAFETY/CART are fused into PARSER/STATE respectively in this architecture
// (evaluateSafety runs inside parseMessage; executeParseResult runs inside
// processMessage — see v2/logger/performance.ts's header, which documents
// the exact same limitation for the logging layer). safetyMs/cartMs are
// always 0 here for that reason, not because those stages didn't run.
export interface PipelineTiming {
  parserMs: number;
  safetyMs: number;
  cartMs: number;
  stateMs: number;
  responseMs: number;
  loggerMs: number;
  totalMs: number;
}

export interface ProcessMessageResult {
  reply: string;
  context: OrderContext;
  parseResult: ParseResult;
  logEntry?: MessageLogEntry;
  timing: PipelineTiming;
  events: PipelineEventLog[];
  // true only when a stage threw and a safe-failure fallback path had to be
  // used instead of the normal result of that stage.
  recovered: boolean;
  failedStage?: PipelineStage;
  // Phase 11 — purely observational (nothing downstream branches on this):
  // which path actually produced `parseResult` this turn. "deterministic"
  // covers both "no LLM configured" and "LLM configured but its answer
  // wasn't usable" — see v2/llm/router.ts's RouteMessageResult.
  parserSource: "llm" | "deterministic";
}
