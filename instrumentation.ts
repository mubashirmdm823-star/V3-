// Runs once when a new Next.js server instance starts (see
// node_modules/next/dist/docs/.../instrumentation.md). Only logs a safe
// environment summary via config/env-check.ts — no side effects on
// request handling, no architecture change.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("./config/env-check");
    validateEnv();
  }
}
