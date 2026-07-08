// V2 phase 13 — chat API route.
// Vercel production-runtime hardening pass — see AGENTS.md/README.md.
//
// Delegates entirely to lib/engine's Engine Router — the same abstraction
// WhatsAppSimulator.tsx now uses. This route no longer imports V1 or V2
// directly (no menu/restaurantConfig/context-manager/process-message
// imports here anymore — that logic lives once, in lib/engine/v2.ts).
// lib/engine's router already never throws on its own (it recovers
// internally, with automatic V2 -> V1 rollback on an unexpected failure —
// see lib/engine/index.ts) — the outer try/catch below is defense in depth
// for anything upstream of that (a malformed request, an unexpected
// exception in request parsing), so Vercel never sees this route crash
// silently; it always gets a JSON response.
//
// Which engine actually runs is controlled ONLY by the AI_ENGINE
// environment variable (config/ai-engine.ts) — this route has no
// engine-selection logic of its own.

import { processMessage } from "@/lib/engine";
import { logger } from "@/lib/logger";

// This route imports lib/engine -> v2/v3, which use node:crypto and other
// Node-only APIs (see lib/engine/v2.ts, v3.ts) — explicit, not just relying
// on the App Router's Node.js default, so a future change elsewhere (a
// shared layout/middleware opting into the Edge runtime, a Vercel project
// setting) can never silently move this route onto a runtime that can't
// resolve those imports.
export const runtime = "nodejs";
// Never statically optimized/cached — every call must run the real engine
// pipeline against the request's own message/context, never a cached build-
// time response.
export const dynamic = "force-dynamic";
// The AI Gateway's per-provider timeout (ai-gateway/config.ts, 8s default)
// times out sequentially across up to 3 providers before falling back to
// the deterministic V2 pipeline — a worst-case cold cascade (~24s) can
// exceed a serverless platform's default function duration, which silently
// kills the function before it ever returns a response. Raised well above
// that worst case; well within Vercel's configurable limit on every plan.
export const maxDuration = 30;

interface ChatRequestBody {
  message?: unknown;
  context?: unknown;
  debug?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    let body: ChatRequestBody;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
    }

    if (!isPlainObject(body) || typeof body.message !== "string" || body.message.trim().length === 0) {
      return errorResponse(400, "missing_message", '"message" is required and must be a non-empty string.');
    }

    const debug = body.debug === true;
    const result = await processMessage({ message: body.message, context: body.context, debug });

    return Response.json(
      {
        reply: result.reply,
        context: result.context,
        cart: result.cart,
        state: result.state,
        // Normalized "is this conversation over" signal (see
        // lib/engine/types.ts) — the one thing a generic caller (the UI)
        // needs, without having to know either engine's own state
        // vocabulary. Always included, same as reply/context/cart/state.
        isFinished: result.isFinished,
        ...(debug && result.debug ? { debug: result.debug } : {}),
      },
      { status: 200 }
    );
  } catch (error) {
    // Last-resort net: lib/engine's own router already recovers from every
    // engine failure it knows how to (see its header above), so reaching
    // here means something genuinely unexpected happened. Vercel must never
    // see a silent 500/timeout with no body — always return safe JSON, and
    // never the real error message/stack (could echo request content, file
    // paths, or other internals), only a fixed, generic reason.
    logger.error("[api/chat] unexpected runtime error:", error);
    return Response.json({ error: "api_runtime_error", message: "Something went wrong processing your request." }, { status: 500 });
  }
}
