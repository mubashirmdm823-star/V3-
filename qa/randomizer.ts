// QA phase 14A — seeded randomness + realistic message corruption.
//
// The Rng class is the only source of randomness in qa/ (mulberry32 —
// deterministic for a given seed, so every generated conversation is
// replayable). The corruption functions turn a clean generated message into
// what real customers actually type: typos, missing/extra spaces, random
// capitalization, short forms, emoji, and voice-typing patterns.
//
// One hard rule everywhere here: DIGITS ARE NEVER CORRUPTED. Quantities are
// the one thing the assertion layer must be able to reason about even in a
// heavily-corrupted message ("2 zniger brgr plz" still unambiguously asked
// for 2), so "2" never becomes "22" or "z".

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // mulberry32
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  intBetween(minInclusive: number, maxInclusive: number): number {
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick called with an empty list");
    return items[this.int(items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

export type CorruptionStyle =
  | "none"
  | "typos"
  | "spacing"
  | "caps"
  | "shortforms"
  | "emoji"
  | "voice"
  | "heavy";

const EMOJI_POOL = ["🍕", "🍔", "😍", "🔥", "👍", "😂", "❤️", "🙏", "😋", "🤤", "✨", "🥤"];

// Word-level short forms real customers use (from live conversations and
// the task's own examples). Applied whole-word, case-insensitively.
const SHORT_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bplease\b/gi, "plz"],
  [/\bkar do\b/gi, "krdo"],
  [/\bkar dena\b/gi, "kr dena"],
  [/\bkar dein\b/gi, "krden"],
  [/\bde do\b/gi, "dedo"],
  [/\bbhej do\b/gi, "bhejdo"],
  [/\bchahiye\b/gi, "chaiye"],
  [/\baur\b/gi, "or"],
  [/\bmein\b/gi, "me"],
  [/\bbas\b/gi, "bs"],
  [/\bhai\b/gi, "h"],
  [/\byou\b/gi, "u"],
  [/\bare\b/gi, "r"],
];

const VOICE_FILLERS = ["umm", "haan to", "matlab", "acha", "bhai", "yaar", "listen"];

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

// One realistic typo inside a single word: swap two adjacent letters, drop
// a letter, or double a letter. Never the first character (customers rarely
// fumble it, and it keeps the word recognizable), never digits, and words
// of fewer than 4 letters are left alone.
export function typoWord(word: string, rng: Rng): string {
  const letters = word.split("");
  const candidateIdx: number[] = [];
  for (let i = 1; i < letters.length; i++) {
    if (isLetter(letters[i])) candidateIdx.push(i);
  }
  if (word.length < 4 || candidateIdx.length === 0) return word;

  const i = rng.pick(candidateIdx);
  const kind = rng.int(3);
  if (kind === 0 && i + 1 < letters.length && isLetter(letters[i + 1])) {
    [letters[i], letters[i + 1]] = [letters[i + 1], letters[i]];
  } else if (kind === 1) {
    letters.splice(i, 1);
  } else {
    letters.splice(i, 0, letters[i]);
  }
  return letters.join("");
}

export function applyTypos(text: string, rng: Rng, perWordRate: number): string {
  return text
    .split(" ")
    .map((w) => (rng.chance(perWordRate) ? typoWord(w, rng) : w))
    .join(" ");
}

// Spacing mistakes: drop a space (joining two words) or insert a space
// inside a word — token-wise so quantity semantics can't be manufactured:
// digit tokens, unit words ("pcs", "inch"), and any token adjacent to a
// digit are never modified and never merged. (An earlier char-wise version
// could turn "6 pcs" into "6 pc s", which legitimately READS as "quantity
// 6" — corrupting the meaning, not just the spelling, and breaking the
// header rule that quantities stay independently readable.)
const SPACING_PROTECTED_TOKENS = new Set(["pcs", "pc", "piece", "pieces", "inch", "x"]);

function isProtectedSpacingToken(token: string | undefined): boolean {
  if (!token) return false;
  return /\d/.test(token) || SPACING_PROTECTED_TOKENS.has(token.toLowerCase());
}

export function applySpacingMistakes(text: string, rng: Rng, rate: number): string {
  const tokens = text.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    const protectedHere =
      isProtectedSpacingToken(tok) || isProtectedSpacingToken(tokens[i - 1]) || isProtectedSpacingToken(tokens[i + 1]);

    // Insert a stray space inside a long-enough unprotected word.
    if (!protectedHere && tok.length >= 4 && rng.chance(rate / 2)) {
      const cut = rng.intBetween(1, tok.length - 1);
      tok = tok.slice(0, cut) + " " + tok.slice(cut);
    }
    // Join with the previous word by dropping the separating space.
    if (
      out.length > 0 &&
      !protectedHere &&
      !isProtectedSpacingToken(tokens[i - 1]) &&
      rng.chance(rate / 2)
    ) {
      out[out.length - 1] += tok;
    } else {
      out.push(tok);
    }
  }
  return out.join(" ");
}

export function applyCaps(text: string, rng: Rng, style: "lower" | "upper" | "random"): string {
  if (style === "lower") return text.toLowerCase();
  if (style === "upper") return text.toUpperCase();
  return text
    .split("")
    .map((ch) => (isLetter(ch) && rng.chance(0.3) ? (rng.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase()) : ch))
    .join("");
}

export function applyShortForms(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SHORT_FORMS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function applyEmoji(text: string, rng: Rng, count: number): string {
  let out = text;
  for (let i = 0; i < count; i++) {
    out += " " + rng.pick(EMOJI_POOL);
  }
  return rng.chance(0.3) ? rng.pick(EMOJI_POOL) + " " + out : out;
}

// Voice-typing style: all lowercase, no punctuation, occasional filler word
// at the start — the shape speech-to-text output actually has.
export function applyVoiceStyle(text: string, rng: Rng): string {
  let out = text.toLowerCase().replace(/[.,!?"]/g, "");
  if (rng.chance(0.6)) out = rng.pick(VOICE_FILLERS) + " " + out;
  if (rng.chance(0.25)) {
    const words = out.split(" ");
    // Stutter: repeated word — but never a digit or unit token, which would
    // manufacture a different quantity ("6 6 pcs" reads as qty 6).
    const candidates = words
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => !/\d/.test(w) && !SPACING_PROTECTED_TOKENS.has(w.toLowerCase()));
    if (candidates.length > 0) {
      const { idx } = rng.pick(candidates);
      words.splice(idx, 0, words[idx]);
      out = words.join(" ");
    }
  }
  return out;
}

export function corruptMessage(text: string, style: CorruptionStyle, rng: Rng): string {
  switch (style) {
    case "none":
      return text;
    case "typos":
      return applyTypos(text, rng, 0.35);
    case "spacing":
      return applySpacingMistakes(text, rng, 0.4);
    case "caps":
      return applyCaps(text, rng, rng.pick(["lower", "upper", "random"] as const));
    case "shortforms":
      return applyShortForms(text);
    case "emoji":
      return applyEmoji(text, rng, rng.intBetween(1, 3));
    case "voice":
      return applyVoiceStyle(text, rng);
    case "heavy":
      return applyEmoji(
        applyTypos(applyShortForms(text.toLowerCase()), rng, 0.25),
        rng,
        rng.chance(0.5) ? 1 : 0
      );
  }
}
