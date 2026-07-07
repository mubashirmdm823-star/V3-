// The log store + entry builder + cross-entry cart analytics.
//
// buildLogEntry() is pure — given the already-computed inputs (ParseResult,
// before/after OrderContext, timing), it derives a MessageLogEntry and
// nothing else; it never calls into the parser/cart-engine/order-state-
// engine itself. Logger is the one place in this layer that's intentionally
// stateful (an accumulating recorder is what a logger IS), but it never
// feeds anything back into the pipeline it observes.

import type { CartLineItem, CartState } from "../types/cart";
import type { OrderContext } from "../types/order";
import type { ParseResult } from "../types/parser";
import type { Menu } from "../types/menu";
import { findMenuItem } from "../cart-engine/validate";
import { calculateTotal } from "../cart-engine/totals";
import {
  detectLanguage,
  type MessageLogEntry,
  type ItemReplacedLog,
  type QuantityChangeLog,
} from "./events";
import type { PerformanceMetrics } from "./performance";
import { buildReasoningSummary } from "./debug";

function diffCarts(before: CartState, after: CartState) {
  const beforeMap = new Map(before.items.map((line) => [line.itemId, line]));
  const afterMap = new Map(after.items.map((line) => [line.itemId, line]));

  const itemsAdded: CartLineItem[] = after.items.filter((line) => !beforeMap.has(line.itemId));
  const itemsRemoved: CartLineItem[] = before.items.filter((line) => !afterMap.has(line.itemId));
  const quantityChanges: QuantityChangeLog[] = after.items
    .filter((line) => {
      const prior = beforeMap.get(line.itemId);
      return prior !== undefined && prior.qty !== line.qty;
    })
    .map((line) => ({ itemId: line.itemId, before: beforeMap.get(line.itemId)!.qty, after: line.qty }));

  return { itemsAdded, itemsRemoved, quantityChanges };
}

function classifyItems(parseResult: ParseResult, menu: Menu) {
  const matched: string[] = [];
  const matchedItemDetails: { query: string; matchedName: string }[] = [];
  const rejected: string[] = [];
  const ambiguous: string[] = [];

  for (const ref of parseResult.items) {
    const count = ref.candidateItemIds?.length ?? 0;
    if (count === 1) {
      const item = findMenuItem(menu, ref.candidateItemIds![0]);
      const matchedName = item?.name ?? ref.candidateItemIds![0];
      matched.push(matchedName);
      matchedItemDetails.push({ query: ref.query, matchedName });
    } else if (count === 0) {
      rejected.push(ref.query);
    } else {
      ambiguous.push(ref.query);
    }
  }

  return { matched, matchedItemDetails, rejected, ambiguous };
}

// Mirrors the cart-filtering the safety layer and cart engine already apply
// to a replace source (v2/cart-engine/index.ts) — a source query can be
// menu-wide ambiguous (e.g. bare "zinger" matches 3 burger items) while
// still being the single unambiguous item actually sitting in the cart.
function extractReplacements(parseResult: ParseResult, cartBefore: CartState, menu: Menu): ItemReplacedLog[] {
  const replacements: ItemReplacedLog[] = [];
  for (const action of parseResult.actions) {
    if (action.action !== "REPLACE_ITEM" || !action.replace) continue;
    const sourceIdsInCart = (action.replace.sourceCandidateItemIds ?? []).filter((id) =>
      cartBefore.items.some((line) => line.itemId === id)
    );
    const targetIds = action.replace.targetCandidateItemIds ?? [];
    const from = sourceIdsInCart.length === 1
      ? findMenuItem(menu, sourceIdsInCart[0])?.name ?? action.replace.sourceQuery
      : action.replace.sourceQuery;
    const to = targetIds.length === 1
      ? findMenuItem(menu, targetIds[0])?.name ?? action.replace.targetQuery
      : action.replace.targetQuery;
    replacements.push({ from, to });
  }
  return replacements;
}

export interface BuildLogEntryParams {
  sessionId: string;
  conversationId: string;
  rawMessage: string;
  parseResult: ParseResult;
  before: OrderContext;
  after: OrderContext;
  menu: Menu;
  performance: PerformanceMetrics;
  now?: () => Date;
}

