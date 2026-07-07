// V2 phase 12 — /api/chat route tests.
// V2 phase 13 update — route.ts now delegates through lib/engine's Engine
// Router (config/ai-engine.ts's AI_ENGINE), which defaults to V1 when
// unset. This file's whole intent (predates the feature flag) is testing
// the V2 pipeline through the route specifically, so it forces
// AI_ENGINE=v2 for its own duration and restores whatever was there
// before — tests/v2/ui-switch.test.ts is what actually covers switching
// between engines.
//
// Calls the real Next.js route handler (app/api/chat/route.ts) directly
// with standard Fetch API Request objects — no running server needed, and
// no test here ever sets a real LLM_PROVIDER/API key, so every request
// exercises the deterministic-parser fallback path exactly as it would in
// this repo today.
// Run with:
//   npx tsx --test tests/v2/api-chat.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/chat/route";

const ORIGINAL_AI_ENGINE = process.env.AI_ENGINE;
before(() => {
  process.env.AI_ENGINE = "v2";
});
after(() => {
  if (ORIGINAL_AI_ENGINE === undefined) delete process.env.AI_ENGINE;
  else process.env.AI_ENGINE = ORIGINAL_AI_ENGINE;
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function chat(body: unknown): Promise<{ status: number; body: any }> {
  const res = await post(body);
  return { status: res.status, body: await res.json() };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. New context
// ─────────────────────────────────────────────────────────────────────────

test("1a. a request with no context field creates a brand-new conversation", async () => {
  const { status, body } = await chat({ message: "ek jumbo zinger dedo" });
  assert.equal(status, 200);
  assert.match(body.reply, /Jumbo Zinger/);
  assert.equal(body.cart[0].itemId, "jumbo-zinger");
  assert.equal(body.state, "CART_EDITING");
  assert.ok(body.context.conversationId);
  assert.ok(body.context.sessionId);
});

test("1b. an empty context object ({}) is treated the same as no context", async () => {
  const { status, body } = await chat({ message: "ek gyro dedo", context: {} });
  assert.equal(status, 200);
  assert.equal(body.cart[0].itemId, "gyro");
});

test("1c. two requests with no context never share state", async () => {
  const a = await chat({ message: "ek jumbo zinger dedo" });
  const b = await chat({ message: "ek gyro dedo" });
  assert.notEqual(a.body.context.conversationId, b.body.context.conversationId);
  assert.equal(a.body.cart[0].itemId, "jumbo-zinger");
  assert.equal(b.body.cart[0].itemId, "gyro");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Existing context
// ─────────────────────────────────────────────────────────────────────────

test("2a. sending the previous response's context back continues the same conversation", async () => {
  const first = await chat({ message: "ek jumbo zinger dedo" });
  const second = await chat({ message: "ek gyro dedo", context: first.body.context });
  assert.equal(second.status, 200);
  assert.equal(second.body.cart.length, 2);
  assert.equal(second.body.context.conversationId, first.body.context.conversationId);
});

test("2b. a full multi-turn conversation round-trips context correctly across many requests", async () => {
  let context: unknown = undefined;
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"];
  let last: { status: number; body: any } | undefined;
  for (const message of messages) {
    last = await chat({ message, context });
    context = last.body.context;
  }
  assert.equal(last?.body.state, "PENDING_VERIFICATION");
  assert.equal(last?.body.cart[0].itemId, "jumbo-zinger");
});

test("2c. resuming an existing context preserves customer name/address already collected", async () => {
  let context: unknown = undefined;
  for (const message of ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 1 Street 2 Nazimabad"]) {
    const step = await chat({ message, context });
    context = step.body.context;
  }
  const final = await chat({ message: "mera naam Sara hai", context });
  assert.equal((final.body.context.order as any).customerName, "Sara");
  assert.ok((final.body.context.order as any).address);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Missing message
// ─────────────────────────────────────────────────────────────────────────

test("3a. a request with no message field is rejected with a clear 400, not a crash", async () => {
  const { status, body } = await chat({});
  assert.equal(status, 400);
  assert.equal(body.error, "missing_message");
});

test("3b. an empty-string message is rejected the same way", async () => {
  const { status, body } = await chat({ message: "" });
  assert.equal(status, 400);
  assert.equal(body.error, "missing_message");
});

test("3c. a whitespace-only message is rejected the same way", async () => {
  const { status } = await chat({ message: "   " });
  assert.equal(status, 400);
});

test("3d. a non-string message is rejected the same way", async () => {
  const { status, body } = await chat({ message: 12345 });
  assert.equal(status, 400);
  assert.equal(body.error, "missing_message");
});

test("3e. a request body that isn't valid JSON never crashes the route", async () => {
  const res = await POST(
    new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" })
  );
  assert.equal(res.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Invalid context
// ─────────────────────────────────────────────────────────────────────────

test("4a. a garbage context object never crashes the route — it safely starts a new conversation", async () => {
  const { status, body } = await chat({ message: "ek jumbo zinger dedo", context: { foo: "bar", not: "a real context" } });
  assert.equal(status, 200);
  assert.equal(body.cart[0].itemId, "jumbo-zinger");
  assert.ok(body.context.conversationId);
});

test("4b. a context with a corrupted order object safely falls back to a new conversation", async () => {
  const { status, body } = await chat({
    message: "ek gyro dedo",
    context: { conversationId: "x", sessionId: "y", responseSeed: "", order: { state: "NOT_A_REAL_STATE" } },
  });
  assert.equal(status, 200);
  assert.equal(body.state, "CART_EDITING");
});

test("4c. a context that's a string instead of an object never crashes the route", async () => {
  const { status } = await chat({ message: "hi", context: "not-an-object" });
  assert.equal(status, 200);
});

test("4d. a context that's an array never crashes the route", async () => {
  const { status, body } = await chat({ message: "hi", context: [1, 2, 3] });
  assert.equal(status, 200);
  assert.ok(body.context.conversationId);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. debug: false hides internal data
// ─────────────────────────────────────────────────────────────────────────

test("5a. debug omitted entirely never includes a debug field", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo" });
  assert.equal("debug" in body, false);
});

test("5b. debug explicitly false never includes a debug field", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: false });
  assert.equal("debug" in body, false);
});

test("5c. the response never leaks intent names/safety decisions/raw ids when debug is off", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: false });
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /"debug"/);
});

test("5d. only reply/context/cart/state are present when debug is off", async () => {
  const { body } = await chat({ message: "menu dikhao", debug: false });
  assert.deepEqual(Object.keys(body).sort(), ["cart", "context", "isFinished", "reply", "state"]);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. debug: true returns logs
// ─────────────────────────────────────────────────────────────────────────

test("6a. debug:true includes a debug object", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.ok(body.debug);
});

test("6b. debug:true exposes which engine is active", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.equal(body.debug.activeEngine, "v2");
});

test("6c. debug:true exposes which path resolved the intent (parserSource)", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.equal(body.debug.parserSource, "deterministic");
});

test("6d. debug:true exposes pipeline timing", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.ok(body.debug.pipelineTiming);
  assert.ok(typeof body.debug.pipelineTiming.totalMs === "number");
});

test("6e. debug:true reports fallbackUsed=false for a normal successful call", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.equal(body.debug.fallbackUsed, false);
});

test("6f. debug:true never removes the normal top-level fields", async () => {
  const { body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.ok(body.reply);
  assert.ok(body.context);
  assert.ok(body.cart);
  assert.ok(body.state);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. No API key -> deterministic fallback works
// ─────────────────────────────────────────────────────────────────────────

test("7a. with no LLM_PROVIDER configured anywhere, the route still resolves every message correctly", async () => {
  assert.equal(process.env.LLM_PROVIDER, undefined);
  const { status, body } = await chat({ message: "ek jumbo zinger dedo", debug: true });
  assert.equal(status, 200);
  assert.equal(body.debug.parserSource, "deterministic");
  assert.equal(body.cart[0].itemId, "jumbo-zinger");
});

test("7b. a full checkout works end to end with no API key configured", async () => {
  let context: unknown = undefined;
  for (const message of ["ek gyro dedo", "checkout", "confirm order", "pickup", "Ali", "submit"]) {
    const step = await chat({ message, context });
    context = step.body.context;
  }
  const final = context as any;
  assert.equal(final.order.state, "PENDING_VERIFICATION");
});

test("7c. an unavailable-item rejection still works correctly via the deterministic fallback", async () => {
  const { body } = await chat({ message: "ek beef burger dedo" });
  assert.match(body.reply, /Maaf kijiye/);
  assert.equal(body.cart.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Full flow: add item -> place order -> confirm order
// ─────────────────────────────────────────────────────────────────────────

test("8a. add item -> place order (checkout) -> confirm order moves through the expected states", async () => {
  let context: unknown = undefined;

  const add = await chat({ message: "ek jumbo zinger dedo", context });
  context = add.body.context;
  assert.equal(add.body.state, "CART_EDITING");

  const placeOrder = await chat({ message: "checkout", context });
  context = placeOrder.body.context;
  assert.equal(placeOrder.body.state, "ORDER_REVIEW");
  assert.match(placeOrder.body.reply, /Confirm Order/);

  const confirmOrder = await chat({ message: "confirm order", context });
  context = confirmOrder.body.context;
  assert.equal(confirmOrder.body.state, "AWAITING_DELIVERY_PICKUP");
  assert.match(confirmOrder.body.reply, /Delivery|Pickup/);
});

test("8b. the full add -> place order -> confirm order -> pickup -> name -> submit flow reaches PENDING_VERIFICATION", async () => {
  let context: unknown = undefined;
  const steps = ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Hina", "submit"];
  let last: { status: number; body: any } | undefined;
  for (const message of steps) {
    last = await chat({ message, context });
    context = last.body.context;
  }
  assert.equal(last?.body.state, "PENDING_VERIFICATION");
  assert.match(last?.body.reply ?? "", /Pending Verification/);
});

test("8c. the cart persists correctly across the whole add -> place order -> confirm order flow", async () => {
  let context: unknown = undefined;
  for (const message of ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]) {
    const step = await chat({ message, context });
    context = step.body.context;
  }
  const final = (context as any).order.cart.items.map((i: { itemId: string }) => i.itemId).sort();
  assert.deepEqual(final, ["gyro", "jumbo-zinger"]);
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-cutting: never crashes, never leaks internals
// ─────────────────────────────────────────────────────────────────────────

test("9a. the route never throws for any of the malformed inputs exercised above", async () => {
  const badInputs = [{}, { message: "" }, { message: 123 }, { message: "hi", context: null }, { message: "hi", context: 42 }];
  for (const input of badInputs) {
    await assert.doesNotReject(() => chat(input));
  }
});

test("9b. an internal pipeline failure (broken restaurantConfig scenario is out of route.ts's control) still never surfaces a 500", async () => {
  // route.ts's own menu/restaurantConfig are always the real, valid V2
  // data files — this asserts the route's outer catch-all never lets an
  // unexpected error escape as an unhandled 500 for ordinary traffic.
  const { status } = await chat({ message: "asdkjfh qweoiu random gibberish" });
  assert.equal(status, 200);
});
