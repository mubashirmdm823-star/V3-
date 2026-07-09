// V3 Phase 2 — Conversation Memory.
//
// Everything V3 needs to remember ACROSS turns that V2's OrderContext
// doesn't already track for it (cart/checkout state, the ADD-oriented
// clarification queue, and delivery/name/address are already OrderContext's
// job — see v2/types/order.ts). This module only tracks the extra,
// V3-specific conversational facts: what was last talked about, what the
// customer prefers, and V3's own (V2-untouched) ambiguous-REMOVAL
// clarification. Pure data + pure update functions only — no LLM calls, no
// menu-resolution logic of its own (reference-resolver.ts owns that).
//
// Deliberately kept OUT of v2/types/order.ts: adding a "what does this
// customer generally like" concept to V2's shared OrderContext would affect
// V1/V2 callers that have no use for it. Living entirely inside v3/agent/
// keeps this additive and V1/V2-invisible.

import type { Menu, MenuItem } from "../../v2/types/menu";
import { allMenuItems, findCategoryForItemId, buildMenuVocabulary, resolveItemQuery, significantTokens } from "../../v2/intent-parser/matching";
import { findMenuItem } from "../../v2/cart-engine/validate";
import type { TurnFacts } from "./actions";
import type { AgentTurnPlan } from "./schema";
import { ACKNOWLEDGEMENT_MESSAGES } from "./rules";

export interface ConversationPreferences {
  spiceLevel?: "spicy" | "mild";
  favoriteCategory?: string;
  deliveryPreference?: "delivery" | "pickup";
}

// A removal request that named 2+ items currently in the cart (e.g. "burger
// hata do" with two different burgers in the cart) — asked about, but not
// yet resolved. Deliberately NOT stored in V2's OrderContext.clarificationQueue:
// that queue's resolution path (clarification-engine.ts's pending-ADD
// resolver) always ADDS the resolved item, which would be wrong for a
// pending REMOVAL. Keeping this as its own V3-only field means V2's
// clarification logic never has to know "add" vs "remove" exists.
export interface PendingRemovalContext {
  category: string;
  options: MenuItem[];
}

export interface ConversationMemory {
  lastMentionedItemName?: string;
  lastMentionedCategory?: string;
  lastIntent?: string;
  lastRecommendation: string[];
  lastRejectedQuery?: string;
  pendingRemoval: PendingRemovalContext | null;
  preferences: ConversationPreferences;
  // Phase 3C, requirement #5: has the customer already been sent the
  // one-time "your order is in for verification" acknowledgment since
  // reaching PENDING_VERIFICATION? First "okay"/"thanks" gets the full
  // message; every one after gets the short "already in verification"
  // reply — this is what makes that distinction possible across turns.
  postOrderThanked: boolean;
}

export function createEmptyMemory(): ConversationMemory {
  return { lastRecommendation: [], pendingRemoval: null, preferences: {}, postOrderThanked: false };
}

// ─── Bare acknowledgment detection (queue-lifecycle bug fix, rules 3/4) ────
//
// A pure acknowledgment ("ok"/"thanks"/"theek hai"/...) must NEVER mutate
// the cart, even if the model — confused by a stale clarification queue
// still showing "pending" in its own context, or simply trying to be
// helpful — drafts a cartAction for it. This is a deterministic backstop
// independent of the queue-lifecycle fix in clarification-engine.ts/
// actions.ts: even once that fix stops the model from having a REASON to
// redraft an add, this guarantees it structurally, matching the exact
// wording the customer would need to type for this to matter — an EXACT,
// case-insensitive match to the WHOLE trimmed message, never a substring,
// so a longer, genuinely new instruction that merely CONTAINS one of these
// words ("haan ye wala add kar do", "haan confirm") is never affected.
// Base list is v3/agent/rules.ts's canonical ACKNOWLEDGEMENT_MESSAGES; the
// extra entries here (k, kk, achha, thik hai, theek, shukriya, shukriya!,
// haan, continue) are additional synonyms this guard already recognised —
// kept as a strict superset so behaviour is unchanged.
const BARE_ACKNOWLEDGMENT_WORDS: ReadonlySet<string> = new Set([
  ...ACKNOWLEDGEMENT_MESSAGES.map((w) => w.toLowerCase()),
  "k", "kk", "achha", "thik hai", "theek",
  "shukriya", "shukriya!", "haan", "continue",
]);

