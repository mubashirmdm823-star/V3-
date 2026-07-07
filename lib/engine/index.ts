// V2 phase 13 — the Engine Router.
//
// Flow: Customer Message -> Engine Router -> read AI_ENGINE -> V1 or V2 ->
// return the identical EngineResponse contract. This is the server-side
// engine abstraction — app/api/chat/route.ts is the only place that calls
// it directly, never importing lib/think-food-ai.ts or
// v2/core/process-message.ts itself.
//
// WhatsAppSimulator.tsx does NOT import this module: it's a "use client"
// component, and both `process.env.AI_ENGINE` (a plain server env var,
// invisible to browser bundles) and V2's server-only modules (JSON data
// imports, node:crypto, the full pipeline) have no correct meaning or
// business being bundled into client JavaScript. The simulator instead
// imports ./client.ts, which calls this same router indirectly over HTTP
// via /api/chat — still "only ever importing from lib/engine", still
// never touching V1/V2 directly, and guaranteeing the UI and any other
// API consumer see byte-identical behavior since they hit the exact same
// server code path.

import { getConfiguredEngineName } from "@/config/ai-engine";
import { v1Engine } from "./v1";
import { v2Engine } from "./v2";
import { v3Engine } from "./v3";
import type { AIEngine, AIEngineName, EngineRequest, EngineResponse } from "./types";

const ENGINES: Record<AIEngineName, AIEngine> = { v1: v1Engine, v2: v2Engine, v3: v3Engine };

export interface ProcessMessageOptions {
  // Overrides which engine is used for this call instead of reading
  // AI_ENGINE — used by tests; app/api/chat/route.ts and
  // WhatsAppSimulator.tsx never pass this, so their behavior is controlled
  // by the environment variable alone, per this phase's explicit rule.
  engine?: AIEngineName;
  env?: Record<string, string | undefined>;
  // Test-only dependency injection (e.g. a fake engine that deliberately
  // throws, to exercise the rollback path deterministically without
  // needing to organically break the real, already very defensive V2
  // pipeline). Never used by production callers.
  engines?: Partial<Record<AIEngineName, AIEngine>>;
}

const GENERIC_FAILURE_REPLY =
  "Maaf kijiye, is waqt aapki request process nahi ho saki. Barah-e-meherbani dobara koshish karein.";

export async function processMessage(
  request: EngineRequest,
  options: ProcessMessageOptions = {}
): Promise<EngineResponse> {
  const engines: Record<AIEngineName, AIEngine> = { ...ENGINES, ...options.engines };
  const requestedName = options.engine ?? getConfiguredEngineName(options.env);
  const primary = engines[requestedName];

  try {
    return await primary.processMessage(request);
  } catch (error) {
    // Log the failure — never let it surface to the customer, and never
    // let it crash the caller (UI or API route).
    console.error(`[engine-router] "${requestedName}" engine failed:`, error);

    if (requestedName === "v2" || requestedName === "v3") {
      // Safe rollback: V2 or V3 throwing an unexpected error (something
      // outside its own internal recovery — V3's own agent loop already
      // falls back to the full V2 pipeline internally on any LLM failure,
      // see v3/agent/index.ts's header, so reaching HERE means something
      // truly unexpected happened) falls back to V1. V1 has no concept of
      // V2/V3's context shape, so this necessarily starts a fresh V1
      // conversation for this turn rather than attempting to translate
      // incompatible state — a disclosed, deliberate limitation of a
      // cross-engine safety net, not a silent one (fallbackUsed always
      // reports it).
      try {
        const fallback = await engines.v1.processMessage({ message: request.message, debug: request.debug });
        // A response with an explicit `debug: undefined` key would still
        // make `"debug" in result` true — key presence doesn't care about
        // the value — so this only ever adds the key when there's a real
        // debug object to mark as a fallback.
        const { debug: fallbackDebug, ...rest } = fallback;
        return fallbackDebug ? { ...rest, debug: { ...fallbackDebug, fallbackUsed: true } } : rest;
      } catch (fallbackError) {
        console.error("[engine-router] V1 fallback also failed:", fallbackError);
      }
    }

    // No further fallback available (V1 itself failed, or the fallback
    // attempt above also failed) — never crash the caller, return a safe,
    // internals-free reply instead.
    return {
      reply: GENERIC_FAILURE_REPLY,
      context: request.context,
      cart: [],
      state: "error",
      isFinished: false,
      ...(request.debug ? { debug: { activeEngine: requestedName, fallbackUsed: true } } : {}),
    };
  }
}

export type { AIEngine, AIEngineName, EngineCartItem, EngineDebugInfo, EngineRequest, EngineResponse } from "./types";
