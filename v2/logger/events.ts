// The shape of a single logged customer message, and the small,
// self-contained heuristics (language detection) used to annotate it.
// Nothing here affects cart/state behavior — it only describes what
// happened, after the fact, from data the pipeline already produced.

import type { CartLineItem, CartState } from "../types/cart";
import type { OrderState } from "../types/order";
import type { IntentName } from "../types/parser";
import type { SafetyDecisionType } from "../intent-parser/safety";

export type DetectedLanguage = "english" | "roman-urdu" | "hinglish" | "unknown";

const ROMAN_URDU_MARKERS = new Set([
  "hai", "hain", "kardo", "karo", "kar", "chahiye", "chahye", "dedo", "krdo",
  "aur", "mera", "meri", "kaunsa", "kaunse", "kya", "nahi", "haan", "zara",
  "bhai", "yar", "wala", "wali", "hata", "hatao", "batao", "dikhao", "jagah",
  "sab", "ek", "bas", "yahi",
]);

const ENGLISH_MARKERS = new Set([
  "the", "is", "are", "want", "please", "order", "show", "price", "my",
  "add", "remove", "for", "with", "and", "yes", "no", "confirm", "name",
]);

// Purely descriptive, for logs — never used to decide intent/safety.
export function detectLanguage(rawMessage: string): DetectedLanguage {
  const tokens = rawMessage
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  const hasUrdu = tokens.some((t) => ROMAN_URDU_MARKERS.has(t));
  const hasEnglish = tokens.some((t) => ENGLISH_MARKERS.has(t));

  if (hasUrdu && hasEnglish) return "hinglish";
  if (hasUrdu) return "roman-urdu";
  if (hasEnglish) return "english";
  return "unknown";
}

export interface ItemReplacedLog {
  from: string;
  to: string;
}

export interface QuantityChangeLog {
  itemId: string;
  before: number;
  after: number;
}

// Everything required by the "Logged Information" spec for a single
// customer message. Built once per message by logger.ts#buildLogEntry —
// nothing here is ever partially filled in by the pipeline itself.
export interface MessageLogEntry {
  sessionId: string;
  conversationId: string;
  timestamp: string;

  rawMessage: string;
  normalizedMessage: string;
  detectedLanguage: DetectedLanguage;

  detectedIntent: IntentName;
  confidence: number;
  safetyDecision: SafetyDecisionType;

  matchedMenuItems: string[];
  // Per-item (query text, resolved name) pairs for every unambiguously
  // matched item ref — the precise per-item basis for alias/spelling
  // analytics, as opposed to approximating from the whole message.
  matchedItemDetails: { query: string; matchedName: string }[];
  rejectedMenuItems: string[];
  ambiguousMenuItems: string[];
  clarificationTriggered: boolean;
  category?: string;

  // previousState/currentState are the same value in this architecture
  // (processMessage dispatches on a single context.state snapshot) — both
  // are kept because the spec calls for both field names explicitly.
  previousState: OrderState;
  currentState: OrderState;
  nextState: OrderState;

  cartBefore: CartState;
  cartAfter: CartState;
  cartAction?: string;
  itemsAdded: CartLineItem[];
  itemsRemoved: CartLineItem[];
  itemsReplaced: ItemReplacedLog[];
  quantityChanges: QuantityChangeLog[];
  totalBefore: number;
  totalAfter: number;

  executionTimeMs: number;

  errors: string[];
  warnings: string[];
  fallbacks: string[];
  reasoningSummary: string;
}