export function isBareAcknowledgment(message: string): boolean {
  return BARE_ACKNOWLEDGMENT_WORDS.has(message.trim().toLowerCase());
}

function findMenuItemByName(menu: Menu, name: string): MenuItem | undefined {
  const target = name.trim().toLowerCase();
  return allMenuItems(menu).find((item) => item.name.toLowerCase() === target);
}

// ─── Preference detection ───────────────────────────────────────────────────
//
// A documented, fixed vocabulary — exactly the preference axes requirement
// #1 asks for (spicy/mild/burger/pasta/delivery/pickup). This is customer
// self-disclosure tracking (remembering what THEY said they like), not a
// routing/classification hack — it never decides what the reply says, only
// what gets remembered for a LATER turn's reference resolution
// ("spicy wala" -> spiceLevel) or recommendation theme default.
const SPICY_WORDS = /\b(spicy|tikha|masaledar|hot)\b/i;
const MILD_WORDS = /\b(mild|halka|bland|less\s*spicy|kam\s*tikha)\b/i;
const DELIVERY_WORDS = /\b(delivery|ghar\s*pe|home\s*delivery)\b/i;
const PICKUP_WORDS = /\b(pickup|pick\s*up|takeaway|le\s*jaunga|le\s*jaungi)\b/i;
const CATEGORY_WORDS: { pattern: RegExp; category: string }[] = [
  { pattern: /\bburger\b/i, category: "burgers" },
  { pattern: /\bpasta\b/i, category: "pasta" },
  { pattern: /\bpizza\b/i, category: "pizza" },
  { pattern: /\bsandwich\b/i, category: "sandwiches" },
  { pattern: /\bchowmein|noodles?\b/i, category: "noodles" },
];

export function detectPreferences(message: string, existing: ConversationPreferences): ConversationPreferences {
  const next: ConversationPreferences = { ...existing };
  if (SPICY_WORDS.test(message)) next.spiceLevel = "spicy";
  else if (MILD_WORDS.test(message)) next.spiceLevel = "mild";

  if (DELIVERY_WORDS.test(message)) next.deliveryPreference = "delivery";
  else if (PICKUP_WORDS.test(message)) next.deliveryPreference = "pickup";

  for (const { pattern, category } of CATEGORY_WORDS) {
    if (pattern.test(message)) {
      next.favoriteCategory = category;
      break;
    }
  }
  return next;
}

// ─── Last-mention tracking ──────────────────────────────────────────────────
//
// Priority mirrors "what would a human assume 'it' refers to": the item
// just replaced-in or added is the freshest thing discussed; a bare
// quantity change re-affirms (but doesn't replace) whatever was already the
// topic. A pure recommendation (nothing added, per the Phase 3 "Suggest !=
// Add" rule) still becomes the new topic — so a FOLLOW-UP message
// ("haan ye add kar do") can resolve "ye" via reference-resolver.ts's
// existing last-item-reference handling, without adding a second,
// duplicate resolution path. Falls back to the previous turn's value when
// NOTHING changed this turn (a pure conversational message must never
// blank out "the topic").
// Production Stabilization Mode fix: a pure availability/Q&A turn ("alfredo
// hota hai aapke pass") that names one specific, unambiguous real menu item
// but mutates nothing (no add/replace/quantity-change — nothing for the
// facts-based checks above to catch) used to leave lastMentionedItemName
// completely unset. A later short confirmation ("g"/"haan") answering that
// same question then had no conversational context to fall back on, so
// actions.ts#widenUngroundedFamilyGuess treated the model's own (correct)
// item inference as an ungrounded guess and wrongly re-asked "kaunsa Pasta
// chahenge?" — discarding real context the customer had already
// established. Reuses the exact same deterministic resolution primitive
// used everywhere else (resolveItemQuery) — only ever fires when the
// CUSTOMER's own message resolves to EXACTLY ONE real menu item on its
// own merits, so a vague/ambiguous mention ("chowmein hota hai kya",
// "burger accha hai") never sets a specific item.
function findUnambiguousMenuItemInMessage(customerMessage: string, menu: Menu): string | undefined {
  const vocabulary = buildMenuVocabulary(menu);
  const matchedNames = new Set<string>();
  for (const token of significantTokens(customerMessage)) {
    const candidates = resolveItemQuery(token, menu, vocabulary);
    if (candidates.length !== 1) continue;
    const name = findMenuItem(menu, candidates[0])?.name;
    if (name) matchedNames.add(name);
  }
  return matchedNames.size === 1 ? [...matchedNames][0] : undefined;
}