export function buildLogEntry(params: BuildLogEntryParams): MessageLogEntry {
  const { rawMessage, parseResult, before, after, menu, performance: perf } = params;
  const nowFn = params.now ?? (() => new Date());

  const { itemsAdded, itemsRemoved, quantityChanges } = diffCarts(before.cart, after.cart);
  const itemsReplaced = extractReplacements(parseResult, before.cart, menu);
  const { matched, matchedItemDetails, rejected, ambiguous } = classifyItems(parseResult, menu);

  const totalBefore = calculateTotal(before.cart, menu).subtotal;
  const totalAfter = calculateTotal(after.cart, menu).subtotal;

  const cartAction = parseResult.actions.length > 0
    ? parseResult.actions.map((a) => a.action).join(", ")
    : undefined;

  const errors: string[] = [];
  const warnings: string[] = [];
  const fallbacks: string[] = [];

  if (parseResult.safetyDecision === "REJECT_UNAVAILABLE" || parseResult.safetyDecision === "REJECT_NOT_IN_CART") {
    warnings.push(`Rejected: ${parseResult.safetyDecision}`);
  }
  if (ambiguous.length > 0) {
    warnings.push(`Ambiguous item reference(s): ${ambiguous.join(", ")}`);
  }
  if (parseResult.intent === "UNKNOWN") {
    fallbacks.push("Fell through to UNKNOWN — no recognizable intent or menu vocabulary.");
  }
  if (parseResult.intent === "ASK_CLARIFICATION") {
    fallbacks.push("Fell through to ASK_CLARIFICATION — order-like phrasing but no resolvable item.");
  }
  if (cartAction && itemsAdded.length === 0 && itemsRemoved.length === 0 && itemsReplaced.length === 0 && quantityChanges.length === 0 && parseResult.safetyDecision === "SAFE_TO_EXECUTE") {
    errors.push("Safety approved a cart action but the cart did not change — check cart engine dispatch.");
  }

  const entryWithoutSummary: Omit<MessageLogEntry, "reasoningSummary"> = {
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    timestamp: nowFn().toISOString(),

    rawMessage,
    normalizedMessage: parseResult.normalizedMessage,
    detectedLanguage: detectLanguage(rawMessage),

    detectedIntent: parseResult.intent,
    confidence: parseResult.confidence,
    safetyDecision: parseResult.safetyDecision,

    matchedMenuItems: matched,
    matchedItemDetails,
    rejectedMenuItems: rejected,
    ambiguousMenuItems: ambiguous,
    clarificationTriggered: parseResult.needsClarification || parseResult.safetyDecision === "ASK_CLARIFICATION",
    category: parseResult.category,

    previousState: before.state,
    currentState: before.state,
    nextState: after.state,

    cartBefore: before.cart,
    cartAfter: after.cart,
    cartAction,
    itemsAdded,
    itemsRemoved,
    itemsReplaced,
    quantityChanges,
    totalBefore,
    totalAfter,

    executionTimeMs: perf.totalMs,

    errors,
    warnings,
    fallbacks,
  };

  return { ...entryWithoutSummary, reasoningSummary: buildReasoningSummary(entryWithoutSummary) };
}

// ─── Log store ────────────────────────────────────────────────────────────────

export class Logger {
  private entries: MessageLogEntry[] = [];

  constructor(public readonly sessionId: string, public readonly conversationId: string) {}

  log(entry: MessageLogEntry): void {
    this.entries.push(entry);
  }

