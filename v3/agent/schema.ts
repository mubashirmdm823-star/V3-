// V3 one-call agent — the JSON contract Gemini must return.
//
// Flatter and more explicit than the old generic { tool, params } call
// list: every cart/checkout action is its own typed shape, validated
// strictly before anything touches the cart. Gemini gives raw customer
// text for every item mention ("hotshot", "mexican") — never a menu item
// id — resolution against the real menu happens in actions.ts, exactly
// like every prior V2/V3 layer, so "never invent a menu item" stays a
// structural guarantee, not just a prompt instruction.

export interface ItemMention {
  query: string;
  quantity?: number;
}

export type CartAction =
  | { type: "add_item"; query: string; quantity?: number }
  | { type: "add_multiple_items"; items: ItemMention[] }
  | { type: "remove_item"; query: string }
  | { type: "replace_item"; fromQuery: string; toQuery: string }
  | { type: "change_quantity"; query: string; quantity: number }
  | { type: "clear_cart" };

export type CheckoutAction =
  | { type: "start_checkout" }
  | { type: "confirm_order" }
  | { type: "select_delivery" }
  | { type: "select_pickup" }
  | { type: "save_address"; address: string }
  | { type: "save_customer_name"; name: string }
  | { type: "escalate_to_human" }
  | { type: "cancel_order" };

// Phase 2 — recommendation intelligence. The model classifies WHICH theme
// the customer asked about (structural, not free text) so the backend
// (recommendation-engine.ts) can look up REAL menu items for it — never
// letting the model invent a suggestion itself. An unrecognized theme
// string is treated as malformed (see validateRecommendationRequest), not
// silently coerced, so a plan carrying garbage here still fails cleanly.
export const RECOMMENDATION_THEMES = ["spicy", "mild", "popular", "kids", "vegetarian"] as const;
export type RecommendationTheme = (typeof RECOMMENDATION_THEMES)[number];

export interface RecommendationRequest {
  theme: RecommendationTheme;
}

// The single combined LLM call's output shape — a reply AND every cart/
// checkout action to apply, in one response, so a turn needs at most one
// Gemini call. `pendingClarifications` is part of the wire contract (the
// model may name what it thinks is still unresolved) but is advisory only:
// the actual clarification queue is always derived deterministically from
// how `cartActions` resolve against the real menu (see actions.ts) — never
// from the model's own claim about what's pending.
export interface AgentTurnPlan {
  reply: string;
  cartActions: CartAction[];
  pendingClarifications: string[];
  checkoutAction: CheckoutAction | null;
  // Optional — absent (older-shaped plans, every existing test fixture)
  // means "no recommendation requested", same as an explicit null.
  recommendationRequest: RecommendationRequest | null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asQuantity(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function validateItemMentions(value: unknown): ItemMention[] | null {
  if (!Array.isArray(value)) return null;
  const items: ItemMention[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const query = asTrimmedString(entry.query);
    if (!query) return null;
    items.push({ query, quantity: asQuantity(entry.quantity) });
  }
  return items;
}

function validateCartAction(value: unknown): CartAction | null {
  if (!isPlainObject(value)) return null;
  switch (value.type) {
    case "add_item": {
      const query = asTrimmedString(value.query);
      return query ? { type: "add_item", query, quantity: asQuantity(value.quantity) } : null;
    }
    case "add_multiple_items": {
      const items = validateItemMentions(value.items);
      return items && items.length > 0 ? { type: "add_multiple_items", items } : null;
    }
    case "remove_item": {
      const query = asTrimmedString(value.query);
      return query ? { type: "remove_item", query } : null;
    }
    case "replace_item": {
      const fromQuery = asTrimmedString(value.fromQuery);
      const toQuery = asTrimmedString(value.toQuery);
      return fromQuery && toQuery ? { type: "replace_item", fromQuery, toQuery } : null;
    }
    case "change_quantity": {
      const query = asTrimmedString(value.query);
      const quantity = asQuantity(value.quantity);
      return query && quantity !== undefined ? { type: "change_quantity", query, quantity } : null;
    }
    case "clear_cart":
      return { type: "clear_cart" };
    default:
      return null;
  }
}

function validateCheckoutAction(value: unknown): CheckoutAction | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined; // malformed — caller treats the whole plan as invalid
  switch (value.type) {
    case "start_checkout":
    case "confirm_order":
    case "select_delivery":
    case "select_pickup":
    case "escalate_to_human":
    case "cancel_order":
      return { type: value.type };
    case "save_address": {
      const address = asTrimmedString(value.address);
      return address ? { type: "save_address", address } : undefined;
    }
    case "save_customer_name": {
      const name = asTrimmedString(value.name);
      return name ? { type: "save_customer_name", name } : undefined;
    }
    default:
      return undefined;
  }
}

const RECOMMENDATION_THEME_SET: ReadonlySet<string> = new Set(RECOMMENDATION_THEMES);

// Same null/undefined/malformed convention as validateCheckoutAction:
// missing or explicit null both mean "nothing requested"; anything else
// that isn't a recognized theme is malformed (invalidates the whole plan)
// rather than silently defaulting to some guessed theme.
function validateRecommendationRequest(value: unknown): RecommendationRequest | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  return typeof value.theme === "string" && RECOMMENDATION_THEME_SET.has(value.theme)
    ? { theme: value.theme as RecommendationTheme }
    : undefined;
}

// A runaway plan (implausibly many actions) is never legitimate, but an
// EMPTY action list is: pure small talk, a greeting, an informational
// question, or a recommendation needs no cart/checkout action at all.
const MAX_CART_ACTIONS = 10;

// Never trusts the model's JSON — returns null on ANY malformed field,
// exactly like the old validateCombinedTurnPlan/v2's json-validator. The
// caller (index.ts) falls back to the full V2 pipeline whenever this
// returns null.
export function validateAgentTurnPlan(value: unknown): AgentTurnPlan | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.reply !== "string") return null;

  if (!Array.isArray(value.cartActions) || value.cartActions.length > MAX_CART_ACTIONS) return null;
  const cartActions: CartAction[] = [];
  for (const entry of value.cartActions) {
    const action = validateCartAction(entry);
    if (!action) return null;
    cartActions.push(action);
  }

  const pendingClarifications = Array.isArray(value.pendingClarifications)
    ? value.pendingClarifications.filter((v): v is string => typeof v === "string")
    : [];

  const checkoutAction = validateCheckoutAction(value.checkoutAction);
  if (checkoutAction === undefined) return null;

  const recommendationRequest = validateRecommendationRequest(value.recommendationRequest);
  if (recommendationRequest === undefined) return null;

  return { reply: value.reply, cartActions, pendingClarifications, checkoutAction, recommendationRequest };
}
