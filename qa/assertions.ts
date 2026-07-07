// QA phase 14A — the assertion layer.
//
// Two kinds of checks, deliberately separated:
//
// 1. UNIVERSAL INVARIANTS — run on EVERY turn regardless of what was asked:
//    the pipeline never crashed, the reply never leaks internals, the cart
//    shape is legal, printed totals match recomputed menu-price totals,
//    state values are legal, pendingClarification is consistent with the
//    state, an address stage implies delivery was chosen. A violation here
//    is always a bug.
//
// 2. EXPECTATION CHECKS — judged against what the generated customer meant,
//    CONDITIONALLY on the real `before` context (not on what the generator
//    predicted). E.g. a "remove X" turn only demands X disappear if X was
//    actually in the cart when the message was sent; if an earlier
//    corrupted add never landed, the correct behavior is a polite
//    rejection, and that's what gets asserted instead. This keeps a single
//    genuinely-misunderstood turn from cascading into dozens of phantom
//    "failures" downstream.
//
// Tier semantics (see qa/scenario-library.ts): strict misses are bugs;
// natural/corrupted misses only lower the understanding-rate statistic —
// but a WRONG action (different item added, wrong quantity, silent
// resolution of an ambiguous phrase) is a bug at every tier.

import type { Menu } from "../v2/types/menu";
import type { OrderContext, OrderState } from "../v2/types/order";
import type { CartState } from "../v2/types/cart";
import type { ProcessMessageResult } from "../v2/core/result";
import { calculateTotal } from "../v2/cart-engine/totals";
import { allItems } from "./scenario-library";
import type { Tier, InfoTopic, ScenarioStep } from "./scenario-library";
import type { Language } from "./customer-generator";

export type StepOp = ScenarioStep["op"];

export interface TurnExpectation {
  op: StepOp;
  tier: Tier;
  templateId: string;
  language: Language;
  itemId?: string;
  qty?: number;
  fromItemId?: string;
  toItemId?: string;
  categoryKey?: string;
  phrase?: string;
  infoTopic?: InfoTopic;
  replyMustContainOneOf?: string[];
  sentText?: string; // exact address/name text sent, for stored-value checks
  allowedItemIds?: string[]; // acceptable resolutions for loose-tier adds
  noiseInjected?: boolean; // personality-injected turn, not part of the scenario core
}

export type FailureCode =
  | "PIPELINE_CRASH_RECOVERED"
  | "REPLY_EMPTY"
  | "REPLY_MALFORMED"
  | "REPLY_LEAKS_INTERNALS"
  | "REPLY_CLAIMS_ADD_WITHOUT_ADD"
  | "CART_CHANGE_NOT_ACKNOWLEDGED"
  | "PRINTED_TOTAL_MISMATCH"
  | "CART_SHAPE_INVALID"
  | "CART_PRICE_NAME_MISMATCH"
  | "CART_DUPLICATE_LINES"
  | "WRONG_ITEM_ADDED"
  | "WRONG_QUANTITY_ADDED"
  | "STRICT_ADD_MISSED"
  | "STRICT_REMOVE_MISSED"
  | "REMOVE_WRONG_ITEM"
  | "STRICT_REPLACE_MISSED"
  | "REPLACE_TURNED_INTO_ADD"
  | "STRICT_CHANGE_QTY_MISSED"
  | "REMOVE_ALL_MISSED"
  | "AMBIGUOUS_SILENTLY_RESOLVED"
  | "CLARIFICATION_NOT_OPENED"
  | "CLARIFICATION_ANSWER_MISSED"
  | "CLARIFICATION_WRONG_QTY"
  | "STATE_ILLEGAL_VALUE"
  | "STATE_UNEXPECTED"
  | "PENDING_CLARIFICATION_INCONSISTENT"
  | "ADDRESS_STAGE_WITHOUT_DELIVERY"
  | "STORED_ADDRESS_MISMATCH"
  | "STORED_NAME_MISMATCH"
  | "FINISHED_WITH_EMPTY_CART"
  | "CHECKOUT_STAGE_MISSED"
  | "INFO_MISSING_FROM_REPLY"
  | "PRICE_MISSING_FROM_REPLY"
  | "CART_MUTATED_BY_NON_ORDER_MESSAGE"
  | "CONTEXT_ROUNDTRIP_FAILED";

