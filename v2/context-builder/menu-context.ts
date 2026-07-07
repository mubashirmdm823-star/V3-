// V2 phase 9 — Relevant Menu Builder.
//
// Never hands the whole menu.json to the (future) LLM. Builds a lexically
// relevant subset of categories from the raw customer message, reusing the
// intent parser's own tokenizer (v2/intent-parser/matching.ts) rather than
// inventing a second copy — this is deliberately NOT intent classification:
// it only decides which menu categories are worth including as context, the
// same way a search index narrows results. The actual item resolution still
// belongs entirely to the intent parser.

import type { Menu, MenuCategory } from "../types/menu";
import { significantTokens, allMenuItems } from "../intent-parser/matching";
import { SHOW_WORDS } from "../intent-parser/safety";

export interface MenuContextResult {
  categories: MenuCategory[];
  matchedCategoryKeys: string[];
  isFullMenu: boolean;
  restaurantOnly: boolean;
}

// Very small, deliberate plural tolerance ("burgers" <-> "burger",
// "sandwiches" <-> "sandwich") — NOT a stemmer, just enough to match this
// menu's category titles against singular/plural customer phrasing.
function normalizeToken(token: string): string {
  if ((token.endsWith("ches") || token.endsWith("shes") || token.endsWith("xes")) && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizedTokenSet(text: string): Set<string> {
  return new Set(significantTokens(text).map(normalizeToken));
}

const RESTAURANT_INFO_PHRASES = [
  "address kya hai", "aapka address", "restaurant kahan", "kahan hai", "restaurant address",
  "timing kya", "kya time", "opening time", "closing time",
  "phone number", "contact number", "aapka number", "phone kya",
  "delivery charges", "delivery fee", "delivery time", "kitne mein deliver",
];

export function isRestaurantInfoQuery(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return RESTAURANT_INFO_PHRASES.some((p) => normalized.includes(p));
}

function containsShowWord(messageTokens: Set<string>): boolean {
  return SHOW_WORDS.some((w) => messageTokens.has(normalizeToken(w)));
}

function categoryTitleTokens(category: MenuCategory): Set<string> {
  return normalizedTokenSet(category.title);
}

function categoryItemTokens(category: MenuCategory): Set<string> {
  const tokens = new Set<string>();
  for (const item of category.items) {
    for (const t of normalizedTokenSet(item.name)) tokens.add(t);
  }
  return tokens;
}

function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  if (subset.size === 0) return false;
  for (const t of subset) if (!superset.has(t)) return false;
  return true;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

function findCategoryByLabel(menu: Menu, label: string | undefined): MenuCategory | undefined {
  if (!label) return undefined;
  const normalized = label.trim().toLowerCase();
  return menu.categories.find(
    (c) => c.title.trim().toLowerCase() === normalized || c.key.trim().toLowerCase() === normalized
  );
}

export interface MenuContextOptions {
  // Used to disambiguate a message whose tokens genuinely overlap several
  // categories (e.g. "large" appears in Pizza/Pasta/Toppings items) by
  // preferring whichever category the conversation was already about.
  currentTopic?: string;
  lastMentionedCategory?: string;
}

export function buildRelevantMenu(menu: Menu, message: string, options: MenuContextOptions = {}): MenuContextResult {
  const messageTokens = normalizedTokenSet(message);

  const wholeTitleMatches = menu.categories.filter((c) => isSubsetOf(categoryTitleTokens(c), messageTokens));
  if (wholeTitleMatches.length > 0) {
    return {
      categories: wholeTitleMatches,
      matchedCategoryKeys: wholeTitleMatches.map((c) => c.key),
      isFullMenu: false,
      restaurantOnly: false,
    };
  }

  const itemOverlapMatches = menu.categories.filter((c) => overlaps(categoryItemTokens(c), messageTokens));

  if (itemOverlapMatches.length === 1) {
    return {
      categories: itemOverlapMatches,
      matchedCategoryKeys: itemOverlapMatches.map((c) => c.key),
      isFullMenu: false,
      restaurantOnly: false,
    };
  }

  if (itemOverlapMatches.length > 1) {
    const topicCategory =
      findCategoryByLabel(menu, options.currentTopic) ?? findCategoryByLabel(menu, options.lastMentionedCategory);
    const topicIsAmongMatches = topicCategory && itemOverlapMatches.some((c) => c.key === topicCategory.key);
    const resolved = topicIsAmongMatches ? [topicCategory!] : itemOverlapMatches;
    return {
      categories: resolved,
      matchedCategoryKeys: resolved.map((c) => c.key),
      isFullMenu: false,
      restaurantOnly: false,
    };
  }

  // No category or item vocabulary touched at all.
  if (isRestaurantInfoQuery(message)) {
    return { categories: [], matchedCategoryKeys: [], isFullMenu: false, restaurantOnly: true };
  }

  if (containsShowWord(messageTokens)) {
    return {
      categories: menu.categories,
      matchedCategoryKeys: menu.categories.map((c) => c.key),
      isFullMenu: true,
      restaurantOnly: false,
    };
  }

  const topicCategory =
    findCategoryByLabel(menu, options.currentTopic) ?? findCategoryByLabel(menu, options.lastMentionedCategory);
  if (topicCategory) {
    return {
      categories: [topicCategory],
      matchedCategoryKeys: [topicCategory.key],
      isFullMenu: false,
      restaurantOnly: false,
    };
  }

  return { categories: [], matchedCategoryKeys: [], isFullMenu: false, restaurantOnly: false };
}

export { allMenuItems };
