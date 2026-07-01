// Deterministic cart shapes. The AI never touches these directly — the
// cart engine (v2/cart-engine) is the only code allowed to turn a CartOperation
// into a new CartState. Mirrors the proven CartItem/CartAction split already
// used by lib/think-food-ai.ts's applyCartAction reducer.

export interface CartLineItem {
  itemId: string;
  name: string;
  price: number;
  qty: number;
}

export interface CartState {
  items: CartLineItem[];
}

export type CartOperation =
  | { op: "add"; itemId: string; qty: number }
  | { op: "remove"; itemId: string }
  | { op: "set_quantity"; itemId: string; qty: number }
  | { op: "clear" };
