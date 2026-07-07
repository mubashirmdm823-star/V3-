// Deterministic cart shapes. The AI never touches these directly — the
// cart engine (v2/cart-engine) is the only code allowed to produce a new
// CartState. Mirrors the proven CartItem/CartAction split already used by
// lib/think-food-ai.ts's applyCartAction reducer.
//
// The actual operation surface (add/remove/replace/quantity/clear) is a set
// of concrete functions in v2/cart-engine/*.ts, each taking explicit
// resolved itemIds/quantities plus the Menu (to look up name/price) rather
// than a single generic "CartOperation" object — see
// v2/cart-engine/index.ts's executeAction()/executeParseResult() for the
// dispatcher that ties them to a parsed intent.

export interface CartLineItem {
  itemId: string;
  name: string;
  price: number;
  qty: number;
}

export interface CartState {
  items: CartLineItem[];
}
