// V2 phase 10 — response cache.
//
// A small in-memory cache to avoid re-calling a provider for messages whose
// answer is very unlikely to change turn to turn (menu/price/restaurant-info
// style questions) — never used for cart-mutating messages, since those
// depend on the current cart/state, not just the raw text. Purely
// additive/observational: nothing here decides intent or touches the
// pipeline; it only remembers a previously-validated LLMStructuredResponse
// keyed off a cache key the caller computes.

import type { LLMStructuredResponse } from "./types";

export interface CacheEntry {
  response: LLMStructuredResponse;
  cachedAt: number;
  expiresAt: number;
}

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Only these intents are safe to cache by message text alone — anything
// cart/checkout-related depends on state that a cached answer wouldn't
// reflect.
const CACHEABLE_INTENTS: ReadonlySet<string> = new Set([
  "SHOW_MENU", "SHOW_OPTIONS", "PRICE_QUERY", "HYPOTHETICAL_TOTAL", "ASK_RESTAURANT_INFO",
]);

export function isCacheableIntent(intent: string): boolean {
  return CACHEABLE_INTENTS.has(intent);
}

export function buildCacheKey(rawMessage: string): string {
  return rawMessage.trim().toLowerCase().replace(/\s+/g, " ");
}

export class LLMCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS, private readonly now: () => number = Date.now) {}

  get(key: string): LLMStructuredResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.response;
  }

  set(key: string, response: LLMStructuredResponse, ttlMs: number = this.ttlMs): void {
    const cachedAt = this.now();
    this.entries.set(key, { response, cachedAt, expiresAt: cachedAt + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
