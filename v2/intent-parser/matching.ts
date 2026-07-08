// Deterministic menu-resolution engine for the V2 intent parser.
//
// Given free text, returns the menu item id(s) it could refer to — never a
// guess at "the one true item". The parser and safety layer decide what to
// do with 0 (unavailable), 1 (unambiguous), or 2+ (ambiguous) candidates.

import type { Menu, MenuCategory, MenuItem } from "../types/menu";

export function allMenuItems(menu: Menu): MenuItem[] {
  return menu.categories.flatMap((c) => c.items);
}

export function findCategoryForItemId(menu: Menu, itemId: string): MenuCategory | undefined {
  return menu.categories.find((c) => c.items.some((i) => i.id === itemId));
}

const GENERIC_STOPWORDS = new Set([
  "a", "an", "the", "of", "with", "and", "or",
]);

export function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !GENERIC_STOPWORDS.has(w));
}

// Digit+word bigrams that occur INSIDE menu item names ("6 inch", "9 inch",
// "12 inch", "6 pcs", "8 pcs") — the quantity segmenter must treat these
// digits as part of the item name, not as quantity markers, or exact names
// like "Pizza Small 6 inch" get split in half and become unresolvable
// (the root cause of the QA simulator's unorderable-by-exact-name bugs).
export function buildProtectedQtyPhrases(menu: Menu): Set<string> {
  const phrases = new Set<string>();
  for (const item of allMenuItems(menu)) {
    const tokens = item.name.toLowerCase().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (/^\d+$/.test(tokens[i])) phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  return phrases;
}

// All words that appear in an item name OR a category title — the
// vocabulary of "things that are actually on this menu". A token outside
// this set (e.g. "beef") means the customer is asking for something that
// doesn't exist, not just phrasing an existing item oddly.
export function buildMenuVocabulary(menu: Menu): Set<string> {
  const words = new Set<string>();
  for (const cat of menu.categories) {
    for (const w of significantTokens(cat.title)) words.add(w);
    for (const item of cat.items) {
      for (const w of significantTokens(item.name)) words.add(w);
    }
  }
  return words;
}

function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

// Simple English pluralization inverse — good enough for this menu's
// category titles (Burgers/Sandwiches/Pizza/Noodles/Rice/Starter/Steaks/
// Roll), not a general linguistic solver.
function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// Whole-string, singular/plural-tolerant category-title match — "burger"
// and "burgers" both match the "Burgers" category. Deliberately exact
// (whole normalized query, not a substring test): this is for a customer
// naming a CATEGORY directly ("burger", "burger menu"), not for resolving
// an item query, so it must never fire on a query that merely mentions a
// category word in passing.
export function findCategoryByName(query: string, menu: Menu): MenuCategory | undefined {
  const normalizedQuery = singularize(query.trim().toLowerCase());
  if (!normalizedQuery) return undefined;
  return menu.categories.find((c) => singularize(c.title.toLowerCase()) === normalizedQuery);
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function longestNameWinners(items: MenuItem[]): string[] {
  const maxLen = Math.max(...items.map((i) => i.name.length));
  return dedupe(items.filter((i) => i.name.length === maxLen).map((i) => i.id));
}

function scoreItems(tokens: string[], items: MenuItem[]): string[] {
  const scored = items
    .map((item) => {
      const nameTokens = significantTokens(item.name);
      const score = tokens.filter((t) =>
        nameTokens.some((nt) => nt === t || (t.length >= 3 && (nt.startsWith(t) || t.startsWith(nt))))
      ).length;
      return { item, score };
    })
    .filter((s) => s.score > 0);
  if (scored.length === 0) return [];
  const maxScore = Math.max(...scored.map((s) => s.score));
  return dedupe(scored.filter((s) => s.score === maxScore).map((s) => s.item.id));
}

// Resolves free text naming an item/category to candidate menu item ids.
//   0 ids  -> nothing on the menu matches (unavailable)
//   1 id   -> unambiguous
//   2+ ids -> ambiguous (bare category/family word, or a genuine tie)
export function resolveItemQuery(rawQuery: string, menu: Menu, vocabulary: Set<string>): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const compactQuery = compact(query);
  const items = allMenuItems(menu);

  // Exact match (spaced or compact) always wins outright.
  const exact = items.find((i) => {
    const name = i.name.toLowerCase();
    return name === query || compact(name) === compactQuery;
  });
  if (exact) return [exact.id];

  // A query that IS (whole-string, singular/plural-tolerant) a menu
  // category's own name always means "the whole category" — checked before
  // Step B's literal substring matching below, which can otherwise silently
  // return an INCOMPLETE subset when some category members' names don't
  // literally contain the category word (e.g. "White Singaporean" has no
  // "rice" in its name despite being a real Rice item; bare "rice" used to
  // resolve to only 4 of the 5 real Rice items via Step B, so a clarification
  // built from that missed the 5th item entirely — then a customer typing
  // its FULL exact name as the answer had nothing to scope-match against).
  // The SHOW/browse paths already got this exact fix via this same helper
  // (see parser.ts's bare-category-browse and show+leftover branches); this
  // closes the gap for every OTHER caller of resolveItemQuery, including the
  // plain ADD_ITEM fallback, instead of requiring each call site to special-
  // case it separately.
  const wholeCategory = findCategoryByName(query, menu);
  if (wholeCategory) return wholeCategory.items.map((i) => i.id);

  // Step A: the user typed something that fully contains one or more full
  // item names (e.g. "please give me zinger burger w/c meal") — the
  // *longest* contained name is the most specific/complete match.
  const stepA = items.filter((i) => {
    const name = i.name.toLowerCase();
    const cName = compact(name);
    return (name.length <= query.length && query.includes(name)) ||
           (cName.length <= compactQuery.length && compactQuery.includes(cName));
  });
  if (stepA.length > 0) {
    const winners = longestNameWinners(stepA);
    return winners;
  }

  // Step B: the query itself is short and appears inside one or more item
  // names (e.g. bare "zinger") — these are family/ambiguity candidates, not
  // a specificity signal, so no length tie-break here. Guarded to queries of
  // 3+ chars — anything shorter ("ok", "hi", "no") is too generic to trust
  // as a menu reference and would spuriously substring-match unrelated words
  // (e.g. "ok" inside "sm-OK-e Burger").
  const stepB = query.length >= 3 ? items.filter((i) => {
    const name = i.name.toLowerCase();
    const cName = compact(name);
    return (query.length <= name.length && name.includes(query)) ||
           (compactQuery.length <= cName.length && cName.includes(compactQuery));
  }) : [];
  if (stepB.length > 0) return dedupe(stepB.map((i) => i.id));

  // Beyond here nothing matched as a literal substring in either direction —
  // fall back to token-overlap scoring, gated by menu vocabulary so a
  // specific unavailable qualifier (e.g. "beef") rejects outright instead of
  // silently falling back to "any burger".
  const tokens = significantTokens(query);
  if (tokens.length === 0) return [];
  if (tokens.some((t) => !vocabulary.has(t))) return [];

  const category = menu.categories.find((c) => {
    const title = c.title.toLowerCase();
    return title.includes(query) || compact(title).includes(compactQuery) ||
      tokens.some((t) => title.includes(t));
  });

  if (category) {
    const scoped = scoreItems(tokens, category.items);
    if (scoped.length > 0) return scoped;
    // Anchor word only exists in the category TITLE (e.g. "roll" for
    // Wrap/Gyro, neither of which contains the word "roll") — the whole
    // category is the honest ambiguous answer.
    return category.items.map((i) => i.id);
  }

  const scored = scoreItems(tokens, items);
  return scored;
}

// Same resolution, but scoped to a fixed, explicit list of items — used to
// disambiguate a bare size/variant word ("small", "large") once another
// segment in the same message has already anchored the category (e.g.
// "alfredo" unambiguously anchors "pasta" in "2 small 2 large 1 alfredo"),
// or to resolve a clarification-answer reply strictly against the exact
// options a pending question offered (see
// order-state-engine/clarification.ts), never any item outside that list.
export function resolveItemQueryAmongItems(rawQuery: string, items: MenuItem[]): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const compactQuery = compact(query);

  const exact = items.find((i) => {
    const name = i.name.toLowerCase();
    return name === query || compact(name) === compactQuery;
  });
  if (exact) return [exact.id];

  // Same 3+ char guard as resolveItemQuery's Step B: a 1-2 character
  // fragment ("b", "ok") is too generic to trust as a name reference and
  // would spuriously substring-match unrelated names ("b" inside
  // "vegetaBle rice") — the QA simulator caught exactly that turning a
  // noise token into a real cart add via category anchoring.
  const contained = query.length >= 3 ? items.filter((i) => {
    const name = i.name.toLowerCase();
    const cName = compact(name);
    return name.includes(query) || compactQuery.length > 0 && cName.includes(compactQuery);
  }) : [];
  if (contained.length > 0) return dedupe(contained.map((i) => i.id));

  const tokens = significantTokens(query);
  return scoreItems(tokens, items);
}

// Thin wrapper over resolveItemQueryAmongItems for the common case of
// scoping to a whole MenuCategory's items.
export function resolveItemQueryWithinCategory(rawQuery: string, category: MenuCategory): string[] {
  return resolveItemQueryAmongItems(rawQuery, category.items);
}
