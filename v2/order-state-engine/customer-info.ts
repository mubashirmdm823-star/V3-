// Narrow, state-gated extraction of a customer's address/name reply.
//
// This is NOT general NLU — it never classifies what the customer wants or
// resolves menu items. It only runs when the current OrderState (not
// language) already tells us the next message is supposed to answer "what's
// your address" or "what's your name", and extracts/validates that specific
// value from the reply text.

const ADDRESS_REJECT_WORDS = new Set([
  "ok", "okay", "k", "kk", "yes", "yeah", "yep", "no", "nah",
  "hello", "hi", "hey", "abc", "asdf", "same", "wait", "hmm",
]);

export function isValidAddressReply(rawMessage: string): boolean {
  const trimmed = rawMessage.trim().toLowerCase();
  if (!trimmed) return false;
  if (ADDRESS_REJECT_WORDS.has(trimmed)) return false;

  // A plausible address has some real substance — a bare filler word is
  // never one, regardless of what it is.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 && trimmed.length < 8) return false;

  return true;
}

const NAME_PATTERNS: RegExp[] = [
  // "hai"/"he" are both common Roman Urdu spellings of the same verb ("is") —
  // "mera naam Fahad Mughal he" is as valid as "...hai". "naam"/"name" are
  // likewise interchangeable in Roman Urdu/Hinglish ("mera name Ali hai").
  /mera\s+(?:naam|name)\s+(.+?)\s+(?:hai|he)\b/i,
  /my name is\s+(.+)/i,
  /main\s+(.+?)\s+hun\b/i,
  /^naam[:\s]+(.+)/i,
];

const NAME_REJECT_WORDS = new Set([
  "ok", "okay", "yes", "yeah", "no", "nah", "hello", "hi", "hey",
  "done", "submit", "wait", "same", "menu", "cart",
]);

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Returns the extracted name, or null if the reply doesn't look like one.
// Only ever called while OrderState === AWAITING_NAME.
export function extractCustomerName(rawMessage: string): string | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;

  for (const pattern of NAME_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const captured = match[1].trim();
      if (captured) return titleCase(captured);
    }
  }

  // Bare reply, e.g. just "Bilal" — accept only if it plausibly IS a name:
  // 1-3 letters-only words, not a generic filler/reject word.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (
    words.length >= 1 &&
    words.length <= 3 &&
    words.every((w) => /^[a-zA-Z]+$/.test(w)) &&
    !NAME_REJECT_WORDS.has(trimmed.toLowerCase())
  ) {
    return titleCase(trimmed);
  }

  return null;
}
