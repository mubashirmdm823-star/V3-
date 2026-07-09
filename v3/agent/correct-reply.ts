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

// Production Stabilization Mode, multi-variant clarification resolution:
// when a customer's single answer resolves 2+ SIBLING variants of the
// same originally-ambiguous item together (e.g. "dono flavour 3 kardo" —
// both flavors, 3 each — resolving BOTH Chicken Chowmein and Vegetable
// Chowmein from the same pending Noodles question; see actions.ts's
// applyAgentActions grouping fix for how both mentions land together),
// Gemini's own drafted wording is unreliable — a live bug showed it
// literally name the same variant twice ("3 Vegetable Chowmein aur 3
// Vegetable Chowmein"). Detected purely from the EXISTING
// facts.resolvedAmbiguities (no new fact needed): 2+ entries are MUTUAL
// siblings when each one's chosenName appears in the OTHER's
// rejectedNames — meaning they came from resolving the SAME pending
// option set together, never two independent, unrelated resolutions (e.g.
// "5 pasta ek chowmein" -> "small chicken" resolves two DIFFERENT
// categories in the same turn — never mutual siblings, so that
// already-working scenario is untouched). Always replaces the whole reply
// with the real, backend-verified current cart — the definitively-known
// facts always win over a guessed wording, same posture as every other
// correction in this file.
function isMultiVariantSiblingResolution(resolvedAmbiguities: TurnFacts["resolvedAmbiguities"]): boolean {
  if (resolvedAmbiguities.length < 2) return false;
  return resolvedAmbiguities.some((a, i) =>
    resolvedAmbiguities.some((b, j) => i !== j && a.rejectedNames.includes(b.chosenName) && b.rejectedNames.includes(a.chosenName))
  );
}

function renderMultiVariantResolutionSummary(cart: TurnFacts["cartAfter"], menu: Menu): string {
  const lines = cart.items.map((line) => `• ${line.name} ×${line.qty} — PKR ${line.price * line.qty}`).join("\n");
  const total = realSubtotal(cart, menu);
  return `Cart update ho gaya.\n\nAapka current cart:\n${lines}\n\nTotal: PKR ${total}\n\nKya aap kuch aur add karna chahenge ya checkout karna hai?`;
}

function correctMultiVariantResolution(reply: string, facts: TurnFacts, menu: Menu): string {
  if (!isMultiVariantSiblingResolution(facts.resolvedAmbiguities)) return reply;
  return renderMultiVariantResolutionSummary(facts.cartAfter, menu);
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
  out = correctMultiVariantResolution(out, facts, menu);
  out = correctCartMutationBlocked(out, facts);
  return out;
}
