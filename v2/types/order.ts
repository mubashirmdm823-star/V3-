// Conversation/order state shapes, mirroring lib/think-food-ai.ts's
// Phase/Draft. OrderStatus/OrderType stay imported from the existing
// types/order.ts so there is one source of truth for the admin/kitchen side.

import type { OrderStatus, OrderType } from "@/types/order";
import type { CartState } from "./cart";

export type ConversationPhase =
  | "browsing"
  | "item_selected"
  | "checkout_review"
  | "checkout_type"
  | "checkout_address"
  | "checkout_name"
  | "checkout_summary"
  | "done";

export interface ConversationState {
  phase: ConversationPhase;
  cart: CartState;
  orderType?: OrderType;
  address?: string;
  customerName?: string;
}

export type { OrderStatus, OrderType };