function deriveLastMentionName(
  facts: TurnFacts | null,
  recommendedName: string | undefined,
  customerMessage: string,
  menu: Menu,
  previous: string | undefined
): string | undefined {
  if (!facts) return recommendedName ?? previous;
  if (facts.replacedNames.length > 0) return facts.replacedNames[facts.replacedNames.length - 1].toName;
  if (facts.addedLines.length > 0) return facts.addedLines[facts.addedLines.length - 1].name;
  if (facts.changedQuantity.length > 0) return facts.changedQuantity[facts.changedQuantity.length - 1].name;
  if (recommendedName) return recommendedName;
  return findUnambiguousMenuItemInMessage(customerMessage, menu) ?? previous;
}

function deriveLastIntent(facts: TurnFacts | null, plan: AgentTurnPlan | null): string | undefined {
  if (facts) {
    if (facts.clearedCart) return "clear";
    if (facts.replacedNames.length > 0) return "replace";
    if (facts.removedNames.length > 0) return "remove";
    if (facts.addedLines.length > 0) return "add";
    if (facts.changedQuantity.length > 0) return "change_quantity";
    if (facts.checkoutApplied) return "checkout";
  }
  if (plan?.recommendationRequest) return "recommend";
  return facts ? undefined : "conversation";
}

export interface UpdateMemoryParams {
  memory: ConversationMemory;
  customerMessage: string;
  plan: AgentTurnPlan | null;
  facts: TurnFacts | null;
  menu: Menu;
  // Real item ids recommendation-engine.ts actually suggested this turn, if
  // any — kept separate from `facts` since a recommendation never mutates
  // the cart.
  recommendedItemIds?: string[];
  // Set by clarification-engine.ts when this turn queued (or resolved) a
  // V3-only ambiguous-removal question. `undefined` means "unchanged this
  // turn" (keep whatever was already pending); pass `null` explicitly to
  // clear it.
  pendingRemoval?: PendingRemovalContext | null;
  // Set true by index.ts once the one-time post-order acknowledgment has
  // been sent (see fact-verifier.ts#renderPostOrderAckReply). Never reset
  // back to false — once thanked, always thanked for the rest of this
  // conversation.
  postOrderThanked?: boolean;
}

export function updateMemoryAfterTurn(params: UpdateMemoryParams): ConversationMemory {
  const { memory, customerMessage, plan, facts, menu } = params;

  const recommendedName = params.recommendedItemIds?.[0] ? findMenuItem(menu, params.recommendedItemIds[0])?.name : undefined;
  const lastMentionedItemName = deriveLastMentionName(facts, recommendedName, customerMessage, menu, memory.lastMentionedItemName);
  const resolvedItem = lastMentionedItemName ? findMenuItemByName(menu, lastMentionedItemName) : undefined;
  const lastMentionedCategory = resolvedItem ? findCategoryForItemId(menu, resolvedItem.id)?.key ?? memory.lastMentionedCategory : memory.lastMentionedCategory;

  return {
    lastMentionedItemName,
    lastMentionedCategory,
    lastIntent: deriveLastIntent(facts, plan) ?? memory.lastIntent,
    lastRecommendation: params.recommendedItemIds ?? (facts && (facts.addedLines.length > 0 || facts.removedNames.length > 0) ? [] : memory.lastRecommendation),
    lastRejectedQuery: facts && facts.unavailableQueries.length > 0 ? facts.unavailableQueries[facts.unavailableQueries.length - 1] : memory.lastRejectedQuery,
    pendingRemoval: params.pendingRemoval !== undefined ? params.pendingRemoval : memory.pendingRemoval,
    preferences: detectPreferences(customerMessage, memory.preferences),
    postOrderThanked: params.postOrderThanked ?? memory.postOrderThanked ?? false,
  };
}
