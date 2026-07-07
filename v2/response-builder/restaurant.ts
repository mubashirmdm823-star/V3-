// Restaurant information replies — generated entirely from
// v2/data/restaurant-config.json, never hardcoded.

import type { RestaurantConfig } from "../types/menu";
import { EMOJI, formatCurrency, bulletList, joinParagraphs } from "./formatter";

// restaurant-config.json currently has no "branches" or "payment methods"
// fields — those sections are intentionally omitted rather than
// fabricated. Add the fields to the config first if this needs to expand.
export function buildRestaurantInfoReply(config: RestaurantConfig): string {
  const lines = [
    `${EMOJI.location} Address: ${config.address}`,
    `Timing: ${config.timing}`,
    `${EMOJI.phone} Phone: ${config.phone}`,
    `${EMOJI.delivery} Delivery charges: ${formatCurrency(config.deliveryFee)}`,
    `${EMOJI.delivery} Delivery time: ${config.deliveryTime}`,
  ];
  return joinParagraphs(`${config.name} — Restaurant Info`, bulletList(lines));
}
