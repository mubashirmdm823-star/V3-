// V2 phase 9 — compact context summary for the future LLM prompt.
//
// Pure formatting over an already-built ConversationMemory — no decisions,
// no cart/state logic, just rendering the exact fields the spec asks for
// into a short, deterministic block of text.

import type { ConversationMemory } from "./memory";

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function cartSummaryLines(memory: ConversationMemory): string {
  if (memory.currentCart.items.length === 0) return "Empty";
  return memory.currentCart.items.map((line) => `${line.qty} ${line.name}`).join("\n");
}

function deliveryLine(memory: ConversationMemory): string {
  if (memory.deliveryType === "delivery") return "Delivery";
  if (memory.deliveryType === "pickup") return "Pickup";
  return "Not Yet Selected";
}

export function buildContextSummary(memory: ConversationMemory): string {
  const pendingLine = memory.pendingClarification ? "Awaiting clarification" : "None";
  const pendingClarificationLine = memory.pendingClarification
    ? titleCase(memory.pendingClarification.category)
    : "None";

  return [
    "Current State:",
    memory.currentOrderState,
    "",
    "Current Cart:",
    cartSummaryLines(memory),
    "",
    "Pending:",
    pendingLine,
    "",
    "Customer Name:",
    memory.customerName ?? "Not Yet Provided",
    "",
    "Delivery:",
    deliveryLine(memory),
    "",
    "Address:",
    memory.deliveryAddress ?? "Not Yet Provided",
    "",
    "Current Topic:",
    memory.currentTopic ? titleCase(memory.currentTopic) : "None",
    "",
    "Pending Clarification:",
    pendingClarificationLine,
  ].join("\n");
}
