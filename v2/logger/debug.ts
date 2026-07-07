// Human-readable reasoning: a one-line summary embedded in every log entry
// (reasoningSummary), and a fuller multi-line debug report built from it on
// demand. Pure string formatting — never affects the pipeline.

import type { MessageLogEntry } from "./events";

export function buildReasoningSummary(entry: Omit<MessageLogEntry, "reasoningSummary">): string {
  const parts: string[] = [];

  switch (entry.detectedIntent) {
    case "SHOW_MENU":
      parts.push("Matched a show/menu keyword; showing the full menu.");
      break;
    case "SHOW_OPTIONS":
      parts.push(`Matched a show keyword with a category reference${entry.category ? ` ("${entry.category}")` : ""}.`);
      break;
    case "SHOW_CART":
      parts.push("Matched a show-cart keyword.");
      break;
    case "PRICE_QUERY":
      parts.push("Information request about an item's price.");
      break;
    case "HYPOTHETICAL_TOTAL":
      parts.push("Information request about a hypothetical/running total.");
      break;
    case "ASK_RESTAURANT_INFO":
      parts.push("Information request about the restaurant.");
      break;
    case "ADD_ITEM":
    case "ADD_MULTIPLE_ITEMS":
      if (entry.matchedMenuItems.length > 0) {
        parts.push(`${entry.matchedMenuItems.length} exact alias(es) matched: ${entry.matchedMenuItems.join(", ")}.`);
      }
      if (entry.ambiguousMenuItems.length > 0) {
        parts.push(`Multiple candidates found for: ${entry.ambiguousMenuItems.join(", ")}.`);
      }
      if (entry.rejectedMenuItems.length > 0) {
        parts.push(`No menu match for: ${entry.rejectedMenuItems.join(", ")}.`);
      }
      break;
    case "REMOVE_ITEM":
      parts.push(
        entry.safetyDecision === "REJECT_NOT_IN_CART"
          ? "Requested item is not in the current cart."
          : "Removed the requested item from the cart."
      );
      break;
    case "REMOVE_ALL":
      parts.push("Cleared the cart.");
      break;
    case "REPLACE_ITEM":
      parts.push(
        entry.itemsReplaced.length > 0
          ? `Replaced ${entry.itemsReplaced.map((r) => `${r.from} -> ${r.to}`).join(", ")}.`
          : "Replace requested but source/target could not both be resolved."
      );
      break;
    case "CHANGE_QUANTITY":
      parts.push("Updated the quantity of an existing cart item.");
      break;
    case "CHECKOUT_START":
      parts.push("Customer started checkout.");
      break;
    case "CONFIRM_ORDER":
      parts.push("Customer confirmed the order review.");
      break;
    case "SELECT_DELIVERY":
      parts.push("Customer selected delivery.");
      break;
    case "SELECT_PICKUP":
      parts.push("Customer selected pickup.");
      break;
    case "PROVIDE_ADDRESS":
      parts.push("Customer provided a delivery address.");
      break;
    case "PROVIDE_NAME":
      parts.push("Customer provided their name.");
      break;
    case "ASK_CLARIFICATION":
      parts.push("Order-like phrasing but no resolvable item — asked for clarification.");
      break;
    case "UNKNOWN":
      parts.push("Message could not be classified.");
      break;
  }

  if (entry.safetyDecision === "ASK_CLARIFICATION" && entry.detectedIntent !== "ASK_CLARIFICATION") {
    parts.push("Safety layer required clarification before executing.");
  }

  return parts.join(" ") || "No specific reasoning recorded.";
}

function cartChanged(entry: MessageLogEntry): boolean {
  return (
    entry.itemsAdded.length > 0 ||
    entry.itemsRemoved.length > 0 ||
    entry.itemsReplaced.length > 0 ||
    entry.quantityChanges.length > 0
  );
}

// Multi-line human-readable report for a single entry — for internal
// debugging/QA only, never shown to the customer.
export function buildDebugReport(entry: MessageLogEntry): string {
  const lines = [
    `Intent: ${entry.detectedIntent}`,
    `Confidence: ${Math.round(entry.confidence * 100)}%`,
    `Reason: ${entry.reasoningSummary}`,
    `Safety: ${entry.safetyDecision}`,
    `Cart changed: ${cartChanged(entry) ? "Yes" : "No"}`,
  ];
  if (entry.errors.length > 0) lines.push(`Errors: ${entry.errors.join("; ")}`);
  if (entry.warnings.length > 0) lines.push(`Warnings: ${entry.warnings.join("; ")}`);
  if (entry.fallbacks.length > 0) lines.push(`Fallbacks: ${entry.fallbacks.join("; ")}`);
  return lines.join("\n");
}
