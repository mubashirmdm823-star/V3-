// V2 phase 8 — the fixed pipeline stage order + event-log helper.
//
// This is a list and a small append-only helper, not a decision-maker: the
// actual orchestration lives in process-message.ts. Keeping the stage order
// declared once here means the orchestrator and its tests reference the
// same source of truth for "what order do stages run in."

import type { PipelineEventLog, PipelineEventName } from "./result";

export const PIPELINE_STAGE_ORDER: readonly PipelineEventName[] = [
  "PIPELINE_STARTED",
  "PARSER_COMPLETE",
  "SAFETY_COMPLETE",
  "CART_COMPLETE",
  "STATE_COMPLETE",
  "RESPONSE_COMPLETE",
  "LOGGER_COMPLETE",
  "PIPELINE_FINISHED",
];

export function recordEvent(
  events: PipelineEventLog[],
  name: PipelineEventName,
  durationMs?: number,
  now: () => Date = () => new Date()
): PipelineEventLog[] {
  return [...events, { name, timestamp: now().toISOString(), durationMs }];
}