export interface TurnFailure {
  code: FailureCode;
  detail: string;
}

export interface TurnCheckResult {
  failures: TurnFailure[];
  understood: boolean;
}

const VALID_STATES: ReadonlySet<string> = new Set([
  "BROWSING",
  "CART_EDITING",
  "AWAITING_CLARIFICATION",
  "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
  "PENDING_VERIFICATION",
  "CANCELLED",
]);

// Internal vocabulary that must never reach a customer. Exact tokens only —
// replies legitimately contain words like "add", "cart", "order".
const INTERNAL_TOKENS: readonly string[] = [
  "GREETING",
  "THANKS",
  "CANCEL_ORDER",
  "HUMAN_SUPPORT",
  "COMPLAINT",
  "RECOMMENDATION_REQUEST",
  "CONFUSED_CUSTOMER",
  "SMALL_TALK",
  "IRRELEVANT_QUERY",
  "GOODBYE",
  "SAFE_TO_EXECUTE",
  "ASK_CLARIFICATION",
  "REJECT_UNAVAILABLE",
  "REJECT_NOT_IN_CART",
  "NO_CART_ACTION",
  "ADD_ITEM",
  "ADD_MULTIPLE_ITEMS",
  "REMOVE_ITEM",
  "REMOVE_ALL",
  "REPLACE_ITEM",
  "CHANGE_QUANTITY",
  "CHECKOUT_START",
  "CONFIRM_ORDER",
  "SELECT_DELIVERY",
  "SELECT_PICKUP",
  "PROVIDE_ADDRESS",
  "PROVIDE_NAME",
  "ASK_RESTAURANT_INFO",
  "HYPOTHETICAL_TOTAL",
  "PRICE_QUERY",
  "SHOW_OPTIONS",
  "SHOW_MENU",
  "SHOW_CART",
  "UNKNOWN",
  "safetyDecision",
  "parseResult",
  "candidateItemIds",
  "PipelineError",
  "undefined",
  "[object Object]",
  "NaN",
];

// Reply phrasings that claim an item landed in the cart (from
// v2/response-builder/templates.ts's actual wording).
const ADD_CLAIM_PATTERN = /cart mein add kar (?:diye gaye|diya gaya)|added to (?:your )?cart/i;

export interface CartDiff {
  added: Array<{ itemId: string; name: string; qtyDelta: number }>;
  removed: Array<{ itemId: string; name: string; qtyDelta: number }>;
  changed: boolean;
}

