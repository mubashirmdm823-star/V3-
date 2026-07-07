// QA phase 14A — failure classification.
//
// Maps every assertion failure to the pipeline layer that owns the bug, so
// the report can say "the parser misunderstands X" instead of "conversation
// 8812 failed." A recovered pipeline crash classifies by the stage the
// orchestrator itself reported (result.failedStage); everything else
// classifies by what KIND of wrongness the assertion detected.

import type { TurnFailure, FailureCode } from "./assertions";

export type FailureCategory =
  | "PARSER"
  | "SAFETY"
  | "CART"
  | "STATE"
  | "CONTEXT"
  | "RESPONSE"
  | "LOGGER"
  | "LLM"
  | "FALLBACK"
  | "UNKNOWN";

const CODE_TO_CATEGORY: Record<FailureCode, FailureCategory> = {
  PIPELINE_CRASH_RECOVERED: "UNKNOWN", // refined by failedStage below
  REPLY_EMPTY: "RESPONSE",
  REPLY_MALFORMED: "RESPONSE",
  REPLY_LEAKS_INTERNALS: "RESPONSE",
  REPLY_CLAIMS_ADD_WITHOUT_ADD: "RESPONSE",
  CART_CHANGE_NOT_ACKNOWLEDGED: "RESPONSE",
  PRINTED_TOTAL_MISMATCH: "RESPONSE",
  CART_SHAPE_INVALID: "CART",
  CART_PRICE_NAME_MISMATCH: "CART",
  CART_DUPLICATE_LINES: "CART",
  WRONG_ITEM_ADDED: "PARSER",
  WRONG_QUANTITY_ADDED: "PARSER",
  STRICT_ADD_MISSED: "PARSER",
  STRICT_REMOVE_MISSED: "PARSER",
  REMOVE_WRONG_ITEM: "PARSER",
  STRICT_REPLACE_MISSED: "PARSER",
  REPLACE_TURNED_INTO_ADD: "PARSER",
  STRICT_CHANGE_QTY_MISSED: "PARSER",
  REMOVE_ALL_MISSED: "PARSER",
  AMBIGUOUS_SILENTLY_RESOLVED: "SAFETY",
  CLARIFICATION_NOT_OPENED: "SAFETY",
  CLARIFICATION_ANSWER_MISSED: "PARSER",
  CLARIFICATION_WRONG_QTY: "PARSER",
  STATE_ILLEGAL_VALUE: "STATE",
  STATE_UNEXPECTED: "STATE",
  PENDING_CLARIFICATION_INCONSISTENT: "STATE",
  ADDRESS_STAGE_WITHOUT_DELIVERY: "STATE",
  STORED_ADDRESS_MISMATCH: "STATE",
  STORED_NAME_MISMATCH: "STATE",
  FINISHED_WITH_EMPTY_CART: "STATE",
  CHECKOUT_STAGE_MISSED: "STATE",
  INFO_MISSING_FROM_REPLY: "RESPONSE",
  PRICE_MISSING_FROM_REPLY: "RESPONSE",
  CART_MUTATED_BY_NON_ORDER_MESSAGE: "SAFETY",
  CONTEXT_ROUNDTRIP_FAILED: "CONTEXT",
};

const STAGE_TO_CATEGORY: Record<string, FailureCategory> = {
  PARSER: "PARSER",
  SAFETY: "SAFETY",
  CART: "CART",
  STATE: "STATE",
  CONTEXT: "CONTEXT",
  RESPONSE: "RESPONSE",
  LOGGER: "LOGGER",
  LLM: "LLM",
  FALLBACK: "FALLBACK",
};

export interface ClassifiedFailure extends TurnFailure {
  category: FailureCategory;
  turnIndex: number;
  message: string; // the customer message that triggered it
}

export function classifyFailure(failure: TurnFailure, failedStage?: string): FailureCategory {
  if (failure.code === "PIPELINE_CRASH_RECOVERED" && failedStage && STAGE_TO_CATEGORY[failedStage]) {
    return STAGE_TO_CATEGORY[failedStage];
  }
  return CODE_TO_CATEGORY[failure.code] ?? "UNKNOWN";
}
