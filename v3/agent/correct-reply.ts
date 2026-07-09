// V3 one-call agent — bounded, deterministic reply correction.
//
// Gemini writes the customer-facing reply in the SAME call that decides
// the cart actions, so it drafts the wording before those actions actually
// execute against the real cart/menu. This file is the one and only place
// that patches the draft against what actually happened — a handful of
// explicit, narrowly-scoped checks, never a second LLM call and never a
// generic "rewrite the whole reply" step.

import { realSubtotal, type TurnFacts } from "./actions";
import type { Menu } from "../../v2/types/menu";
import { normalizeCurrency } from "./reply-normalizer";
import { CART_LOCKED_DURING_CHECKOUT_REPLY } from "./checkout-guard";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces a total/subtotal figure the model guessed with the REAL cart
// total — scoped to the word "total"/"subtotal"/"grand total" so an
// unrelated per-item price mention is never touched.
function correctTotal(reply: string, cart: TurnFacts["cartAfter"], menu: Menu): string {
  const real = realSubtotal(cart, menu);
  return reply.replace(
    /\b(total|subtotal|grand total)\b([^\d]{0,20})(?:PKR\s*\d+(?:\.\d+)?|Rs\.?\s*\d+(?:\.\d+)?)/gi,
    (_match, word: string, between: string) => `${word}${between}PKR ${real}`
  );
}

