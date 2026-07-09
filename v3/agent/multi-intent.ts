// V3 Phase 2 — Multi-Intent Splitter.
//
// A single customer message can carry two INDEPENDENT asks at once
// ("pasta hata do aur kuch spicy suggest karo" — remove pasta AND suggest
// spicy items). The model already reports these structurally on one
// AgentTurnPlan (cartActions for the removal, recommendationRequest for the
// suggestion) rather than as one blob of text — this module is the single
// place that fans a plan out into its independent streams so each is
// handled by the subsystem that actually owns it: cartActions/
// checkoutAction go to actions.ts (cart engine), recommendationRequest goes
// to recommendation-engine.ts. Neither stream is ever inferred from free
// text here — both come straight off the model's own structured output;
// this module only routes, it never re-classifies intent itself.

import type { Menu, MenuItem } from "../../v2/types/menu";
import { findCategoryByName, significantTokens } from "../../v2/intent-parser/matching";
import type { ConversationMemory } from "./conversation-memory";
import { recommendItems } from "./recommendation-engine";
import type { AgentTurnPlan, CartAction, CheckoutAction, RecommendationTheme } from "./schema";

export interface RecommendationOutcome {
  theme: RecommendationTheme;
  items: MenuItem[];
}

// Live bug fix: "burgers ke ilawa spicy ma" / "burger nahi" / bare "is ke
// ilawa" (referring to whatever was just suggested) must exclude that
// category from the NEXT suggestion — previously nothing detected this at
// all, so categoryHint (memory.lastMentionedCategory, set from the PRIOR
// turn's own suggestion — see conversation-memory.ts#updateMemoryAfterTurn)
// kept re-scoping straight back into the very category the customer just
// asked to exclude, repeating the same excluded item every turn. Reuses
// the intent parser's own findCategoryByName (never a new word list) —
// scans the message's significant tokens for one that names a real menu
// category exactly the same way item/category resolution already works
// everywhere else in this codebase.
const EXCLUSION_MARKER_PATTERN = /\bke\s*(ilawa|siwa|alawa)\b|\bilawa\b|\bsiwa\b|\bnahi\b/i;

function detectExcludedCategoryKey(customerMessage: string, menu: Menu, memory: ConversationMemory): string | undefined {
  if (!EXCLUSION_MARKER_PATTERN.test(customerMessage)) return undefined;
  const namedCategory = significantTokens(customerMessage)
    .map((token) => findCategoryByName(token, menu))
    .find((category): category is NonNullable<typeof category> => Boolean(category));
  // No category named in this message ("is ke ilawa" alone) — falls back
  // to whatever category was last actually mentioned/suggested.
  return namedCategory?.key ?? memory.lastMentionedCategory;
}

// Resolves the model's classified theme into REAL menu items, scoped to
// whatever category was last discussed when that helps ("spicy" while
// talking about Burgers prefers a spicy burger over a spicy item from an
// unrelated category) — falls back to the unscoped list when nothing
// matches within scope. An excluded category (see above) is filtered out
// of every candidate pool this turn, scoped AND unscoped alike.
export function resolveRecommendation(plan: AgentTurnPlan, menu: Menu, memory: ConversationMemory, customerMessage: string): RecommendationOutcome | null {
  if (!plan.recommendationRequest) return null;
  const { theme } = plan.recommendationRequest;
  const excludeCategoryKey = detectExcludedCategoryKey(customerMessage, menu, memory);
  const items = recommendItems(menu, theme, memory.lastMentionedCategory, excludeCategoryKey);
  return { theme, items: items.length > 0 ? items : recommendItems(menu, theme, undefined, excludeCategoryKey) };
}

export interface MultiIntentResult {
  cartActions: CartAction[];
  checkoutAction: CheckoutAction | null;
  recommendation: RecommendationOutcome | null;
}

// Phase 3 behaviour rule: Suggest =/= Add. A turn that itself asks for a
// recommendation is, by definition, a "tell me about options" turn — never
// an order — so any add this SAME turn (the model occasionally drafts one
// anyway, e.g. adding the first suggested item on its own initiative) is
// dropped unconditionally. A later, SEPARATE message that explicitly
// confirms ("haan ye add kar do") carries no recommendationRequest of its
// own, so its add goes through normally and is unaffected by this rule.
// remove/replace/change_quantity/clear_cart are untouched — "pasta hata do
// aur kuch spicy suggest karo" must still remove the pasta.
function stripAutoAddsWhenRecommending(cartActions: CartAction[], recommending: boolean): CartAction[] {
  if (!recommending) return cartActions;
  return cartActions.filter((action) => action.type !== "add_item" && action.type !== "add_multiple_items");
}

// The one call site index.ts uses to fan a plan out — cart mutation and
// recommendation resolution happen independently, in the same turn,
// neither blocking nor overwriting the other.
export function splitPlanIntents(plan: AgentTurnPlan, menu: Menu, memory: ConversationMemory, customerMessage: string): MultiIntentResult {
  const recommendation = resolveRecommendation(plan, menu, memory, customerMessage);
  return {
    cartActions: stripAutoAddsWhenRecommending(plan.cartActions, recommendation !== null),
    checkoutAction: plan.checkoutAction,
    recommendation,
  };
}