  getEntries(): readonly MessageLogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

// ─── Cross-entry cart analytics ──────────────────────────────────────────────

function topCounts<T extends string>(counts: Map<T, number>, limit = 10): { key: T; count: number }[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function increment<T extends string>(counts: Map<T, number>, key: T): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export interface CartAnalytics {
  totalItemsAdded: number;
  totalItemsRemoved: number;
  mostOrderedItems: { name: string; count: number }[];
  mostRequestedUnavailableItems: { query: string; count: number }[];
  mostCommonClarificationCategories: { category: string; count: number }[];
  mostCommonParserFailures: { message: string; count: number }[];
  // Approximation, documented: without an explicit "this was a spelling
  // correction" signal from the parser, this counts queries that resolved
  // to a matched item WITHOUT being an exact (case-insensitive) match for
  // its name — folds true typos and intentional shorthand/aliases together.
  mostCommonSpellingMistakes: { query: string; matchedName: string; count: number }[];
  mostCommonAliasesUsed: { query: string; matchedName: string; count: number }[];
  mostCommonReplacementActions: { from: string; to: string; count: number }[];
  mostCommonCheckoutInterruptions: { fromState: string; count: number }[];
}

const CHECKOUT_INTERRUPTIBLE_STATES = new Set([
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
]);

export function computeCartAnalytics(entries: readonly MessageLogEntry[]): CartAnalytics {
  let totalItemsAdded = 0;
  let totalItemsRemoved = 0;
  const orderedCounts = new Map<string, number>();
  const unavailableCounts = new Map<string, number>();
  const clarificationCounts = new Map<string, number>();
  const failureCounts = new Map<string, number>();
  const aliasCounts = new Map<string, { matchedName: string; count: number }>();
  const spellingCounts = new Map<string, { matchedName: string; count: number }>();
  const replacementCounts = new Map<string, { from: string; to: string; count: number }>();
  const interruptionCounts = new Map<string, number>();

  for (const entry of entries) {
    for (const line of entry.itemsAdded) {
      totalItemsAdded += line.qty;
      increment(orderedCounts, line.name);
    }
    totalItemsRemoved += entry.itemsRemoved.reduce((sum, l) => sum + l.qty, 0);

    for (const query of entry.rejectedMenuItems) {
      increment(unavailableCounts, query);
    }

    if (entry.clarificationTriggered && entry.category) {
      increment(clarificationCounts, entry.category);
    }

    if (entry.detectedIntent === "UNKNOWN") {
      increment(failureCounts, entry.normalizedMessage);
    }

    for (const { query, matchedName } of entry.matchedItemDetails) {
      // Exact (case-insensitive) match of the per-item query text against
      // the resolved name is a real alias/shorthand use ("gyro" -> "Gyro");
      // anything else folds true typos and intentional shorthand together
      // (documented limitation — the parser doesn't distinguish the two).
      const isExactName = query.trim().toLowerCase() === matchedName.toLowerCase();
      const bucket = isExactName ? aliasCounts : spellingCounts;
      const key = `${query} -> ${matchedName}`;
      const prior = bucket.get(key);
      bucket.set(key, { matchedName, count: (prior?.count ?? 0) + 1 });
    }

    for (const r of entry.itemsReplaced) {
      const key = `${r.from} -> ${r.to}`;
      const prior = replacementCounts.get(key);
      replacementCounts.set(key, { from: r.from, to: r.to, count: (prior?.count ?? 0) + 1 });
    }

    if (CHECKOUT_INTERRUPTIBLE_STATES.has(entry.previousState) && entry.nextState === "ORDER_REVIEW") {
      increment(interruptionCounts, entry.previousState);
    }
  }

  return {
    totalItemsAdded,
    totalItemsRemoved,
    mostOrderedItems: topCounts(orderedCounts).map(({ key, count }) => ({ name: key, count })),
    mostRequestedUnavailableItems: topCounts(unavailableCounts).map(({ key, count }) => ({ query: key, count })),
    mostCommonClarificationCategories: topCounts(clarificationCounts).map(({ key, count }) => ({ category: key, count })),
    mostCommonParserFailures: topCounts(failureCounts).map(({ key, count }) => ({ message: key, count })),
    mostCommonSpellingMistakes: Array.from(spellingCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, v]) => ({ query: key.split(" -> ")[0], matchedName: v.matchedName, count: v.count })),
    mostCommonAliasesUsed: Array.from(aliasCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, v]) => ({ query: key.split(" -> ")[0], matchedName: v.matchedName, count: v.count })),
    mostCommonReplacementActions: Array.from(replacementCounts.values()).sort((a, b) => b.count - a.count),
    mostCommonCheckoutInterruptions: topCounts(interruptionCounts).map(({ key, count }) => ({ fromState: key, count })),
  };
}
