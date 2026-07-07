// Executes an ActionPlan's ADD_ITEM entries against the cart, in order —
// the ordered task queue v2/action-planner produces for one customer
// message. ASK_CLARIFICATION and REJECT_UNAVAILABLE entries never touch
// the cart here (the order state engine queues the former, the response
// builder reports the latter); this only ever ADDS, mirroring addItem's
// own duplicate-prevention/merge behavior line by line, so an exact item
// lands immediately regardless of what else in the same plan is still
// ambiguous or unavailable.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import type { ActionPlan } from "../action-planner/types";
import { addItem } from "./add";
import { recordHistory, type CartHistoryEntry } from "./history";

export interface ActionPlanExecutionResult {
  cart: CartState;
  history: CartHistoryEntry[];
}

export function executeActionPlan(plan: ActionPlan, cart: CartState, menu: Menu): ActionPlanExecutionResult {
  let current = cart;
  let history: CartHistoryEntry[] = [];

  for (const action of plan.actions) {
    if (action.type !== "ADD_ITEM") continue;
    const result = addItem(current, action.itemId, menu, action.quantity);
    if (result.ok) {
      history = [...history, recordHistory(current, result.cart, "ADD_ITEM")];
      current = result.cart;
    }
  }

  return { cart: current, history };
}
