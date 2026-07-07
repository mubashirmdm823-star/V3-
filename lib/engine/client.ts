// V2 phase 13 — client-safe engine access.
//
// WhatsAppSimulator.tsx is a "use client" component: it runs in the
// browser, where `process.env.AI_ENGINE` (a plain, non-NEXT_PUBLIC_ server
// env var) is never available, and where V2's server-only modules (JSON
// data imports, node:crypto, the full pipeline) have no business being
// bundled into client JavaScript at all. This file is the simulator's
// ONLY integration point with lib/engine: it calls the real /api/chat
// route (which runs lib/engine's actual router server-side, correctly
// reading AI_ENGINE) over HTTP, and adapts the response back into the
// exact same EngineResponse shape — so the simulator still only ever
// imports from lib/engine, and still never imports V1 or V2 directly.

import type { EngineRequest, EngineResponse } from "./types";

export interface ClientProcessMessageOptions {
  // Test-only injection point (a fake fetch returning a canned Response) —
  // production code always uses the real global fetch against the
  // same-origin relative /api/chat URL.
  fetchImpl?: typeof fetch;
}

const GENERIC_FAILURE_REPLY =
  "Maaf kijiye, is waqt aapki request process nahi ho saki. Barah-e-meherbani dobara koshish karein.";

export async function processMessage(
  request: EngineRequest,
  options: ClientProcessMessageOptions = {}
): Promise<EngineResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      return {
        reply: GENERIC_FAILURE_REPLY,
        context: request.context,
        cart: [],
        state: "error",
        isFinished: false,
      };
    }

    return (await res.json()) as EngineResponse;
  } catch {
    // Network failure, the dev server not running, etc. — never throw to
    // the UI, return the same safe shape lib/engine/index.ts's own
    // no-further-fallback path returns.
    return {
      reply: GENERIC_FAILURE_REPLY,
      context: request.context,
      cart: [],
      state: "error",
      isFinished: false,
    };
  }
}
