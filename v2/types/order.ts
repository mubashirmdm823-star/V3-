// Conversation/order state shapes for the V2 order state engine
// (v2/order-state-engine/). OrderStatus/OrderType stay imported from the
// existing top-level types/order.ts so there is one source of truth shared
// with the admin/kitchen side.

import type { OrderType } from "@/types/order";
import type { CartState } from "./cart";
import type { MenuItem } from "./menu";
import type { IntentName } from "./parser";

export type { OrderStatus, OrderType } from "@/types/order";

export type OrderState =
  | "BROWSING"
  | "CART_EDITING"
  | "AWAITING_CLARIFICATION"
  | "ORDER_REVIEW"
  | "AWAITING_DELIVERY_PICKUP"
  | "AWAITING_ADDRESS"
  | "AWAITING_NAME"
  | "READY_TO_SUBMIT"
  | "PENDING_VERIFICATION"
  | "CANCELLED";

// What's pending while in AWAITING_CLARIFICATION — enough to both re-ask the
// same question if the reply doesn't resolve it, and to scope-resolve a
// bare follow-up ("small") against just this category.
export interface PendingClarificationContext {
  category: string;
  quantity: number;
  question: string;
  options: MenuItem[];
  previousMessage: string;
}

export interface OrderContext {
  state: OrderState;
  cart: CartState;
  // The CURRENT question being asked — always clarificationQueue[0] when a
  // queue exists. Kept as its own field (rather than derived) so every
  // pre-existing consumer that only ever knew about a single pending
  // clarification keeps working unchanged.
  pendingClarification?: PendingClarificationContext;
  // The FULL ordered backlog of not-yet-resolved ambiguities from one or
  // more customer messages (the "Clarification Queue") — index 0 is always
  // identical to pendingClarification. Optional/undefined is equivalent to
  // "a queue of just pendingClarification" (or empty) — see
  // order-state-engine/clarification.ts#getClarificationQueue, the only
  // correct way to read this. Never read this field directly.
  clarificationQueue?: PendingClarificationContext[];
  deliveryType?: OrderType;
  address?: string;
  customerName?: string;
  lastIntent?: IntentName;
  lastAction?: string;
  orderReviewShown: boolean;
  createdAt: string;
  updatedAt: string;
}
