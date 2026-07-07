// Draft contract for the AI <-> cart engine boundary. The AI (intent-parser,
// step 3) only ever produces an Intent — it never mutates cart or order state
// itself. The cart engine and order-state engine are the deterministic code
// that decide what to do with an Intent, after it has passed through the
// safety layer (v2/intent-parser/safety.ts).
//
// This is a first-draft shape scaffolded alongside the folder structure; it
// is expected to be refined once the full NLU intent parser is implemented.

export type IntentType =
  | "add_item"
  | "remove_item"
  | "update_quantity"
  | "replace_item"
  | "clear_cart"
  | "show_menu"
  | "show_category"
  | "show_options"
  | "price_query"
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
  // Menu item ids the parser thinks this query could refer to, already
  // resolved against v2/data/menu.json. The safety layer uses the *count* of
  // candidates to decide what's safe:
  //   0 candidates  -> not on the menu at all (unavailable)
  //   1 candidate   -> unambiguous match
  //   2+ candidates -> ambiguous (bare category/family word) -> must ask
  candidateItemIds?: string[];
}

export interface ReplaceIntentDetail {
  sourceQuery: string;
  targetQuery: string;
  // Candidates for the item being replaced, resolved against the CURRENT
  // CART (not the whole menu) — replacing only makes sense for something
  // already ordered.
  sourceCandidateItemIds?: string[];
  // Candidates for the new item, resolved against the full menu.
  targetCandidateItemIds?: string[];
}

export interface Intent {
  type: IntentType;
  rawText: string;
  // 0..1 confidence the parser has in `type` (and any resolved items) being
  // correct. See v2/intent-parser/confidence.ts for the thresholds that gate
  // what the safety layer allows this confidence to authorize.
  confidence: number;
  items?: IntentItemRef[];
  replace?: ReplaceIntentDetail;
  category?: string; // e.g. "pasta" — set for show_category / ambiguous-category flows
  quantity?: number;
}
