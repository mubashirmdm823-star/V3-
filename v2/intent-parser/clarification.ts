// V2 clarification message builders (Roman Urdu / Hinglish), used by the
// safety layer whenever a decision is ASK_CLARIFICATION or a rejection that
// needs to be explained back to the customer. Pure string formatting only —
// no cart/menu mutation happens here.

import type { MenuItem } from "../types/menu";

export function clarifyItemOptions(categoryLabel: string, options: MenuItem[]): string {
  const lines = options.map((o) => `- ${o.name}`).join("\n");
  return `Aap kaunsa ${categoryLabel} chahenge?\n\nOptions:\n${lines}`;
}

export function clarifyCategoryChoice(categoryLabel: string): string {
  return `Aap ${categoryLabel} mein kaunsa option chahenge?`;
}

export function clarifyUnclearMessage(): string {
  return "Main is request ko clear nahi samajh saka. Meherbani karke item ka naam dobara likhein.";
}

export function itemNotInCartMessage(itemLabel: string): string {
  return `Aapki cart mein ${itemLabel} maujood nahi hai.`;
}

export function itemUnavailableMessage(itemLabel: string): string {
  return `Maaf kijiye, ${itemLabel} hamare menu mein maujood nahi hai.`;
}
