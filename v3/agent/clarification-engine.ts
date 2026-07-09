// V3 Phase 2 — Clarification Engine.
//
// See v3/agent/rules.ts's CLARIFICATION_RULES — this file is that rule
// set's actual enforcement point (pending answers resolve only the pending
// queue, queued actions are single-use, the queue clears after resolution).
//
// Owns every "is this message answering a pending question?" decision for
// V3, for BOTH directions:
//   - ADD clarifications (V2's own AWAITING_CLARIFICATION queue, e.g. "which
//     pasta?") — resolvePendingAdd(), moved here verbatim from actions.ts
//     (Phase 1 code, unchanged behavior — see tests D1-D3/C2).
//   - REMOVE clarifications (NEW, requirement #8, e.g. "burger hata do" with
//     two different burgers in the cart) — a V3-only concept
//     (conversation-memory.ts#PendingRemovalContext) deliberately NOT
//     stored in V2's OrderContext, since V2's own queue always means "the
//     next resolved item gets ADDED" — reusing it for a removal would be
//     wrong. Kept in the SAME file as the ADD side because both are
//     "strictly resolve within a locked set of options, never the whole
//     menu" — one rule, two directions.
//
// Requirement #2's "lock": in both directions, a follow-up reply is
// resolved ONLY against the exact option set the pending question offered
// (v2/intent-parser/matching.ts#resolveItemQueryAmongItems), never a
// menu-wide search — this is what makes "mexican" answer "which Pasta?"
// with Mexican Pasta and never Mexican Sandwich.

import type { Menu, MenuItem } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { OrderContext, PendingClarificationContext } from "../../v2/types/order";
import { touch } from "../../v2/order-state-engine/context";
import { getClarificationQueue, withClarificationQueue } from "../../v2/order-state-engine/clarification";
import { findCategoryForItemId, buildMenuVocabulary, resolveItemQuery, resolveItemQueryAmongItems } from "../../v2/intent-parser/matching";
import { addItem } from "../../v2/cart-engine";
import { findMenuItem } from "../../v2/cart-engine/validate";
import type { ItemMention } from "./schema";
import type { PendingRemovalContext } from "./conversation-memory";
import type { TurnFacts } from "./actions";
import { normalizeQueryText } from "./reference-resolver";

// ─── ADD side (V2's own clarification queue) ────────────────────────────────

// A single item mention while a clarification is pending is almost always
// the customer answering it — resolved STRICTLY against pending.options
// (never the whole menu, never any other category), mirroring
// v2/order-state-engine/clarification.ts#resolveClarificationReply.
export function resolvePendingAdd(
  context: OrderContext,
  pending: PendingClarificationContext,
  mention: ItemMention,
  menu: Menu
): { context: OrderContext; facts: Partial<TurnFacts> } | null {
  const normalizedQuery = normalizeQueryText(mention.query);
  const scoped = resolveItemQueryAmongItems(normalizedQuery, pending.options);
  const queue = getClarificationQueue(context);
  const remaining = queue.slice(1);

  if (scoped.length === 0) {
    return {
      context,
      facts: { clarificationRejected: { category: pending.category, options: pending.options } },
    };
  }
  if (scoped.length > 1) {
    return { context, facts: { clarificationStillAmbiguous: { category: pending.category, options: pending.options } } };
  }

  const chosenId = scoped[0];
  const chosen = findMenuItem(menu, chosenId);
  const quantity = mention.quantity ?? pending.quantity;
  const result = addItem(context.cart, chosenId, menu, quantity);
  if (!result.ok) return { context, facts: {} };

  // context.state is always "AWAITING_CLARIFICATION" here (the only state a
  // non-empty queue is ever paired with — see runFreshAdd), so
  // nextStateAfterCartMutation's generic rules would just return it
  // unchanged (a real, previously-untested bug: the state got permanently
  // stuck on AWAITING_CLARIFICATION even after the LAST queued question was
  // answered). Once the queue is fully drained, the customer is simply back
  // to editing their cart.
  const nextState = remaining.length > 0 ? "AWAITING_CLARIFICATION" : "CART_EDITING";
  const patched = touch(context, {
    state: nextState,
    cart: result.cart,
    ...withClarificationQueue(remaining),
    orderReviewShown: context.orderReviewShown,
  });

  // Gemini drafted its reply BEFORE this category-scoped resolution ran, so
  // it may have named any of the query's OTHER menu-wide candidates (e.g.
  // "mexican" also matches Mexican Sandwich/Mexican Pizza, not just the
  // Pasta sibling actually chosen) — not just the other options THIS
  // question happened to list. Compute rejects from the query's real
  // menu-wide resolution, never from the pending category's siblings.
  const vocabulary = buildMenuVocabulary(menu);
  const globalCandidates = resolveItemQuery(normalizedQuery, menu, vocabulary);
  const rejectedIds = new Set([...globalCandidates, ...pending.options.map((o) => o.id)].filter((id) => id !== chosenId));
  const rejectedNames = [...rejectedIds].map((id) => findMenuItem(menu, id)?.name).filter((n): n is string => Boolean(n));
  return {
    context: patched,
    facts: {
      resolvedAmbiguities: chosen ? [{ chosenName: chosen.name, rejectedNames }] : [],
    },
  };
}

