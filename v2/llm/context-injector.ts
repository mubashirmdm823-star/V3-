// V2 phase 10 — context injection.
//
// Picks exactly the fields the LLM is allowed to see out of the already-
// built AIContext (v2/context-builder) — conversation summary, current
// cart, current state, relevant menu, pending clarification, restaurant
// config. Deliberately never touches `aiContext.history` (full turn
// history) or the full `menu` (only `aiContext.relevantMenu`, already
// pruned by the context builder) — "never inject full history / full
// menu" is enforced by simply never reading those fields here, not by a
// runtime check.

import type { CartState } from "../types/cart";
import type { Menu, RestaurantConfig } from "../types/menu";
import type { OrderState, PendingClarificationContext } from "../types/order";
import type { AIContext } from "../context-builder";

export interface LLMContextInjection {
  conversationSummary: string;
  currentCart: CartState;
  currentState: OrderState;
  relevantMenu: Menu;
  pendingClarification?: PendingClarificationContext;
  restaurantConfig: RestaurantConfig;
}

export function buildContextInjection(aiContext: AIContext): LLMContextInjection {
  const injection: LLMContextInjection = {
    conversationSummary: aiContext.summary,
    currentCart: aiContext.currentCart,
    currentState: aiContext.currentState,
    relevantMenu: aiContext.relevantMenu,
    restaurantConfig: aiContext.restaurantConfig,
  };
  if (aiContext.pendingClarification) injection.pendingClarification = aiContext.pendingClarification;
  return injection;
}

export function renderCartAsText(cart: CartState): string {
  if (cart.items.length === 0) return "Empty";
  return cart.items.map((line) => `${line.qty} x ${line.name} (id: ${line.itemId})`).join("\n");
}

export function renderMenuAsText(menu: Menu): string {
  if (menu.categories.length === 0) return "(no menu items are relevant to this message)";
  return menu.categories
    .map((cat) => {
      const items = cat.items.map((i) => `  - ${i.name} (id: ${i.id}, price: ${i.price})`).join("\n");
      return `${cat.title}:\n${items}`;
    })
    .join("\n");
}

export function renderPendingClarificationAsText(pending: PendingClarificationContext | undefined): string {
  if (!pending) return "None";
  const options = pending.options.map((o) => `${o.name} (id: ${o.id})`).join(", ");
  return `Category: ${pending.category}. Quantity requested: ${pending.quantity}. Options: ${options}.`;
}

export function renderRestaurantConfigAsText(config: RestaurantConfig): string {
  return [
    `Name: ${config.name}`,
    `Address: ${config.address}`,
    `Timing: ${config.timing}`,
    `Phone: ${config.phone}`,
    `Delivery fee: ${config.deliveryFee} ${config.currency}`,
    `Delivery time: ${config.deliveryTime}`,
  ].join("\n");
}
