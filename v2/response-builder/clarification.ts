// Clarification prompts (safety layer flagged an ambiguous request) and the
// visually identical "show me the options" browse reply (SHOW_OPTIONS) —
// both are "here's a list of items to choose from", just triggered
// differently upstream.

import type { PendingClarificationContext } from "../types/order";
import type { MenuItem } from "../types/menu";
import { bulletList, joinParagraphs } from "./formatter";

function titleCase(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

export function buildClarificationReply(pending: PendingClarificationContext): string {
  const question = `Aap kaunsa ${titleCase(pending.category)} chahenge?`;
  const options = bulletList(pending.options.map((o) => o.name));
  return joinParagraphs(question, `Available Options:\n${options}`);
}

// The reply named something real but from OUTSIDE the pending category
// (e.g. "club" while "which pasta?" is pending) — say so explicitly rather
// than silently adding it or just repeating the question with no context.
export function buildClarificationUnavailableReply(pending: PendingClarificationContext): string {
  const notice = `Yeh option ${titleCase(pending.category)} mein available nahi hai. Meherbani karke listed options mein se select karein.`;
  const options = bulletList(pending.options.map((o) => o.name));
  return joinParagraphs(notice, `Available Options:\n${options}`);
}

export function buildCategoryOptionsReply(categoryLabel: string, options: MenuItem[]): string {
  if (options.length === 0) {
    return `Maaf kijiye, ${categoryLabel} se related koi item nahi mila.`;
  }
  const heading = `${titleCase(categoryLabel)} mein yeh options available hain:`;
  return joinParagraphs(heading, bulletList(options.map((o) => o.name)));
}

// Shown ahead of the clarification question when a checkout-flow message
// (checkout/confirm/delivery/pickup/address/name) arrives while a
// clarification is still pending — the attempt is blocked, not silently
// ignored, and the customer is told exactly why.
export const CLARIFICATION_BLOCKS_CHECKOUT_NUDGE =
  "Checkout se pehle neeche diya gaya sawal clear kar dein:";
