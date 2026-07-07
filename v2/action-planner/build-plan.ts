// V2 Action Planner — converts a ParseResult (produced by EITHER the
// deterministic intent parser or, via v2/llm/parse-result-mapper.ts, a
// validated LLM response — both share the exact same ParseResult contract)
// into an ActionPlan.
//
// This is the fix for the historical bug where ONE ambiguous item in a
// multi-item message ("ek hotshot kardo ek pasta or 4 chowmin") caused the
// whole message's aggregate safetyDecision to be ASK_CLARIFICATION,
// silently dropping the exact "hotshot" and only ever asking about the
// FIRST ambiguous item, forever losing the second ("chowmein"). Rather than
// aggregating to one worst-case decision, buildActionPlan classifies EVERY
// item independently — this is a strict per-item refinement, mirroring
// v2/intent-parser/safety.ts#evaluateAddItem's own per-item rule exactly
// (single-high-confidence-candidate -> add; 2+ candidates, or a single
// candidate below the confidence threshold -> ask; 0 candidates -> unavailable)
// without re-aggregating the result into one verdict for the whole message.

import type { Menu } from "../types/menu";
import type { ParseResult } from "../types/parser";
import { findCategoryForItemId } from "../intent-parser/matching";
import { findMenuItem } from "../cart-engine/validate";
import { isHighConfidence } from "../intent-parser/confidence";
import type { ActionPlan, PlannedAction } from "./types";

// Category label priority, mirroring order-state-engine/clarification.ts's
// buildPendingClarification exactly for the ref it was computed for:
//
// 1. parseResult.category, but ONLY when this ref is the one the parser
//    actually computed it for (ref.query === parseResult.category) — this
//    preserves the parser's own, deliberately NARROWER "family" labels
//    (e.g. "zinger" — 3 items within Burgers, not the whole 6-item
//    category) which come from a different mechanism entirely
//    (intent-parser/matching.ts's familyMatches()) and can't be
//    reconstructed from candidate ids alone.
// 2. The one real menu category every candidate shares (e.g. all 5 pasta
//    variants share category key "pasta") — used for any OTHER ambiguous
//    ref in the same message, since parseResult.category only ever
//    describes a single ref today (a second ambiguous item, e.g. a
//    "chowmein" ambiguity alongside a "pasta" one, must get its OWN label
//    rather than inheriting the first ref's).
// 3. The raw query text — genuine cross-category family ambiguity (e.g.
//    bare "small" spans Pasta/Pizza/Toppings).
function resolveCategoryLabel(ref: { query: string; candidateItemIds?: string[] }, parseResultCategory: string | undefined, menu: Menu): string {
  if (parseResultCategory && ref.query === parseResultCategory) return parseResultCategory;
  const keys = new Set(
    (ref.candidateItemIds ?? []).map((id) => findCategoryForItemId(menu, id)?.key).filter((key): key is string => Boolean(key))
  );
  return keys.size === 1 ? [...keys][0] : ref.query;
}

export function buildActionPlan(parseResult: ParseResult, menu: Menu): ActionPlan {
  const actions: PlannedAction[] = [];

  for (const ref of parseResult.items) {
    const candidateIds = ref.candidateItemIds ?? [];
    const quantity = ref.quantity ?? 1;

    if (candidateIds.length === 0) {
      actions.push({ type: "REJECT_UNAVAILABLE", query: ref.query });
      continue;
    }

    if (candidateIds.length === 1 && isHighConfidence(parseResult.confidence)) {
      actions.push({ type: "ADD_ITEM", itemId: candidateIds[0], quantity, query: ref.query });
      continue;
    }

    // Either genuinely ambiguous (2+ candidates) or a single candidate at
    // less-than-high confidence — both need the customer to confirm before
    // anything is added, exactly mirroring evaluateAddItem's per-item rule.
    const options = candidateIds
      .map((id) => findMenuItem(menu, id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    actions.push({
      type: "ASK_CLARIFICATION",
      category: resolveCategoryLabel(ref, parseResult.category, menu),
      quantity,
      options,
      query: ref.query,
    });
  }

  return { actions };
}
