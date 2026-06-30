import type { Phase } from "@/lib/think-food-ai";

export interface CartExpectation {
  name: string;
  qty: number;
}

export interface Expectation {
  /** Whether the cart's contents (items/qty) should differ before vs after this message. */
  cartChanges: boolean;
  /** Exact expected cart after the message — only set when fully deterministic. */
  cartAfter?: CartExpectation[];
  /** Exact expected cart subtotal (price*qty sum, no delivery fee) after the message. */
  totalAfter?: number;
  /** Expected conversation phase after the message. */
  phaseAfter?: Phase;
  /** Substrings (case-insensitive) the AI response must contain. */
  contains?: string[];
  /** Substrings (case-insensitive) the AI response must NOT contain. */
  notContains?: string[];
  /** Whether this message should trigger final order confirmation. */
  confirmed?: boolean;
}

export interface TestCase {
  id: string;
  category: string;
  description: string;
  /** Messages sent (and threaded through state) before the message under test. Not graded. */
  setup?: string[];
  /** The realistic customer message actually being tested. */
  message: string;
  /** Human-readable label for what this message means — reporting only. */
  intent: string;
  expect: Expectation;
}
