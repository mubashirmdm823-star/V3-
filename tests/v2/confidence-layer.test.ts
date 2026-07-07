// V2 confidence layer tests — thresholds and how the safety layer uses them.
// Run with:
//   npx tsx --test tests/v2/confidence-layer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { CartState } from "../../v2/types/cart";
import type { Intent } from "../../v2/types/intent";
import {
  CONFIDENCE_THRESHOLDS,
  classifyConfidence,
  isHighConfidence,
  isLowConfidence,
} from "../../v2/intent-parser/confidence";
import { evaluateSafety } from "../../v2/intent-parser/safety";

const menu = menuData as Menu;
const emptyCart: CartState = { items: [] };

test("classifyConfidence: boundaries", () => {
  assert.equal(classifyConfidence(1), "high");
  assert.equal(classifyConfidence(0.85), "high");
  assert.equal(classifyConfidence(0.84), "medium");
  assert.equal(classifyConfidence(0.6), "medium");
  assert.equal(classifyConfidence(0.59), "low");
  assert.equal(classifyConfidence(0), "low");
});

test("isHighConfidence / isLowConfidence match the documented thresholds", () => {
  assert.equal(CONFIDENCE_THRESHOLDS.high, 0.85);
  assert.equal(CONFIDENCE_THRESHOLDS.mediumLow, 0.6);
  assert.equal(isHighConfidence(0.85), true);
  assert.equal(isHighConfidence(0.849999), false);
  assert.equal(isLowConfidence(0.6), false);
  assert.equal(isLowConfidence(0.599999), true);
});

test("medium confidence (0.60-0.84) never authorizes SAFE_TO_EXECUTE, even for an unambiguous item", () => {
  for (const confidence of [0.6, 0.7, 0.84]) {
    const intent: Intent = {
      type: "add_item",
      rawText: "ek jumbo zinger",
      confidence,
      items: [{ query: "jumbo zinger", quantity: 1, candidateItemIds: ["jumbo-zinger"] }],
    };
    const result = evaluateSafety(intent, emptyCart, menu);
    assert.notEqual(result.decision, "SAFE_TO_EXECUTE", `confidence ${confidence} must not execute`);
    assert.equal(result.decision, "ASK_CLARIFICATION");
  }
});

test("high confidence (>=0.85) authorizes SAFE_TO_EXECUTE for an unambiguous item", () => {
  const intent: Intent = {
    type: "add_item",
    rawText: "ek jumbo zinger",
    confidence: 0.85,
    items: [{ query: "jumbo zinger", quantity: 1, candidateItemIds: ["jumbo-zinger"] }],
  };
  const result = evaluateSafety(intent, emptyCart, menu);
  assert.equal(result.decision, "SAFE_TO_EXECUTE");
});

test("low confidence (<0.60) never mutates the cart, for known or unknown intent types", () => {
  const known: Intent = {
    type: "add_item",
    rawText: "shayad zinger",
    confidence: 0.4,
    items: [{ query: "zinger burger", quantity: 1, candidateItemIds: ["zinger-burger"] }],
  };
  const unknown: Intent = { type: "unknown", rawText: "???", confidence: 0.1 };

  const knownResult = evaluateSafety(known, emptyCart, menu);
  const unknownResult = evaluateSafety(unknown, emptyCart, menu);

  assert.notEqual(knownResult.decision, "SAFE_TO_EXECUTE");
  assert.equal(unknownResult.decision, "NO_CART_ACTION");
});

test("confidence never overrides a structural REJECT_UNAVAILABLE (menu fact, not a confidence issue)", () => {
  const intent: Intent = {
    type: "add_item",
    rawText: "beef burger",
    confidence: 0.99,
    items: [{ query: "beef burger", quantity: 1, candidateItemIds: [] }],
  };
  const result = evaluateSafety(intent, emptyCart, menu);
  assert.equal(result.decision, "REJECT_UNAVAILABLE");
});
