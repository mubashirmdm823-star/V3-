// Checkout-flow customer prompts: order review, delivery/pickup, address,
// name, final review, and the pending-verification confirmation. This is
// the response builder's own authoritative copy for these steps — it does
// not import order-state-engine's internal PENDING_VERIFICATION_MESSAGE,
// since this module is the one place customer-facing text is allowed to
// live.

import type { CartState } from "../types/cart";
import type { Menu } from "../types/menu";
import type { OrderType } from "../types/order";
import { EMOJI } from "./formatter";
import { buildOrderSummary } from "./order-summary";

export function buildOrderReviewReply(cart: CartState, menu: Menu): string {
  const summary = buildOrderSummary(cart, menu, "Order Review");
  return [
    "Aapka order review tayyar hai. Ek baar check kar lein.",
    "",
    summary,
    "",
    'Agar sab theek hai to "Confirm Order" likhein.',
  ].join("\n");
}

export const DELIVERY_OR_PICKUP_PROMPT = "Delivery chahiye ya Pickup?";

export const ADDRESS_REQUEST_PROMPT = "Barah-e-meherbani apna complete delivery address bhej dein.";

export const NAME_REQUEST_PROMPT = "Barah-e-meherbani apna naam batayein.";

export function buildFinalReviewReply(
  cart: CartState,
  menu: Menu,
  deliveryType: OrderType | undefined,
  address: string | undefined,
  customerName: string | undefined
): string {
  const summary = buildOrderSummary(cart, menu, "Final Order Review");
  const details = [
    `Naam: ${customerName ?? "-"}`,
    deliveryType === "delivery" ? `Delivery Address: ${address ?? "-"}` : "Order Type: Pickup",
  ].join("\n");
  return [summary, "", details, "", 'Order confirm karne ke liye "Submit" likhein.'].join("\n");
}

export const PENDING_VERIFICATION_REPLY = [
  `${EMOJI.success} Aapka order receive kar liya gaya hai.`,
  "",
  "Status: Pending Verification",
  "",
  "Hamari team jald aapse rabta karegi aur order confirm karegi.",
].join("\n");

export function alreadyFinalizedMessage(state: "PENDING_VERIFICATION" | "CANCELLED"): string {
  if (state === "CANCELLED") {
    return "Yeh order cancel ho chuka hai. Naya order shuru karne ke liye item ka naam bhej dein.";
  }
  return "Aapka order pehle hi receive ho chuka hai aur verification ke liye pending hai. Hamari team jald rabta karegi.";
}
