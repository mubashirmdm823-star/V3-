// V2 phase 13 — V1 engine adapter.
//
// Wraps lib/think-food-ai.ts's ai()/applyCartAction() — completely
// untouched, no business logic duplicated or changed here — behind the
// shared AIEngine interface (./types.ts). This is the only new code
// V1 gets in this phase: a thin translation layer between its own
// Phase/Draft/CartAction shapes and the engine-agnostic
// EngineRequest/EngineResponse contract.

import { ai, applyCartAction, type Phase, type Draft } from "@/lib/think-food-ai";
import type { AIEngine, EngineCartItem, EngineDebugInfo, EngineRequest, EngineResponse } from "./types";

// A response with an explicit `debug: undefined` key would still make
// `"debug" in result` true — JSON/object-key presence doesn't care about
// the value. Debug is only ever included as a real key when requested.
function buildDebug(requested: boolean | undefined, rawState: Phase): EngineDebugInfo | undefined {
  if (!requested) return undefined;
  return { activeEngine: "v1", fallbackUsed: false, rawState };
}

interface V1Context {
  phase: Phase;
  draft: Draft;
}

function freshContext(): V1Context {
  return { phase: "browsing", draft: { cart: [] } };
}

function isV1Context(value: unknown): value is V1Context {
  return (
    typeof value === "object" &&
    value !== null &&
    "phase" in value &&
    "draft" in value &&
    typeof (value as { draft: unknown }).draft === "object" &&
    (value as { draft: unknown }).draft !== null
  );
}

// "Restore it safely" — a foreign/corrupted context blob (e.g. one
// produced by the V2 engine) must never crash this adapter; start a fresh
// V1 conversation instead, exactly like v2.ts's own resolveContext().
function resolveContext(raw: unknown): V1Context {
  return isV1Context(raw) ? raw : freshContext();
}

function toEngineCart(cart: Draft["cart"]): EngineCartItem[] {
  return cart.map((line) => ({ name: line.name, price: line.price, qty: line.qty }));
}

// The exact text WhatsAppSimulator.tsx used to build inline when
// `ai()` returned `{ confirmed: true }` — moved here unchanged so the
// simulator no longer needs any engine-specific special case at all.
function buildOrderConfirmedReply(): string {
  const orderId = String(1007 + Math.floor(Math.random() * 90));
  return `✅ *Order received successfully.*\n\nOrder Number: *#${orderId}*\n\nStatus: ⏳ *Pending Verification*\n\nOur team will call you shortly to confirm your order.\n\nThank you for choosing *Think Food!* 🍔`;
}

const ALREADY_DONE_REPLY =
  "Aapka order pehle hi submit ho chuka hai. Nayi conversation shuru karne ke liye chat reset karein.";

export const v1Engine: AIEngine = {
  name: "v1",

  async processMessage(request: EngineRequest): Promise<EngineResponse> {
    const context = resolveContext(request.context);

    if (context.phase === "done") {
      const debug = buildDebug(request.debug, context.phase);
      return {
        reply: ALREADY_DONE_REPLY,
        context,
        cart: toEngineCart(context.draft.cart),
        state: context.phase,
        isFinished: true,
        ...(debug ? { debug } : {}),
      };
    }

    const out = ai(request.message, context.phase, context.draft);

    let reply: string;
    let nextPhase: Phase = context.phase;
    let nextDraft: Draft = context.draft;

    if (out.confirmed) {
      reply = buildOrderConfirmedReply();
      nextPhase = "done";
    } else {
      reply = out.content;
      if (out.nextPhase) nextPhase = out.nextPhase;

      let cart = context.draft.cart;
      if (out.cartActions) {
        for (const action of out.cartActions) cart = applyCartAction(cart, action);
      } else if (out.cartAction) {
        cart = applyCartAction(cart, out.cartAction);
      }
      nextDraft = { ...context.draft, ...(out.draftPatch ?? {}), cart };
    }

    const nextContext: V1Context = { phase: nextPhase, draft: nextDraft };

    const debug = buildDebug(request.debug, nextPhase);
    return {
      reply,
      context: nextContext,
      cart: toEngineCart(nextDraft.cart),
      state: nextPhase,
      isFinished: nextPhase === "done",
      ...(debug ? { debug } : {}),
    };
  },
};