// ─── Multi-mention queue resolution (queue-lifecycle bug fix) ──────────────
//
// A pending clarification queue can hold MULTIPLE questions at once (e.g.
// "5 pasta ek chowmein" queues a pasta ambiguity AND a chowmein ambiguity
// in the same turn). The customer's answer to a multi-question queue is
// often ALSO multi-item in one message ("do small ek mexican ek macaroni
// ek vegetable" — 3 mentions answer the pasta question, 1 answers the
// chowmein question). resolvePendingAdd above only ever handles EXACTLY
// one mention, so a multi-mention reply used to skip queue resolution
// entirely and fall through to a brand-new, independent add (runFreshAdd)
// — landing the right items in the cart by coincidence, but leaving the
// ORIGINAL queue entries completely untouched even though the customer had
// just answered them. That stale, never-cleared queue is the root cause of
// a real production bug: a LATER turn (even a bare "ok") could still see a
// non-empty clarificationQueue and re-draft the exact same add, duplicating
// every item.
//
// Resolves EVERY mention against whichever queue entry's OWN option list
// it matches (never the whole menu — same "lock" rule as the single-mention
// path) and removes EVERY queue entry that got at least one mention
// resolved against it. A mention matching no queue entry at all is
// dropped — never silently added as an unrelated item, and never queued as
// a brand-new ambiguity: a clarification answer must ONLY resolve the
// pending queue, never create an independent add plan. Returns null (let
// the caller fall through to a genuinely fresh add) only when NOT ONE
// mention matched anything currently in the queue.
export function resolvePendingAddMulti(
  context: OrderContext,
  queue: PendingClarificationContext[],
  mentions: ItemMention[],
  menu: Menu
): { context: OrderContext; facts: Partial<TurnFacts> } | null {
  const consumed = new Set<number>();
  const toAdd: { itemId: string; quantity: number }[] = [];
  const resolvedAmbiguities: { chosenName: string; rejectedNames: string[] }[] = [];

  for (const mention of mentions) {
    const normalizedQuery = normalizeQueryText(mention.query);
    for (let i = 0; i < queue.length; i++) {
      const scoped = resolveItemQueryAmongItems(normalizedQuery, queue[i].options);
      if (scoped.length !== 1) continue;
      const chosenId = scoped[0];
      const chosen = findMenuItem(menu, chosenId);
      const quantity = mention.quantity ?? queue[i].quantity;
      toAdd.push({ itemId: chosenId, quantity });
      consumed.add(i);
      if (chosen) {
        const rejectedNames = queue[i].options.map((o) => o.name).filter((n) => n !== chosen.name);
        resolvedAmbiguities.push({ chosenName: chosen.name, rejectedNames });
      }
      break;
    }
  }

  if (toAdd.length === 0) return null;

  let cart = context.cart;
  for (const { itemId, quantity } of toAdd) {
    const result = addItem(cart, itemId, menu, quantity);
    if (result.ok) cart = result.cart;
  }

  const remaining = queue.filter((_, i) => !consumed.has(i));
  const nextState = remaining.length > 0 ? "AWAITING_CLARIFICATION" : "CART_EDITING";
  const patched = touch(context, {
    state: nextState,
    cart,
    ...withClarificationQueue(remaining),
    orderReviewShown: context.orderReviewShown,
  });

  return { context: patched, facts: { resolvedAmbiguities } };
}

// ─── REMOVE side (V3-only, requirement #8) ──────────────────────────────────

// "burger hata do" with 2+ DIFFERENT burger items in the cart resolves to
// 2+ candidateIds — rather than silently no-op (the Phase-1 behavior),
// this builds a locked option set (real cart items only) for the customer
// to choose from next turn.
export function buildPendingRemoval(candidateIds: string[], menu: Menu, query: string): PendingRemovalContext {
  const options = candidateIds.map((id) => findMenuItem(menu, id)).filter((i): i is MenuItem => Boolean(i));
  const category = findCategoryForItemId(menu, candidateIds[0])?.key ?? query;
  return { category, options };
}

export type PendingRemovalOutcome = { itemId: string } | { ambiguous: true } | { notFound: true };

// Same "lock" rule as the ADD side: the reply is checked ONLY against the
// options this specific removal question offered.
export function resolvePendingRemoval(pending: PendingRemovalContext, query: string): PendingRemovalOutcome {
  const matches = resolveItemQueryAmongItems(normalizeQueryText(query), pending.options);
  if (matches.length === 0) return { notFound: true };
  if (matches.length > 1) return { ambiguous: true };
  return { itemId: matches[0] };
}

export function isInCart(cart: CartState, itemId: string): boolean {
  return cart.items.some((line) => line.itemId === itemId);
}
