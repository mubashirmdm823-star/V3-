// V2 phase 8 — orchestrator error types.
//
// Pure typed-error plumbing: no customer-facing text lives here (that would
// duplicate the response builder's job). When a stage's output fails
// validation or throws, the orchestrator catches a PipelineError and asks
// the response builder for its existing generic fallback copy — see
// process-message.ts.

export type PipelineStage =
  | "CONTEXT"
  | "PARSER"
  | "SAFETY"
  | "CART"
  | "STATE"
  | "RESPONSE"
  | "LOGGER";

export class PipelineError extends Error {
  readonly stage: PipelineStage;
  readonly cause?: unknown;

  constructor(stage: PipelineStage, message: string, cause?: unknown) {
    super(message);
    this.name = "PipelineError";
    this.stage = stage;
    this.cause = cause;
  }
}

export function isPipelineError(value: unknown): value is PipelineError {
  return value instanceof PipelineError;
}

// Normalizes anything thrown mid-pipeline into a PipelineError tagged with
// the stage that was executing when it happened, so the caller always has a
// stage to key its recovery/logging off of, even for an unexpected native
// exception (e.g. a TypeError) rather than one this codebase raised itself.
export function toPipelineError(stage: PipelineStage, error: unknown): PipelineError {
  if (isPipelineError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PipelineError(stage, message, error);
}
