// AI Gateway — safe diagnostic helpers.
//
// Every function here exists to answer "why did this provider actually
// fail?" without ever risking a leaked API key: Gemini's key rides in the
// URL's query string, Groq/OpenRouter's rides in the Authorization header —
// neither is ever logged verbatim. Provider adapters build a
// ProviderDiagnostics record using these helpers at the exact point they
// have the raw URL/response; failover.ts only ever sees the already-safe
// result.

import type { ProviderId } from "./types";

const MAX_BODY_SUMMARY_LENGTH = 300;

// Gemini is the one provider whose key rides in the URL itself
// (`?key=...`) — this is the ONLY place that URL is ever allowed to be
// logged, and only after this redaction.
export function maskUrlKey(url: string): string {
  return url.replace(/([?&]key=)[^&]+/i, "$1***REDACTED***");
}

// Defense in depth: even though callers should never pass the raw secret
// into a string headed for a log, this strips any literal occurrence of it
// anyway (e.g. an API's own error message unexpectedly echoing part of the
// request back). Skips anything shorter than a real API key ever is —
// without this, a short value would turn into a global find-and-replace
// over ordinary words (e.g. a test fixture's one-letter placeholder key
// "g" would redact every "g" in "gemini"), which helps no one and makes
// the log unreadable for zero extra safety.
const MIN_REDACTABLE_SECRET_LENGTH = 6;

export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < MIN_REDACTABLE_SECRET_LENGTH) return text;
  return text.split(secret).join("***REDACTED***");
}

// Extracts a short, safe error message from a provider's response body —
// every provider used here (Gemini, and the OpenAI-compatible Groq/
// OpenRouter) shapes errors as either `{ error: { message } }` (object) or
// `{ error: "message" }` (string). Falls back to a truncated raw-text
// snippet when the body isn't recognizable JSON at all (e.g. an HTML error
// page from a proxy/edge in front of the real API), never throws itself.
export function safeErrorMessage(rawBody: string, apiKey: string | undefined): string {
  let message = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    const error = parsed?.error;
    if (typeof error === "string") message = error;
    else if (error && typeof error.message === "string") message = error.message;
    else if (typeof parsed?.message === "string") message = parsed.message;
  } catch {
    // Not JSON — use the raw text as-is (still truncated/redacted below).
  }
  message = redactSecret(message, apiKey).trim();
  return message.length > MAX_BODY_SUMMARY_LENGTH ? `${message.slice(0, MAX_BODY_SUMMARY_LENGTH)}…` : message;
}

export interface ProviderDiagnostics {
  provider: ProviderId;
  model: string;
  // Already redacted (maskUrlKey for Gemini) — always safe to log as-is.
  baseUrl: string;
  timeoutMs: number;
  // Only present for an HTTP failure with an actual response body — never
  // set for a genuine timeout/abort (no response ever arrived).
  bodySummary?: string;
}
