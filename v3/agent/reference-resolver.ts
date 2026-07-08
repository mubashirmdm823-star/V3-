// V3 Phase 2 — Reference Resolver.
//
// Resolves anaphoric follow-up phrases ("wo wala", "isko", "dusra", "ek
// aur", "large kar do", "spicy wala", ...) against CONVERSATION MEMORY
// (conversation-memory.ts) instead of the global menu — exactly
// requirement #5's rule. The model is instructed (prompt.ts) to pass these
// phrases through verbatim as the action's query text rather than guessing
// an item name itself; actions.ts calls this resolver as a fallback ONLY
// when the normal deterministic menu-text resolution (v2/intent-parser/
// matching.ts) finds nothing, so a real menu-item query is never
// second-guessed or overridden by this module.

import type { Menu } from "../../v2/types/menu";
import { findCategoryForItemId, resolveItemQuery } from "../../v2/intent-parser/matching";
import type { ConversationMemory } from "./conversation-memory";
import { isSpicyItem } from "./recommendation-engine";

export type ReferenceResolution =
  // Substitute the query with this real item name, then re-run the normal
  // resolution pipeline on it (so every existing guarantee — "never invent
  // an item" — still applies to the substituted name too).
  | { kind: "item"; itemName: string }
  // "large kar do" etc: replace the last-mentioned item with a same-category
  // sibling matching the requested size.
  | { kind: "size_replace"; fromName: string; toName: string }
  | { kind: "none" };

const LAST_ITEM_REFERENCE = /\b(wo\s*wala|wohi|same\s*wala|isko|ise|iska|ye\s*wala|yehi|dusra(?:\s*wala)?|is\s*item\s*ko|ye\s*item)\b/i;
const ONE_MORE_REFERENCE = /\b(ek\s*aur|aur\s*ek|one\s*more)\b/i;
const SPICY_REFERENCE = /\bspicy\s*wala\b/i;

const SIZE_WORD_TO_CANONICAL: Record<string, string> = {
  large: "large",
  bara: "large",
  jumbo: "jumbo",
  medium: "medium",
  small: "small",
  chota: "small",
};
const SIZE_REFERENCE = /\b(large|bara|jumbo|medium|small|chota)\s*kar\s*(?:do|dain|dein)\b/i;

export function isKnownReferencePhrase(query: string): boolean {
  return LAST_ITEM_REFERENCE.test(query) || ONE_MORE_REFERENCE.test(query) || SPICY_REFERENCE.test(query) || SIZE_REFERENCE.test(query);
}

// Live-acceptance-testing bug (Phase 4): the model occasionally passes a
// raw, item-id-shaped query ("zinger-burger") instead of natural words
// ("zinger burger") — v2/intent-parser/matching.ts's `compact()` only
// strips WHITESPACE, never hyphens/underscores, so a hyphenated query
// misses both the exact-match and substring-match tiers entirely and falls
// through to token-scoring, which can resolve ambiguously (2+ candidates)
// instead of uniquely, even for an otherwise-exact item name. Normalizing
// hyphens/underscores to spaces before ANY query ever reaches V2's
// matching functions fixes this without touching that shared, heavily-
// tested utility itself.
export function normalizeQueryText(query: string): string {
  return query.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function resolveSizeReplace(query: string, memory: ConversationMemory, menu: Menu): ReferenceResolution {
  const match = query.match(SIZE_REFERENCE);
  if (!match || !memory.lastMentionedItemName) return { kind: "none" };
  const canonical = SIZE_WORD_TO_CANONICAL[match[1].toLowerCase()];
  if (!canonical) return { kind: "none" };

  const currentItem = menu.categories.flatMap((c) => c.items).find((i) => i.name.toLowerCase() === memory.lastMentionedItemName!.toLowerCase());
  if (!currentItem) return { kind: "none" };
  const category = findCategoryForItemId(menu, currentItem.id);
  if (!category) return { kind: "none" };

  const sibling = category.items.find((i) => i.id !== currentItem.id && i.name.toLowerCase().includes(canonical));
  if (!sibling) return { kind: "none" };

  return { kind: "size_replace", fromName: currentItem.name, toName: sibling.name };
}

function resolveSpicyWala(memory: ConversationMemory, menu: Menu): ReferenceResolution {
  const scoped = memory.lastMentionedCategory ? menu.categories.find((c) => c.key === memory.lastMentionedCategory) : undefined;
  const pool = scoped ? scoped.items : menu.categories.flatMap((c) => c.items);
  const spicy = pool.find(isSpicyItem);
  return spicy ? { kind: "item", itemName: spicy.name } : { kind: "none" };
}

// Only called when normal menu-text resolution already found nothing for
// `query` — never overrides a real, resolvable menu-item mention.
export function resolveReference(query: string, memory: ConversationMemory, menu: Menu): ReferenceResolution {
  const trimmed = query.trim();

  if (SIZE_REFERENCE.test(trimmed)) return resolveSizeReplace(trimmed, memory, menu);
  if (SPICY_REFERENCE.test(trimmed)) return resolveSpicyWala(memory, menu);
  if ((LAST_ITEM_REFERENCE.test(trimmed) || ONE_MORE_REFERENCE.test(trimmed)) && memory.lastMentionedItemName) {
    return { kind: "item", itemName: memory.lastMentionedItemName };
  }
  return { kind: "none" };
}

// The one call site every action handler (actions.ts) uses to resolve a
// query — tries the normal, deterministic menu-text match FIRST and only
// consults conversation memory when that comes up completely empty AND the
// text is a recognized reference phrase. A real menu-item mention is never
// second-guessed or overridden by this fallback.
export function resolveWithReferenceFallback(query: string, menu: Menu, vocabulary: Set<string>, memory: ConversationMemory): string[] {
  const normalized = normalizeQueryText(query);
  const direct = resolveItemQuery(normalized, menu, vocabulary);
  if (direct.length > 0 || !isKnownReferencePhrase(normalized)) return direct;

  const ref = resolveReference(normalized, memory, menu);
  return ref.kind === "item" ? resolveItemQuery(ref.itemName, menu, vocabulary) : direct;
}
