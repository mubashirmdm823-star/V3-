// V3 Phase 2 — Recommendation Engine.
//
// Turns a classified theme (schema.ts's RecommendationTheme, set by the
// model on AgentTurnPlan.recommendationRequest) into REAL menu items —
// never invented, never hallucinated. menu.json (v2/types/menu.ts's
// MenuItem) carries no "spicy"/"popular"/"kids" tag of its own, so every
// theme here is a documented, narrow, name-based heuristic over the real
// catalog — not a guess, and always re-verified against the live menu at
// call time (so if an item is ever removed from the menu, it silently
// drops out of these lists rather than being suggested anyway).

import type { Menu, MenuItem } from "../../v2/types/menu";
import { allMenuItems } from "../../v2/intent-parser/matching";
import type { RecommendationTheme } from "./schema";

// Shared with reference-resolver.ts ("spicy wala") — the ONE place that
// decides what counts as spicy, so both features agree.
const SPICY_NAME_KEYWORDS = ["spicy", "hot", "peri", "chilli", "chili"];

export function isSpicyItem(item: MenuItem): boolean {
  const name = item.name.toLowerCase();
  return SPICY_NAME_KEYWORDS.some((k) => name.includes(k));
}

// The restaurant's own "Think Food Special/SP" branding is the only
// non-arbitrary "this is what we're known for" signal available in the
// data — used as the "popular" heuristic rather than inventing a ranking.
function isSignatureItem(item: MenuItem): boolean {
  const name = item.name.toLowerCase();
  return name.includes("special") || name.includes(" sp ") || name.startsWith("think food sp");
}

const MILD_EXCLUDE_KEYWORDS = [...SPICY_NAME_KEYWORDS];
function isMildItem(item: MenuItem): boolean {
  const name = item.name.toLowerCase();
  return !MILD_EXCLUDE_KEYWORDS.some((k) => name.includes(k));
}

// No age-appropriateness data exists either — "kid-friendly" is scoped to
// mild items from categories a child would plausibly order from (never a
// full-size steak/jumbo burger), always re-checked against the real menu.
const KIDS_CATEGORY_KEYS = new Set(["starters", "rice", "noodles", "sandwiches"]);

const MAX_SUGGESTIONS = 3;

// excludeCategoryKey: live bug fix — a customer who explicitly excludes a
// category ("burgers ke ilawa spicy ma", "is ke ilawa") must never see an
// item from that category again, even though categoryHint (below) would
// otherwise keep re-scoping suggestions right back into it (categoryHint
// is usually the LAST-mentioned category, which after one suggestion IS
// the just-suggested, now-excluded item's own category — see
// multi-intent.ts#resolveRecommendation for why). Filtered out of the pool
// BEFORE categoryHint scoping, so a categoryHint that equals the excluded
// category correctly falls through to the broader (still exclusion-safe)
// pool instead of self-defeating back to an empty scoped list.
export function recommendItems(menu: Menu, theme: RecommendationTheme, categoryHint?: string, excludeCategoryKey?: string): MenuItem[] {
  const all = allMenuItems(menu);
  let pool: MenuItem[];

  switch (theme) {
    case "spicy":
      pool = all.filter(isSpicyItem);
      break;
    case "mild":
      pool = all.filter(isMildItem);
      break;
    case "popular":
      pool = all.filter(isSignatureItem);
      break;
    case "kids":
      pool = menu.categories.filter((c) => KIDS_CATEGORY_KEYS.has(c.key)).flatMap((c) => c.items.filter(isMildItem));
      break;
    case "vegetarian":
      pool = all.filter((item) => item.name.toLowerCase().includes("veg"));
      break;
  }

  if (excludeCategoryKey) {
    const excludedIds = new Set(menu.categories.find((c) => c.key === excludeCategoryKey)?.items.map((i) => i.id) ?? []);
    pool = pool.filter((item) => !excludedIds.has(item.id));
  }

  if (categoryHint) {
    const scoped = pool.filter((item) => menu.categories.find((c) => c.key === categoryHint)?.items.some((i) => i.id === item.id));
    if (scoped.length > 0) pool = scoped;
  }

  return pool.slice(0, MAX_SUGGESTIONS);
}
