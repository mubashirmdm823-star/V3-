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

export function correctReply(reply: string, facts: TurnFacts, menu: Menu): string {
  let out = normalizeCurrency(reply);
  out = correctTotal(out, facts.cartAfter, menu);
  out = correctAmbiguousNames(out, facts.resolvedAmbiguities);
  out = correctClarificationOutcome(out, facts);
  out = correctUnavailable(out, facts);
  return out;
}
