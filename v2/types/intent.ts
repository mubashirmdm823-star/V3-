// Draft contract for the AI <-> cart engine boundary. The AI (intent-parser,
// step 3) only ever produces an Intent — it never mutates cart or order state
// itself. The cart engine and order-state engine are the deterministic code
// that decide what to do with an Intent.
//
// This is a first-draft shape scaffolded alongside the folder structure; it
// is expected to be refined once the intent parser is actually implemented.

export type IntentType =
  | "add_item"
  | "remove_item"
  | "update_quantity"
  | "clear_cart"
  | "show_menu"
  | "show_category"
  | "ask_info"
  | "checkout"
  | "provide_order_type"
  | "provide_address"
  | "provide_name"
  | "confirm_order"
  | "small_talk"
  | "unknown";

export interface IntentItemRef {
  // Raw text naming the item as the customer wrote it — the cart engine is
  // responsible for resolving this to a real MenuItem id, never the AI.
  query: string;
  quantity?: number;
}

export interface Intent {
  type: IntentType;
  items?: IntentItemRef[];
  category?: string;
  quantity?: number;
  rawText: string;
}
