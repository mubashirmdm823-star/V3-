// V2 Action Planner — types.
//
// An ActionPlan is the ordered "task queue" the order state engine executes
// for a single customer message: exact items land immediately (ADD_ITEM),
// ambiguous categories become questions to ask later (ASK_CLARIFICATION),
// and completely unmatched queries are reported rather than silently
// dropped (REJECT_UNAVAILABLE). One customer message can — and often does —
// produce several actions of different kinds at once; every one of them is
// accounted for, never all-or-nothing.

import type { MenuItem } from "../types/menu";

export interface AddItemPlanAction {
  type: "ADD_ITEM";
  itemId: string;
  quantity: number;
  // The original text this action was resolved from — for traceability/
  // logging only, never shown to the customer verbatim.
  query: string;
}

export interface AskClarificationPlanAction {
  type: "ASK_CLARIFICATION";
  category: string;
  quantity: number;
  options: MenuItem[];
  query: string;
}

export interface RejectUnavailablePlanAction {
  type: "REJECT_UNAVAILABLE";
  query: string;
}

export type PlannedAction = AddItemPlanAction | AskClarificationPlanAction | RejectUnavailablePlanAction;

export interface ActionPlan {
  actions: PlannedAction[];
}

export function isAskClarificationAction(action: PlannedAction): action is AskClarificationPlanAction {
  return action.type === "ASK_CLARIFICATION";
}
