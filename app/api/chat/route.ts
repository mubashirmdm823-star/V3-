// V2 phase 13 — chat API route.
//
// Delegates entirely to lib/engine's Engine Router — the same abstraction
// WhatsAppSimulator.tsx now uses. This route no longer imports V1 or V2
// directly (no menu/restaurantConfig/context-manager/process-message
// imports here anymore — that logic lives once, in lib/engine/v2.ts) and
// no longer needs its own try/catch: lib/engine's router already never
// throws (it recovers internally, with automatic V2 -> V1 rollback on an
// unexpected failure — see lib/engine/index.ts).
//
// Which engine actually runs is controlled ONLY by the AI_ENGINE
// environment variable (config/ai-engine.ts) — this route has no
// engine-selection logic of its own.

import { processMessage } from "@/lib/engine";

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
}
