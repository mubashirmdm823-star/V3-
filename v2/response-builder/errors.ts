// Customer-facing error/rejection replies. Professional Roman Urdu only —
// never exposes the internal safety decision, intent name, or any other
// technical reason for the rejection.

// An empty/whitespace query must never leave a blank slot in the reply
// ("Aapki cart mein  maujood nahi hai." — the QA simulator's malformed-
// reply finding).
function labelOrGeneric(query: string): string {
  return query.trim() || "yeh item";
}

export function unavailableItemMessage(query: string): string {
  return `Maaf kijiye, ${labelOrGeneric(query)} hamare menu mein maujood nahi hai.`;
}

export function itemNotInCartMessage(query: string): string {
  return `Aapki cart mein ${labelOrGeneric(query)} maujood nahi hai.`;
}

export function unknownRequestMessage(): string {
  return "Maaf kijiye, main aapki request samajh nahi saka. Barah-e-meherbani dobara batayein.";
}

export function invalidQuantityMessage(): string {
  return "Maaf kijiye, quantity update nahi ho saki. Barah-e-meherbani sahi quantity batayein.";
}

export function invalidReplacementMessage(): string {
  return "Maaf kijiye, item replace nahi ho saka. Barah-e-meherbani item ka sahi naam batayein.";
}

export function invalidCheckoutStepMessage(): string {
  return "Is waqt yeh action possible nahi hai. Barah-e-meherbani order review ya checkout process follow karein.";
}
