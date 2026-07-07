// V2 phase 10 — JSON response validation.
//
// The gate between "whatever text the model returned" and anything else in
// this layer ever seeing it as structured data. Every one of this phase's
// "Absolute Rules" is enforced here, not just documented in the system
// prompt: a model can't be trusted to police itself, so every field is
// checked against real data (the actual menu) rather than taken at face
// value.

import type { Menu } from "../types/menu";
import { allMenuItems } from "../intent-parser/matching";
import type { LLMStructuredResponse } from "./types";
import {
  ALLOWED_LLM_INTENTS,
  LLM_RESPONSE_ALLOWED_FIELDS,
  LLM_RESPONSE_REQUIRED_FIELDS,
  LLM_ITEM_ALLOWED_FIELDS,
  LLM_REPLACE_ALLOWED_FIELDS,
  MAX_REASONABLE_QUANTITY,
  MIN_CONFIDENCE_TO_ACCEPT,
} from "./json-schema";

export type LLMValidationFailureReason =
  | "invalid_json"
  | "not_object"
  | "missing_field"
  | "unknown_field"
  | "unknown_intent"
  | "invalid_confidence"
  | "low_confidence"
  | "invalid_items"
  | "hallucinated_item"
  | "invalid_quantity"
  | "invalid_replace"
  | "invalid_field";

export type LLMValidationResult =
  | { ok: true; response: LLMStructuredResponse }
  | { ok: false; reason: LLMValidationFailureReason; details?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: LLMValidationFailureReason, details?: string): LLMValidationResult {
  return { ok: false, reason, details };
}

// The system prompt tells the model to respond with ONLY a JSON object —
// no markdown, no code fences — but models (Google AI/Gemini observed in
// practice, not exclusive to it) don't always comply and wrap the response
// in a ```json ... ``` fence anyway. Strip that wrapper before parsing
// rather than trusting the model to police its own output format, same
// rule as everything else in this file. Only unwraps a fence that spans
// the ENTIRE response (leading/trailing whitespace aside) — text that
// merely contains a code fence somewhere isn't touched, so this can't mask
// a genuinely malformed response as valid.
function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return match ? match[1].trim() : trimmed;
}

function hasOnlyAllowedFields(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

export function validateLLMResponse(rawText: string, menu: Menu): LLMValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownCodeFence(rawText));
  } catch {
    return fail("invalid_json", "Response was not valid JSON.");
  }

  if (!isPlainObject(parsed)) {
    return fail("not_object", "Top-level JSON value must be an object.");
  }

  for (const field of LLM_RESPONSE_REQUIRED_FIELDS) {
    if (!(field in parsed)) return fail("missing_field", `Missing required field "${field}".`);
  }

  if (!hasOnlyAllowedFields(parsed, LLM_RESPONSE_ALLOWED_FIELDS)) {
    const extra = Object.keys(parsed).filter((k) => !LLM_RESPONSE_ALLOWED_FIELDS.has(k));
    return fail("unknown_field", `Unknown field(s): ${extra.join(", ")}.`);
  }

  const { intent, confidence, items, category, replace, needsClarification } = parsed;

  if (typeof intent !== "string" || !ALLOWED_LLM_INTENTS.has(intent as never)) {
    return fail("unknown_intent", `"${String(intent)}" is not a recognized intent.`);
  }

  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return fail("invalid_confidence", `Confidence must be a number between 0 and 1.`);
  }
  if (confidence < MIN_CONFIDENCE_TO_ACCEPT) {
    return fail("low_confidence", `Confidence ${confidence} is below the acceptance threshold.`);
  }

  if (!Array.isArray(items)) {
    return fail("invalid_items", "\"items\" must be an array.");
  }

  const menuIds = new Set(allMenuItems(menu).map((i) => i.id));

  for (const item of items) {
    if (!isPlainObject(item) || !hasOnlyAllowedFields(item, LLM_ITEM_ALLOWED_FIELDS)) {
      return fail("invalid_items", "Each item must only have \"id\" and \"quantity\".");
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      return fail("invalid_items", "Each item must have a non-empty string id.");
    }
    if (!menuIds.has(item.id)) {
      return fail("hallucinated_item", `"${item.id}" is not a real menu item id.`);
    }
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > MAX_REASONABLE_QUANTITY
    ) {
      return fail("invalid_quantity", `Quantity for "${item.id}" must be a positive integer up to ${MAX_REASONABLE_QUANTITY}.`);
    }
  }

  if (category !== undefined && typeof category !== "string") {
    return fail("invalid_field", "\"category\" must be a string when present.");
  }

  if (replace !== undefined) {
    if (!isPlainObject(replace) || !hasOnlyAllowedFields(replace, LLM_REPLACE_ALLOWED_FIELDS)) {
      return fail("invalid_replace", "\"replace\" must only have \"fromId\" and \"toId\".");
    }
    if (typeof replace.fromId !== "string" || typeof replace.toId !== "string") {
      return fail("invalid_replace", "\"replace.fromId\"/\"replace.toId\" must be strings.");
    }
    if (!menuIds.has(replace.fromId)) {
      return fail("hallucinated_item", `"${replace.fromId}" is not a real menu item id.`);
    }
    if (!menuIds.has(replace.toId)) {
      return fail("hallucinated_item", `"${replace.toId}" is not a real menu item id.`);
    }
  }

  if (needsClarification !== undefined && typeof needsClarification !== "boolean") {
    return fail("invalid_field", "\"needsClarification\" must be a boolean when present.");
  }

  const response: LLMStructuredResponse = {
    intent: intent as LLMStructuredResponse["intent"],
    confidence,
    items: items as LLMStructuredResponse["items"],
  };
  if (category !== undefined) response.category = category;
  if (replace !== undefined) {
    response.replace = { fromId: replace.fromId as string, toId: replace.toId as string };
  }
  if (needsClarification !== undefined) response.needsClarification = needsClarification;

  return { ok: true, response };
}