// If a menu-wide-ambiguous query got resolved to a specific item this turn
// (see actions.ts#resolveAgainstPending), Gemini drafted its reply BEFORE
// that resolution happened and may have named a different candidate from
// the same family (e.g. "Mexican Sandwich" instead of the actually-added
// "Mexican Pasta white sauce"). Swap any mention of a rejected candidate's
// name for the real, chosen one — never a blind global rename, only among
// names that were literally candidates for the SAME resolution this turn.
function correctAmbiguousNames(reply: string, resolvedAmbiguities: TurnFacts["resolvedAmbiguities"]): string {
  let out = reply;
  for (const { chosenName, rejectedNames } of resolvedAmbiguities) {
    for (const rejected of rejectedNames) {
      if (rejected === chosenName) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(rejected)}\\b`, "gi");
      out = out.replace(pattern, chosenName);
    }
  }
  return out;
}

function titleCase(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

// A reply drafted before backend resolution can confidently claim success
// for something that actually got rejected (named something outside the
// pending category entirely) — a wrong claim is worse than none, so this
// structured, definitively-known outcome always wins over whatever Gemini
// guessed, exactly like the equivalent, already-shipped V2 message.
function correctClarificationOutcome(reply: string, facts: TurnFacts): string {
  if (!facts.clarificationRejected) return reply;
  const { category, options } = facts.clarificationRejected;
  const optionNames = options.map((o) => o.name).join(", ");
  return `Yeh option ${titleCase(category)} mein available nahi hai. Meherbani karke in options mein se select karein: ${optionNames}.`;
}

// If an item genuinely doesn't exist on the menu at all, same rule: the
// definitively-known "not on the menu" fact always wins over a guessed
// success claim.
function correctUnavailable(reply: string, facts: TurnFacts): string {
  if (facts.unavailableQueries.length === 0 || facts.addedLines.length > 0) return reply;
  const names = facts.unavailableQueries.join(", ");
  return `${names} hamare menu mein available nahi hai. Baqi items mein se kuch order karna chahenge?`;
}

// Queue-lifecycle bug fix, wording half: while resolving a multi-item
// clarification, the model sometimes drafted checkout-confirmation-shaped
// language ("Aapka order confirm ho gaya hai...") for what was actually
// just a cart mutation — no checkout action of any kind happened this
// turn. "Order confirm ho gaya" must never be said until the real
// checkout-confirmation stage (facts.checkoutApplied === "confirm_order",
// verified by the reply-orchestrator/fact-verifier layer this file doesn't
// touch); this is the narrow, definitively-known-false-claim correction
// for everything else, same posture as every other function in this file.
const FALSE_CHECKOUT_CONFIRMATION_PATTERN = /\b(order\s+)?confirm\s+ho\s+gay[ai]\b/i;

function correctFalseCheckoutConfirmation(reply: string, facts: TurnFacts): string {
  if (facts.checkoutApplied === "confirm_order") return reply;
  if (!FALSE_CHECKOUT_CONFIRMATION_PATTERN.test(reply)) return reply;
  return facts.addedLines.length > 0
    ? "Aapke selected items cart mein add kar diye gaye hain."
    : "Aapka cart update kar diya gaya hai.";
}

// Production Stabilization Mode, rule #3 ("current order rendering"): a
// reply that CLAIMS to show the current order/order review is exactly as
// dishonest as a false "added" claim if it doesn't actually list any
// priced items — a live bug showed the model draft "Aapka order ab kuch is
// tarah hai:" followed by nothing at all. Replaces the whole reply with
// the real, backend-verified itemized cart + total whenever the claim
// isn't backed up by actual priced lines; never fires on a reply that
// already has priced lines (never overrides working phrasing).
const ORDER_CLAIM_PATTERN = /\bcurrent\s*order\b|\border\s*ab\s*kuch\s*is\s*tarah\s*hai\b|\border\s*review\b/i;

function hasAnyPricedLine(text: string): boolean {
  return text.split("\n").some((line) => /PKR\s*\d+/.test(line));
}

function correctIncompleteOrderClaim(reply: string, facts: TurnFacts, menu: Menu): string {
  if (!ORDER_CLAIM_PATTERN.test(reply)) return reply;
  if (hasAnyPricedLine(reply)) return reply;
  if (facts.cartAfter.items.length === 0) return "Aapka cart abhi khali hai. Kuch order karna chahenge?";
  const lines = facts.cartAfter.items.map((line) => `• ${line.name} × ${line.qty} — PKR ${line.price * line.qty}`).join("\n");
  return `Aapka current order yeh hai:\n${lines}\n\nTotal: PKR ${realSubtotal(facts.cartAfter, menu)}`;
}

// Production Stabilization Mode, cart-update reply fix: Gemini drafts its
// reply BEFORE the backend actually applies the cart mutation, so it can
// say something no longer true by the time the customer sees it — from
// naming the wrong sibling variant when 2+ queued clarifications resolve
// together (a live bug showed the same variant named twice, "3 Vegetable
// Chowmein aur 3 Vegetable Chowmein") to premature/in-progress wording
// ("... add kar raha hoon") for an item that is already, definitively
// added (another live bug: "ek pasta kardo" -> "mexican" replied "Mexican
// Pasta white sauce add kar raha hoon" instead of the real, priced cart —
// note this specific case never even touches the formal
// AWAITING_CLARIFICATION queue: the model resolved the earlier
// spoken-only question and drafted an already-specific add_item query in
// one step, so facts.resolvedAmbiguities is empty here and only
// facts.addedLines — the real cart diff, populated for every successful
// add regardless of how it happened — proves it). Always replaces the
// whole reply with the real, backend-verified current cart — the
// definitively-known facts always win over a guessed wording, same posture
// as every other correction in this file.
function renderCartUpdateSummary(cart: TurnFacts["cartAfter"], menu: Menu): string {
  const lines = cart.items.map((line) => `• ${line.name} ×${line.qty} — PKR ${line.price * line.qty}`).join("\n");
  const total = realSubtotal(cart, menu);
  return `Cart update ho gaya.\n\nAapka current cart:\n${lines}\n\nTotal: PKR ${total}\n\nKya aap kuch aur add karna chahenge ya checkout karna hai?`;
}

// Case 1: a pending clarification ("which pasta?"/"which zinger?") was
// resolved and applied this turn — detected from the EXISTING
// facts.resolvedAmbiguities (no new fact needed), non-empty whether the
// answer resolved a single item ("mexican") or several at once ("dono
// flavour 3 kardo", "5 pasta ek chowmein").
function correctClarificationResolution(reply: string, facts: TurnFacts, menu: Menu): string {
  if (facts.resolvedAmbiguities.length === 0) return reply;
  return renderCartUpdateSummary(facts.cartAfter, menu);
}

// Case 2: the draft literally claims an add is still IN PROGRESS ("add kar
// raha hoon" / "add karwa raha hoon") while facts.addedLines proves the
// backend already, definitively completed it this turn — the narrow,
// literal phrasing the rule targets, never a general "always summarize the
// cart after any add" rule (that would rewrite every ordinary, already-
// accurate past-tense add confirmation elsewhere in this codebase).
const PREMATURE_ADD_CLAIM_PATTERN = /\badd\s*kar(?:wa)?\s*raha\s*h(?:oon|un)\b/i;

function correctPrematureAddClaim(reply: string, facts: TurnFacts, menu: Menu): string {
  if (facts.addedLines.length === 0) return reply;
  if (!PREMATURE_ADD_CLAIM_PATTERN.test(reply)) return reply;
  return renderCartUpdateSummary(facts.cartAfter, menu);
}

// Production Stabilization Mode, rule #4 (checkout mutation lock): if
// actions.ts blocked a cart mutation because the customer was already past
// ORDER_REVIEW into an actual checkout step, the reply must say so
// honestly — never trust whatever the model drafted for an action that
// never executed. Always the LAST correction: an attempted-but-blocked
// mutation is a more important fact than any other wording issue the
// draft might have.
function correctCartMutationBlocked(reply: string, facts: TurnFacts): string {
  return facts.cartMutationBlocked ? CART_LOCKED_DURING_CHECKOUT_REPLY : reply;
}

export function correctReply(reply: string, facts: TurnFacts, menu: Menu): string {
  let out = normalizeCurrency(reply);
  out = correctTotal(out, facts.cartAfter, menu);
  out = correctAmbiguousNames(out, facts.resolvedAmbiguities);
  out = correctClarificationOutcome(out, facts);
  out = correctUnavailable(out, facts);
  out = correctFalseCheckoutConfirmation(out, facts);
  out = correctIncompleteOrderClaim(out, facts, menu);
  out = correctClarificationResolution(out, facts, menu);
  out = correctPrematureAddClaim(out, facts, menu);
  out = correctCartMutationBlocked(out, facts);
  return out;
}
