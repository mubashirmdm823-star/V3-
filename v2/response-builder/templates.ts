// Confirmation-line templates for successful cart mutations. Professional
// Roman Urdu / Hinglish, restaurant tone — these are the FIRST line of a
// reply; the order summary and dynamic ending are appended by index.ts.

import { EMOJI } from "./formatter";

export function addSingleItemConfirmation(name: string, qty: number): string {
  return `${EMOJI.success} ${qty} × ${name} cart mein add kar diye gaye hain.`;
}

export function addMultipleItemsConfirmation(): string {
  return `${EMOJI.success} Aapke items cart mein add kar diye gaye hain.`;
}

export function removeItemConfirmation(name: string): string {
  return `${EMOJI.success} ${name} cart se remove kar diya gaya hai.`;
}

export function clearCartConfirmation(): string {
  return `${EMOJI.success} Aapki cart clear kar di gayi hai.`;
}

export function replaceItemConfirmation(fromName: string, toName: string): string {
  return `${EMOJI.success} ${fromName} ki jagah ${toName} add kar diya gaya hai.`;
}

export function changeQuantityConfirmation(): string {
  return `${EMOJI.success} Quantity successfully update kar di gayi hai.`;
}

// Compound messages (e.g. "remove everything and add 1 large pizza") run
// more than one action at once — a single generic confirmation rather than
// picking just one of the per-action templates, which would misrepresent
// what actually happened.
export function cartUpdatedConfirmation(): string {
  return `${EMOJI.success} Aapki cart update kar di gayi hai.`;
}
