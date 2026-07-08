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
import type { ConversationMemory } from "./conversation-memory";
import { recommendItems } from "./recommendation-engine";
import type { AgentTurnPlan, CartAction, CheckoutAction, RecommendationTheme } from "./schema";

export interface RecommendationOutcome {
  theme: RecommendationTheme;
  items: MenuItem[];
}

// Resolves the model's classified theme into REAL menu items, scoped to
// whatever category was last discussed when that helps ("spicy" while
// talking about Burgers prefers a spicy burger over a spicy item from an
// unrelated category) — falls back to the unscoped list when nothing
// matches within scope.
export function resolveRecommendation(plan: AgentTurnPlan, menu: Menu, memory: ConversationMemory): RecommendationOutcome | null {
  if (!plan.recommendationRequest) return null;
  const { theme } = plan.recommendationRequest;
  const items = recommendItems(menu, theme, memory.lastMentionedCategory);
  return { theme, items: items.length > 0 ? items : recommendItems(menu, theme) };
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
export function splitPlanIntents(plan: AgentTurnPlan, menu: Menu, memory: ConversationMemory): MultiIntentResult {
  const recommendation = resolveRecommendation(plan, menu, memory);
  return {
    cartActions: stripAutoAddsWhenRecommending(plan.cartActions, recommendation !== null),
    checkoutAction: plan.checkoutAction,
    recommendation,
  };
}
