// V2 confidence layer.
//
// A single source of truth for how sure the parser must be before the
// safety layer (./safety.ts) is allowed to let anything touch the cart.

export const CONFIDENCE_THRESHOLDS = {
  high: 0.85,
  mediumLow: 0.6,
} as const;

export type ConfidenceLevel = "high" | "medium" | "low";

export function classifyConfidence(confidence: number): ConfidenceLevel {
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (confidence >= CONFIDENCE_THRESHOLDS.mediumLow) return "medium";
  return "low";
}

// Only "high" confidence is ever allowed to authorize a cart mutation.
export function isHighConfidence(confidence: number): boolean {
  return confidence >= CONFIDENCE_THRESHOLDS.high;
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < CONFIDENCE_THRESHOLDS.mediumLow;
}
