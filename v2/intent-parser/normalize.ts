// Text normalization + quantity segmentation shared by the intent parser.

// Words to strip out when isolating what item(s) an ADD/REMOVE segment
// refers to. Deliberately small and specific to the phrasing this parser is
// expected to handle — not an attempt at V1's full filler-word coverage.
export const FILLER_WORDS = new Set([
  "kardo", "karo", "kar", "krdo", "krado", "dedo", "de", "dena", "dijiye",
  "chahiye", "chahye", "chahiy", "chaiye",
  "hai", "hain", "mujhe", "mera", "meri",
  "ka", "ki", "ke", "please", "add", "remove", "hata", "hatao",
  "milna", "lagao", "laga", "or", "aur", "the", "a", "an",
  // Common conversational noise around an order ("bhai 2 zinger add kar
  // do", "i want 2 zinger") — none of these are menu words, and leaving
  // them in produced unresolvable noise segments that poisoned otherwise
  // valid adds (a top weakest area in the QA simulator run).
  "bhai", "yaar", "sir", "plz", "i", "want", "me", "jaldi",
  // "order" itself ("burger order karo", "order karo") is never a menu
  // word — left in, it poisoned resolveItemQuery's vocabulary gate (which
  // rejects the WHOLE query if any token isn't real menu vocabulary), so
  // "burger order karo" was rejected as unavailable instead of resolving
  // "burger" (V1 parity audit: V1 handles this phrasing, V2 didn't).
  "order",
  // "do" that ISN'T a quantity (see the guarded check in
  // splitIntoQtySegments) is the Roman Urdu verb particle ("kar do",
  // "de do") — never part of an item name.
  "do",
]);

// Roman Urdu / English number words this parser recognizes. "do" ("two" in
// Roman Urdu) is NOT in this map — it's also the verb particle in "kar do"/
// "de do" and the English auxiliary in "do you have...", so it only counts
// as a quantity under the guarded contextual check in splitIntoQtySegments.
export const NUMBER_WORDS: Record<string, number> = {
  ek: 1, aik: 1, one: 1,
  two: 2,
  teen: 3, three: 3,
  char: 4, chaar: 4, four: 4,
  panch: 5, paanch: 5, five: 5,
};

// Tokens after which "do" is definitely the verb particle, not a quantity.
const DO_PREV_VERB_TOKENS = new Set(["kar", "kr", "de", "bhej", "la", "kha", "bata", "btao", "dikha"]);
// Tokens after "do" that mark the English auxiliary ("do you have...").
const DO_NEXT_ENGLISH_TOKENS = new Set(["you", "u", "we", "i", "they", "it", "this", "that", "not", "me", "have"]);

// Unit words that can follow a digit either INSIDE an item name ("6 pcs",
// "12 inch" — protected, part of the name) or as a customer quantity suffix
// ("2 pcs" meaning quantity 2).
const QTY_UNIT_TOKENS = new Set(["pcs", "pc", "piece", "pieces"]);

export function normalizeMessage(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[•·]/g, " ")
    .replace(/—|–/g, " ")
    .replace(/\bpkr\s*[\d,]+/g, " ")
    .replace(/\brs\.?\s*[\d,]+/g, " ")
    .replace(/[^\p{L}\p{N}\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQtyToken(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token] ?? null;
}

export interface QtySegment {
  qty: number;
  text: string;
}

export interface QtySegmentOptions {
  // Digit+unit bigrams that are part of MENU ITEM NAMES ("6 inch", "8 pcs",
  // "12 inch") — a digit starting one of these is item text, not a quantity
  // marker. Build with buildProtectedQtyPhrases(menu) in matching.ts.
  protectedPhrases?: ReadonlySet<string>;
  // Menu vocabulary — when provided, the ambiguous Roman Urdu "do" (=2)
  // only counts as a quantity when the next token is an actual menu word.
  vocabulary?: ReadonlySet<string>;
}

// Splits normalized text into quantity-anchored chunks: each run of words is
// attributed to the most recent quantity marker seen ("2 small 2 large 1
// alfredo" -> [{qty:2,text:"small"},{qty:2,text:"large"},{qty:1,text:"alfredo"}]).
// Filler words are dropped; a chunk with no quantity marker at all defaults
// to qty 1.
//
// Quantity forms recognized:
//   prefix digit            "2 zinger burger"
//   prefix number word      "teen zinger burger", "two zinger burger",
//                           guarded "do zinger burger"
//   postfix x-suffix        "zinger burger x2", "zinger burger 2x"
//   postfix digit + unit    "zinger burger 2 pcs"
// Digits that are part of an item name ("Pizza Small 6 inch", "Hot Shot 8
// pcs with fries") are protected via options.protectedPhrases and stay in
// the item text.
export function splitIntoQtySegments(text: string, options: QtySegmentOptions = {}): QtySegment[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const segments: QtySegment[] = [];
  let currentQty: number | null = null;
  let currentWords: string[] = [];

  const flush = (qtyOverride?: number) => {
    if (currentWords.length > 0) {
      segments.push({ qty: qtyOverride ?? currentQty ?? 1, text: currentWords.join(" ") });
      currentQty = null;
    } else if (qtyOverride !== undefined) {
      // Postfix marker with nothing before it — treat as a prefix for
      // whatever comes next.
      currentQty = qtyOverride;
    }
    currentWords = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // Digit that starts a protected item-name phrase ("6 inch", "8 pcs"):
    // part of the name, never a quantity marker.
    if (/^\d+$/.test(tok) && next && options.protectedPhrases?.has(`${tok} ${next}`)) {
      currentWords.push(tok);
      continue;
    }

    // Postfix "x2" / "2x".
    const xSuffix = tok.match(/^x(\d+)$/) ?? tok.match(/^(\d+)x$/);
    if (xSuffix) {
      flush(parseInt(xSuffix[1], 10));
      continue;
    }

    // Postfix "<digit> pcs" quantity suffix (an UNprotected digit+unit).
    if (/^\d+$/.test(tok) && next && QTY_UNIT_TOKENS.has(next)) {
      flush(parseInt(tok, 10));
      i += 1; // consume the unit word
      continue;
    }

    // Guarded Roman Urdu "do" (= 2): only a quantity when it isn't the verb
    // particle ("kar do") or the English auxiliary ("do you have...") and
    // the next token plausibly names a menu item.
    if (tok === "do") {
      const prevOk = !prev || !DO_PREV_VERB_TOKENS.has(prev);
      const nextOk = Boolean(next) &&
        (options.vocabulary ? options.vocabulary.has(next) : !DO_NEXT_ENGLISH_TOKENS.has(next));
      if (prevOk && nextOk) {
        flush();
        currentQty = 2;
      }
      // Otherwise: verb particle — a filler word, dropped (see FILLER_WORDS).
      continue;
    }

    const qty = parseQtyToken(tok);
    if (qty !== null) {
      flush();
      currentQty = qty;
      continue;
    }
    if (FILLER_WORDS.has(tok)) continue;
    currentWords.push(tok);
  }
  flush();

  return segments;
}

// Strips a set of trigger/marker phrases out of text, used once a message's
// overall intent has been decided and what's left needs to be resolved as
// an item query (e.g. remove "dikhao"/"menu" out of "or zinger dikhao" to
// get the leftover "zinger").
export function stripPhrases(text: string, phrases: string[]): string {
  let result = text;
  for (const phrase of phrases) {
    result = result.split(phrase).join(" ");
  }
  return result.replace(/\s+/g, " ").trim();
}
