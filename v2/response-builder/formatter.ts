// Shared low-level formatting: currency, the small approved emoji set, and
// paragraph joining. Every other response-builder file goes through these
// rather than formatting numbers/emoji ad hoc, so the whole layer stays
// visually consistent.

export function formatCurrency(amount: number): string {
  return `PKR ${Math.round(amount)}`;
}

// Deliberately small — "very limited emojis... no emoji spam."
export const EMOJI = {
  success: "✅",
  location: "📍",
  phone: "📞",
  delivery: "🚚",
} as const;

// Joins non-empty paragraphs with exactly one blank line between them —
// this is what "no extra blank lines" means in practice: sections are
// separated once, lines within a section are not.
export function joinParagraphs(...paragraphs: (string | undefined | null)[]): string {
  return paragraphs
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join("\n\n");
}

export function bulletList(lines: string[]): string {
  return lines.map((line) => `• ${line}`).join("\n");
}