export function diffCarts(before: CartState, after: CartState): CartDiff {
  const beforeMap = new Map(before.items.map((i) => [i.itemId, i]));
  const afterMap = new Map(after.items.map((i) => [i.itemId, i]));
  const added: CartDiff["added"] = [];
  const removed: CartDiff["removed"] = [];

  for (const [id, line] of afterMap) {
    const prev = beforeMap.get(id);
    const delta = line.qty - (prev?.qty ?? 0);
    if (delta > 0) added.push({ itemId: id, name: line.name, qtyDelta: delta });
  }
  for (const [id, line] of beforeMap) {
    const next = afterMap.get(id);
    const delta = (next?.qty ?? 0) - line.qty;
    if (delta < 0) removed.push({ itemId: id, name: line.name, qtyDelta: delta });
  }
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function cartQty(cart: CartState, itemId: string): number {
  return cart.items.find((i) => i.itemId === itemId)?.qty ?? 0;
}

// ---------------------------------------------------------------------------
// Universal invariants
// ---------------------------------------------------------------------------

export function checkInvariants(
  before: OrderContext,
  after: OrderContext,
  result: ProcessMessageResult,
  menu: Menu,
  allowRecovered: boolean
): TurnFailure[] {
  const failures: TurnFailure[] = [];
  const reply = result.reply;

  if (result.recovered && !allowRecovered) {
    failures.push({
      code: "PIPELINE_CRASH_RECOVERED",
      detail: `Pipeline recovered from a ${result.failedStage ?? "UNKNOWN"}-stage failure on a well-formed input.`,
    });
  }

  if (typeof reply !== "string" || reply.trim().length === 0) {
    failures.push({ code: "REPLY_EMPTY", detail: "Reply is empty or not a string." });
    return failures; // nothing below is meaningful without a reply
  }

  for (const token of INTERNAL_TOKENS) {
    if (reply.includes(token)) {
      failures.push({ code: "REPLY_LEAKS_INTERNALS", detail: `Reply contains internal token "${token}".` });
      break;
    }
  }

  // Two consecutive spaces mean an empty interpolation slot — e.g. the
  // not-in-cart rejection printing "Aapki cart mein  maujood nahi hai."
  // with no item name in it.
  if (/ {2}/.test(reply)) {
    failures.push({ code: "REPLY_MALFORMED", detail: "Reply contains a double space (an empty template slot)." });
  }
  // Raw menu item ids (hyphenated slugs) must never appear in replies.
  for (const item of allItems(menu)) {
    if (item.id.includes("-") && reply.includes(item.id)) {
      failures.push({ code: "REPLY_LEAKS_INTERNALS", detail: `Reply contains raw menu item id "${item.id}".` });
      break;
    }
  }

  if (!VALID_STATES.has(after.state)) {
    failures.push({ code: "STATE_ILLEGAL_VALUE", detail: `Illegal state value "${after.state}".` });
  }

  // Cart shape: integer qty >= 1, no duplicate lines, price/name faithful to
  // the menu (CartLineItem.price is a display cache — it must still match).
  const seen = new Set<string>();
  for (const line of after.cart.items) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      failures.push({ code: "CART_SHAPE_INVALID", detail: `Line "${line.itemId}" has qty ${line.qty}.` });
    }
    if (seen.has(line.itemId)) {
      failures.push({ code: "CART_DUPLICATE_LINES", detail: `Duplicate cart lines for "${line.itemId}".` });
    }
    seen.add(line.itemId);
    const menuItem = allItems(menu).find((i) => i.id === line.itemId);
    if (!menuItem) {
      failures.push({ code: "CART_SHAPE_INVALID", detail: `Cart line "${line.itemId}" is not on the menu.` });
    } else if (menuItem.price !== line.price || menuItem.name !== line.name) {
      failures.push({
        code: "CART_PRICE_NAME_MISMATCH",
        detail: `Cart line "${line.itemId}" has ${line.name}/${line.price}, menu says ${menuItem.name}/${menuItem.price}.`,
      });
    }
  }

  // Every "Total: PKR n" printed in the reply must equal the recomputed
  // menu-price total of the resulting cart.
  const totalMatches = [...reply.matchAll(/Total: PKR (\d+)/g)];
  if (totalMatches.length > 0) {
    const expected = calculateTotal(after.cart, menu).subtotal;
    for (const match of totalMatches) {
      if (Number(match[1]) !== expected) {
        failures.push({
          code: "PRINTED_TOTAL_MISMATCH",
          detail: `Reply prints "Total: PKR ${match[1]}" but the cart's menu-price total is PKR ${expected}.`,
        });
      }
    }
  }

  // pendingClarification <-> AWAITING_CLARIFICATION, both directions.
  if (after.state === "AWAITING_CLARIFICATION" && !after.pendingClarification) {
    failures.push({ code: "PENDING_CLARIFICATION_INCONSISTENT", detail: "AWAITING_CLARIFICATION with no pendingClarification." });
  }
  if (after.state !== "AWAITING_CLARIFICATION" && after.pendingClarification) {
    failures.push({ code: "PENDING_CLARIFICATION_INCONSISTENT", detail: `pendingClarification present in state ${after.state}.` });
  }

  if (after.state === "AWAITING_ADDRESS" && after.deliveryType !== "delivery") {
    failures.push({ code: "ADDRESS_STAGE_WITHOUT_DELIVERY", detail: `AWAITING_ADDRESS with deliveryType=${after.deliveryType}.` });
  }

  if (after.state === "PENDING_VERIFICATION" && after.cart.items.length === 0) {
    failures.push({ code: "FINISHED_WITH_EMPTY_CART", detail: "Order finished with an empty cart." });
  }

  // Reply/cart consistency: a claimed add must be a real add, and a real
  // cart change must be acknowledged by naming at least one affected item.
  const diff = diffCarts(before.cart, after.cart);
  if (ADD_CLAIM_PATTERN.test(reply) && diff.added.length === 0) {
    failures.push({ code: "REPLY_CLAIMS_ADD_WITHOUT_ADD", detail: "Reply claims an item was added but the cart gained nothing." });
  }
  if (diff.changed) {
    const affected = [...diff.added, ...diff.removed];
    const mentioned = affected.some((entry) => reply.toLowerCase().includes(entry.name.toLowerCase()));
    // A full cart clear is legitimately acknowledged as "cart cleared"
    // without naming every removed line.
    const clearedEverything = after.cart.items.length === 0 && diff.removed.length > 0 && diff.added.length === 0;
    const clearAcknowledged = clearedEverything && /clear|khali/i.test(reply);
    if (!mentioned && !clearAcknowledged) {
      failures.push({
        code: "CART_CHANGE_NOT_ACKNOWLEDGED",
        detail: `Cart changed (${affected.map((e) => e.itemId).join(", ")}) but the reply names none of the affected items.`,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Expectation checks — conditional on the REAL before-context.
// ---------------------------------------------------------------------------

const NON_ORDER_OPS: ReadonlySet<StepOp> = new Set([
  "greet", "showMenu", "browseCategory", "price", "showCart",
  "askInfo", "complaint", "chitchat", "invalid", "postSubmitMessage",
]);

const CHECKOUT_PHASE_STATES: ReadonlySet<OrderState> = new Set([
  "ORDER_REVIEW", "AWAITING_DELIVERY_PICKUP", "AWAITING_ADDRESS", "AWAITING_NAME", "READY_TO_SUBMIT",
]);

function expectedStateAfterCartEdit(before: OrderState): OrderState[] {
  // The documented bounce rule: first edit BROWSING->CART_EDITING; edits in
  // CART_EDITING/ORDER_REVIEW stay put; edits during any later checkout
  // stage bounce back to ORDER_REVIEW for re-confirmation. A cart edit from
  // AWAITING_CLARIFICATION may ALSO legitimately stay AWAITING_CLARIFICATION
  // now (Action Planner + Clarification Queue): adding an unrelated exact
  // item while an earlier ambiguity is still unresolved preserves that
  // queue rather than dropping it, per this phase's explicit rule.
  if (before === "BROWSING" || before === "CART_EDITING") return ["CART_EDITING"];
  if (before === "AWAITING_CLARIFICATION") return ["CART_EDITING", "AWAITING_CLARIFICATION"];
  if (CHECKOUT_PHASE_STATES.has(before)) return ["ORDER_REVIEW"];
  return ["CART_EDITING", "ORDER_REVIEW"];
}

export function checkExpectation(
  before: OrderContext,
  after: OrderContext,
  result: ProcessMessageResult,
  expectation: TurnExpectation,
  menu: Menu
): TurnCheckResult {
  const failures: TurnFailure[] = [];
  const diff = diffCarts(before.cart, after.cart);
  const strict = expectation.tier === "strict";
  let understood = true;
  const reply = typeof result.reply === "string" ? result.reply : "";

  // The conversation is over — every post-submit message may only produce a
  // sane reply, never resurrect the order. (State stays PENDING_VERIFICATION.)
  if (before.state === "PENDING_VERIFICATION" || before.state === "CANCELLED") {
    if (diff.changed) {
      failures.push({ code: "CART_MUTATED_BY_NON_ORDER_MESSAGE", detail: "Cart mutated after the order was already submitted." });
    }
    return { failures, understood };
  }

  switch (expectation.op) {
    case "add": {
      const target = expectation.itemId!;
      const wantQty = expectation.qty ?? 1;
      const gained = cartQty(after.cart, target) - cartQty(before.cart, target);
      const allowed = new Set([target, ...(expectation.allowedItemIds ?? [])]);
      const foreign = diff.added.filter((a) => !allowed.has(a.itemId));

      if (foreign.length > 0) {
        failures.push({
          code: "WRONG_ITEM_ADDED",
          detail: `Asked for "${target}", cart gained unrelated item(s): ${foreign.map((f) => f.itemId).join(", ")}.`,
        });
      }
      if (gained > 0 && gained !== wantQty) {
        failures.push({
          code: "WRONG_QUANTITY_ADDED",
          detail: `Asked for ${wantQty} × "${target}" but the cart gained ${gained}.`,
        });
      }
      if (gained !== wantQty) understood = false;
      if (strict && gained !== wantQty && foreign.length === 0) {
        failures.push({
          code: "STRICT_ADD_MISSED",
          detail: `Canonical add of ${wantQty} × "${target}" did not land (gained ${gained}). State after: ${after.state}.`,
        });
      }
      if (strict && gained === wantQty) {
        const okStates = expectedStateAfterCartEdit(before.state);
        if (!okStates.includes(after.state)) {
          failures.push({
            code: "STATE_UNEXPECTED",
            detail: `Cart edit from ${before.state} should land in ${okStates.join("/")} but landed in ${after.state}.`,
          });
        }
      }
      break;
    }

    case "addAmbiguous": {
      // Core safety rule at every tier: an ambiguous phrase must NEVER
      // silently resolve to a variant.
      if (diff.added.length > 0) {
        failures.push({
          code: "AMBIGUOUS_SILENTLY_RESOLVED",
          detail: `Ambiguous "${expectation.phrase}" silently added ${diff.added.map((a) => a.itemId).join(", ")}.`,
        });
        understood = false;
      } else if (after.state !== "AWAITING_CLARIFICATION") {
        understood = false;
        if (strict) {
          failures.push({
            code: "CLARIFICATION_NOT_OPENED",
            detail: `Ambiguous "${expectation.phrase}" should open a clarification; state is ${after.state}.`,
          });
        }
      }
      break;
    }

    case "answerClarification": {
      if (before.state !== "AWAITING_CLARIFICATION" || !before.pendingClarification) {
        // The chain never opened (earlier turn misunderstood) — only demand
        // that nothing foreign happened; the invariants cover the rest.
        understood = false;
        break;
      }
      const target = expectation.itemId!;
      const wantQty = before.pendingClarification.quantity;
      const gained = cartQty(after.cart, target) - cartQty(before.cart, target);
      const foreign = diff.added.filter((a) => a.itemId !== target);
      if (foreign.length > 0) {
        failures.push({
          code: "WRONG_ITEM_ADDED",
          detail: `Clarification answered with "${target}" but cart gained ${foreign.map((f) => f.itemId).join(", ")}.`,
        });
      }
      if (gained === 0) {
        understood = false;
        if (strict) {
          failures.push({
            code: "CLARIFICATION_ANSWER_MISSED",
            detail: `Answering the "${before.pendingClarification.category}" clarification with "${target}" added nothing. State after: ${after.state}.`,
          });
        }
      } else if (wantQty >= 1 && gained !== wantQty) {
        failures.push({
          code: "CLARIFICATION_WRONG_QTY",
          detail: `Clarification carried qty ${wantQty} but "${target}" landed with ${gained}.`,
        });
      }
      break;
    }

    case "remove": {
      const target = expectation.itemId!;
      const had = cartQty(before.cart, target) > 0;
      const stillThere = cartQty(after.cart, target) > 0;
      const foreignRemovals = diff.removed.filter((r) => r.itemId !== target);
      if (had && foreignRemovals.length > 0) {
        failures.push({
          code: "REMOVE_WRONG_ITEM",
          detail: `Asked to remove "${target}" but cart lost ${foreignRemovals.map((f) => f.itemId).join(", ")}.`,
        });
      }
      if (had && stillThere) {
        understood = false;
        if (strict) {
          failures.push({ code: "STRICT_REMOVE_MISSED", detail: `"${target}" was in the cart but a canonical remove left it there.` });
        }
      }
      if (!had && diff.changed) {
        failures.push({ code: "REMOVE_WRONG_ITEM", detail: `Removing absent "${target}" changed the cart anyway.` });
      }
      break;
    }

    case "removeAll": {
      if (before.cart.items.length > 0 && after.cart.items.length > 0) {
        understood = false;
        if (strict) {
          failures.push({ code: "REMOVE_ALL_MISSED", detail: `Clear-cart left ${after.cart.items.length} line(s) behind.` });
        }
      }
      break;
    }

    case "replace": {
      const from = expectation.fromItemId!;
      const to = expectation.toItemId!;
      const hadFrom = cartQty(before.cart, from) > 0;
      if (!hadFrom) {
        // Nothing to replace — a rejection is correct, and adding the
        // TARGET is a defensible reading of "...hata kar Y add karo" (the
        // text does ask for Y). Adding the SOURCE or anything else is not —
        // except on deliberately-damaged text, where the replace verb
        // itself may have been destroyed and an add of either named item is
        // a defensible reading.
        const allowedNoFromAdds = expectation.tier === "corrupted" ? new Set([to, from]) : new Set([to]);
        const wrongAdds = diff.added.filter((a) => !allowedNoFromAdds.has(a.itemId));
        if (wrongAdds.length > 0) {
          failures.push({ code: "WRONG_ITEM_ADDED", detail: `Replace with nothing to replace still added ${wrongAdds.map((a) => a.itemId).join(", ")}.` });
        }
        understood = false;
        break;
      }
      const fromGone = cartQty(after.cart, from) === 0;
      const toThere = cartQty(after.cart, to) > 0;
      // On deliberately-damaged text, reading the mangled message as an add
      // of either named item is a defensible interpretation — only flag
      // additions OUTSIDE the from/to pair there.
      const allowedAdds = expectation.tier === "corrupted" ? new Set([to, from]) : new Set([to]);
      const foreign = diff.added.filter((a) => !allowedAdds.has(a.itemId));
      if (foreign.length > 0) {
        failures.push({ code: "WRONG_ITEM_ADDED", detail: `Replace "${from}"->"${to}" added ${foreign.map((f) => f.itemId).join(", ")} instead.` });
      }
      // Adding the target while KEEPING the source is a wrong cart mutation
      // (the customer now has both items) — a bug on any CLEAN text (strict
      // and natural tiers), unlike a plain miss.
      if (expectation.tier !== "corrupted" && !fromGone && toThere && diff.added.some((a) => a.itemId === to)) {
        understood = false;
        failures.push({
          code: "REPLACE_TURNED_INTO_ADD",
          detail: `Replace "${from}"->"${to}" ADDED "${to}" but left "${from}" in the cart — customer now has both.`,
        });
      } else if (!(fromGone && toThere)) {
        understood = false;
        if (strict) {
          failures.push({
            code: "STRICT_REPLACE_MISSED",
            detail: `Replace "${from}"->"${to}": from ${fromGone ? "removed" : "STILL PRESENT"}, to ${toThere ? "present" : "MISSING"}.`,
          });
        }
      }
      break;
    }

    case "changeQty": {
      const target = expectation.itemId!;
      const wantQty = expectation.qty!;
      if (cartQty(before.cart, target) === 0) {
        understood = false;
        break;
      }
      const got = cartQty(after.cart, target);
      if (got !== wantQty) {
        understood = false;
        if (strict) {
          failures.push({ code: "STRICT_CHANGE_QTY_MISSED", detail: `Quantity change of "${target}" to ${wantQty} left it at ${got}.` });
        }
      }
      if (diff.added.some((a) => a.itemId !== target)) {
        failures.push({ code: "WRONG_ITEM_ADDED", detail: `Quantity change of "${target}" added other items.` });
      }
      break;
    }

    case "checkout": {
      if (before.cart.items.length === 0) {
        // Checking out an empty cart must not "succeed".
        if (CHECKOUT_PHASE_STATES.has(after.state) || after.state === "PENDING_VERIFICATION") {
          failures.push({ code: "STATE_UNEXPECTED", detail: `Empty-cart checkout advanced to ${after.state}.` });
        }
        understood = false;
        break;
      }
      if (after.state !== "ORDER_REVIEW") {
        understood = false;
        if (strict && (before.state === "CART_EDITING" || before.state === "ORDER_REVIEW" || before.state === "BROWSING")) {
          failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `Checkout from ${before.state} landed in ${after.state}, not ORDER_REVIEW.` });
        }
      }
      break;
    }

    case "confirm": {
      if (before.state !== "ORDER_REVIEW") { understood = false; break; }
      if (after.state !== "AWAITING_DELIVERY_PICKUP") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `Confirm from ORDER_REVIEW landed in ${after.state}.` });
      }
      break;
    }

    case "delivery": {
      if (before.state !== "AWAITING_DELIVERY_PICKUP") { understood = false; break; }
      if (after.state !== "AWAITING_ADDRESS" || after.deliveryType !== "delivery") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `Choosing delivery landed in ${after.state} (deliveryType=${after.deliveryType}).` });
      }
      break;
    }

    case "pickup": {
      if (before.state !== "AWAITING_DELIVERY_PICKUP") { understood = false; break; }
      if (after.state !== "AWAITING_NAME" || after.deliveryType !== "pickup") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `Choosing pickup landed in ${after.state} (deliveryType=${after.deliveryType}).` });
      }
      break;
    }

    case "address": {
      if (before.state !== "AWAITING_ADDRESS") { understood = false; break; }
      if (after.state !== "AWAITING_NAME") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `A valid address reply landed in ${after.state}, not AWAITING_NAME.` });
      } else if (strict && expectation.sentText && after.address !== expectation.sentText) {
        failures.push({ code: "STORED_ADDRESS_MISMATCH", detail: `Sent "${expectation.sentText}", stored "${after.address}".` });
      }
      break;
    }

    case "name": {
      if (before.state !== "AWAITING_NAME") { understood = false; break; }
      if (after.state !== "READY_TO_SUBMIT") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `A valid name reply landed in ${after.state}, not READY_TO_SUBMIT.` });
      } else if (strict && expectation.sentText) {
        const stored = (after.customerName ?? "").toLowerCase();
        if (!stored || !expectation.sentText.toLowerCase().includes(stored.split(" ")[0])) {
          failures.push({ code: "STORED_NAME_MISMATCH", detail: `Sent "${expectation.sentText}", stored "${after.customerName}".` });
        }
      }
      break;
    }

    case "submit": {
      if (before.state !== "READY_TO_SUBMIT") { understood = false; break; }
      if (after.state !== "PENDING_VERIFICATION") {
        understood = false;
        if (strict) failures.push({ code: "CHECKOUT_STAGE_MISSED", detail: `Submit from READY_TO_SUBMIT landed in ${after.state}.` });
      }
      break;
    }

    case "price": {
      if (expectation.replyMustContainOneOf) {
        const found = expectation.replyMustContainOneOf.some((s) => reply.includes(s));
        if (!found) {
          understood = false;
          if (strict) {
            failures.push({ code: "PRICE_MISSING_FROM_REPLY", detail: `Price reply for "${expectation.itemId}" contains none of: ${expectation.replyMustContainOneOf.join(", ")}.` });
          }
        }
      }
      break;
    }

    case "askInfo": {
      if (expectation.replyMustContainOneOf) {
        const found = expectation.replyMustContainOneOf.some((s) => reply.toLowerCase().includes(s.toLowerCase()));
        if (!found) {
          understood = false;
          if (strict) {
            failures.push({ code: "INFO_MISSING_FROM_REPLY", detail: `Info reply for "${expectation.infoTopic}" contains none of the expected facts.` });
          }
        }
      }
      break;
    }

    case "showCart": {
      // Whatever the reply says, every cart item's name should be in it —
      // but only demand that when the cart is non-empty and the turn was
      // clean (strict).
      if (strict && before.cart.items.length > 0) {
        const missing = before.cart.items.filter((i) => !reply.toLowerCase().includes(i.name.toLowerCase()));
        if (missing.length > 0) {
          understood = false;
        }
      }
      break;
    }

    default:
      break;
  }

  // Non-order messages must never mutate the cart. ("invalid" and chitchat
  // included — a gibberish message that changes the cart is a serious bug.)
  if (NON_ORDER_OPS.has(expectation.op) && diff.changed) {
    failures.push({
      code: "CART_MUTATED_BY_NON_ORDER_MESSAGE",
      detail: `A "${expectation.op}" message mutated the cart: ${JSON.stringify(diff.added.concat(diff.removed))}.`,
    });
  }

  return { failures, understood };
}

export function checkTurn(
  before: OrderContext,
  after: OrderContext,
  result: ProcessMessageResult,
  expectation: TurnExpectation,
  menu: Menu
): TurnCheckResult {
  // "invalid" inputs are the one case where an internal recovery is
  // acceptable — the pipeline surviving garbage IS the requirement.
  const allowRecovered = expectation.op === "invalid";
  const failures = [
    ...checkInvariants(before, after, result, menu, allowRecovered),
  ];
  const expectationResult = checkExpectation(before, after, result, expectation, menu);
  failures.push(...expectationResult.failures);
  return { failures, understood: expectationResult.understood };
}
