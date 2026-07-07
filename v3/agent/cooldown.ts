// V3 one-call agent — process-wide 429 cooldown.
//
// One shared Google API key means one customer's rate-limit hit affects
// every other customer's next request too, so this is deliberately
// process-wide (module-level state), not per-session. This is the ONE
// exception to "always call Gemini": skipping a call we already know will
// fail is not a keyword/conversation-logic shortcut, it's the same kind of
// genuine-failure case that triggers the V2 fallback anyway.

const COOLDOWN_MS = 60_000;
let cooldownUntilMs = 0;

export function recordRateLimitHit(nowMs: number = Date.now()): void {
  cooldownUntilMs = nowMs + COOLDOWN_MS;
}

export function isCooldownActive(nowMs: number = Date.now()): boolean {
  return nowMs < cooldownUntilMs;
}

// Test-only reset — cooldown is module-level state, so tests that want a
// clean slate call this first.
export function resetCooldown(): void {
  cooldownUntilMs = 0;
}

// Shown to the customer for a message that arrives while the cooldown is
// active — honest about the delay without ever exposing internal error/
// debug details.
export const COOLDOWN_BUSY_REPLY =
  "System thora busy hai, lekin main aapka order safely continue kar sakta hoon. Meherbani karke item ka naam simple words mein likh dein.";
