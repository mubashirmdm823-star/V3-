// V3 AI Conversation Agent — final reply normalizer.
//
// The LLM writes the customer-facing reply (see final-reply.ts), but a raw
// model response is never trusted to already be WhatsApp-ready — the same
// "never trust the model's exact output shape" posture this codebase has
// held since v2/llm/json-validator.ts. This is the LAST step before a
// reply reaches the customer: it fixes formatting artifacts (escaped
// newlines, Rs./Rs currency, emoji spam, cramped bullets, run-on
// paragraphs) and strips anything internal that should never have
// survived this far (JSON, tool names, raw menu item ids, debug data).
//
// Pure string transforms only — never touches the cart, never touches
// menu prices, never changes what happened this turn, only how it reads.

// Internal vocabulary that should never reach the customer as a bare word
// — the old tool-call names from the pre-refactor architecture, kept here
// (not re-derived from schema.ts) since schema.ts's action "type" values
// are common English words ("add_item") that would be too aggressive to
// strip on their own, whereas these are distinctive, unambiguous tokens.
const TOOL_NAMES = [
  "show_full_menu",
  "show_category",
  "search_menu",
  "add_item",
  "add_multiple_items",
  "remove_item",
  "replace_item",
  "change_quantity",
  "clear_cart",
  "get_cart_summary",
  "queue_clarification",
  "resolve_clarification",
  "ask_clarification",
  "start_checkout",
  "confirm_order",
  "select_delivery",
  "select_pickup",
  "save_address",
  "save_customer_name",
  "get_restaurant_info",
  "escalate_to_human",
] as const;

// ─── 1. Unwrap accidental JSON/code-fence wrapping ──────────────────────────

const JSON_WRAPPER_KEYS = ["reply", "message", "text", "response", "content"];

export function unwrapJsonOrFence(text: string): string {
  let out = text.trim();

  const fenced = out.match(/^```(?:\w*)?\s*\r?\n([\s\S]*?)\r?\n?```$/);
  if (fenced) out = fenced[1].trim();

  if (out.startsWith("{") && out.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(out);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of JSON_WRAPPER_KEYS) {
          const value = (parsed as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim().length > 0) {
            out = value.trim();
            break;
          }
        }
      }
    } catch {
      // Not actually JSON — leave untouched.
    }
  }

  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

// ─── 2. Escaped newlines -> real line/paragraph breaks ──────────────────────

// Rule 1 + 2: a literal backslash-n (two characters, "\" then "n") becomes a
// real newline; two in a row already becomes a real paragraph break as a
// consequence — no separate handling needed once the escape is resolved.
export function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, " ");
}

// ─── 3. Collapse duplicate blank lines ──────────────────────────────────────

export function collapseBlankLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 4/5. Currency: Rs./Rs -> PKR, consistent "PKR <amount>" spacing ────────

export function normalizeCurrency(text: string): string {
  // Every replace captures the FULL digit run (\d+), never a single digit —
  // an earlier version captured just one digit and silently corrupted
  // multi-digit amounts (e.g. "500Rs" -> "50PKR 0").
  let out = text.replace(/\bRs\.?\s*(\d+)/gi, "PKR $1"); // "Rs.500"/"Rs 500" -> "PKR 500"
  // (?!\w) instead of \b: a trailing "Rs." followed by end-of-string/punctuation
  // has non-word characters on BOTH sides of \b's would-be boundary, so \b
  // never matches there and silently fails to consume the period.
  out = out.replace(/(\d+)\s*Rs\.?(?!\w)/gi, "PKR $1"); // "500 Rs"/"500Rs"/"500 Rs." -> "PKR 500"
  out = out.replace(/\bPKR\s*(\d+)/g, "PKR $1"); // fixes any remaining/pre-existing spacing, e.g. "PKR500"
  return out;
}

// ─── 6. Limit emojis to a maximum count ─────────────────────────────────────

const EMOJI_PATTERN = /[\u{2600}-\u{27BF}\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

export function limitEmojis(text: string, max = 2): string {
  const matches = [...text.matchAll(EMOJI_PATTERN)];
  if (matches.length <= max) return text;

  let result = "";
  let lastIndex = 0;
  let kept = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    if (kept < max) {
      result += text.slice(lastIndex, idx + m[0].length);
      kept += 1;
    } else {
      result += text.slice(lastIndex, idx); // drop this emoji, keep surrounding text
    }
    lastIndex = idx + m[0].length;
  }
  result += text.slice(lastIndex);

  return result.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
}

// ─── 7. Consistent bullet formatting ────────────────────────────────────────

export function normalizeBullets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)[-*•]\s+(.*)$/);
      return match ? `${match[1]}• ${match[2]}` : line;
    })
    .join("\n");
}

// ─── 8. Avoid very long, unbroken paragraphs ────────────────────────────────

const MAX_PARAGRAPH_LENGTH = 220;

export function splitLongParagraphs(text: string, maxLen = MAX_PARAGRAPH_LENGTH): string {
  return text
    .split(/\n\n+/)
    .map((paragraph) => {
      if (paragraph.length <= maxLen || paragraph.includes("\n")) return paragraph;

      const sentences = paragraph.split(/(?<=[.!?])\s+(?=[A-Z])/);
      if (sentences.length < 2) return paragraph;

      const chunks: string[] = [];
      let current = "";
      for (const sentence of sentences) {
        const candidate = current ? `${current} ${sentence}` : sentence;
        if (candidate.length > maxLen && current) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current = candidate;
        }
      }
      if (current) chunks.push(current.trim());
      return chunks.join("\n\n");
    })
    .join("\n\n");
}

// ─── 9. Strip anything internal that should never reach the customer ───────

const TOOL_NAME_PATTERN = new RegExp(`\\b(${TOOL_NAMES.join("|")})\\b`, "gi");
// Menu/session ids are lowercase, hyphen-joined, 3+ segments
// ("zinger-burger-w-c", "pizza-large-12-inch") — real Roman Urdu/English
// reply text essentially never takes this shape, so it's a safe signal an
// internal identifier leaked through.
const RAW_ID_PATTERN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g;

// Debug/pipeline field names (see lib/engine/v3.ts's debug object /
// v3/agent's internal shapes) that should never appear as bare words in a
// customer-facing reply, even outside a JSON fragment.
const DEBUG_FIELD_WORDS = ["toolPlan", "toolsExecuted", "activeEngine", "parserSource", "fallbackUsed", "rawState", "usedLLM"];
const DEBUG_FIELD_PATTERN = new RegExp(`\\b(${DEBUG_FIELD_WORDS.join("|")})\\b`, "g");

// A quoted-key JSON fragment ("tool":"add_item", "added":true, "quantity":2,
// ...) even when it's NOT wrapped as one clean top-level object (so
// unwrapJsonOrFence's whole-object check never saw it) — matches simple,
// non-nested value shapes, which covers every real tool-facts shape this
// codebase produces.
const JSON_FRAGMENT_PATTERN = /"[a-zA-Z_][\w]*"\s*:\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/g;

export function stripInternalLeakage(text: string): string {
  let out = text.replace(TOOL_NAME_PATTERN, "");
  out = out.replace(DEBUG_FIELD_PATTERN, "");
  out = out.replace(JSON_FRAGMENT_PATTERN, "");
  out = out.replace(RAW_ID_PATTERN, "");
  out = out.replace(/[{}[\]]/g, "");
  out = out.replace(/ {2,}/g, " ").replace(/ ([,.!?])/g, "$1").replace(/,\s*,/g, ",");
  return out;
}

// ─── 10. Hard blocklist — internal/implementation vocabulary ───────────────
//
// A distinct, LAST-RESORT safety net from stripInternalLeakage above: that
// function strips STRUCTURAL leaks (real tool names, raw hyphenated ids,
// JSON fragments) that only look like internals because of their shape.
// This one blocks a fixed, explicit list of generic English words a model
// can narrate in an otherwise perfectly well-formed sentence when it's
// deflecting instead of answering ("Backend aapko menu se items dikha
// dega.") — a real, live-observed failure mode. The specific bugs this was
// written for (a themed-suggestion request or a general-availability
// question the model answers with a lazy internal-sounding deflection
// instead of real content) are fixed at the SOURCE by dedicated
// fact-verifier.ts overrides that replace the whole reply outright — this
// blocklist exists for whatever leaks through anyway, so no customer-facing
// reply can ever contain these words, no matter which code path produced
// it.
const INTERNAL_TERM_WORDS = ["backend", "front[- ]?end", "tool", "json", "provider", "gateway", "internal", "system", "debug", "v2", "v3", "engine"];
const INTERNAL_TERM_PATTERN = new RegExp(`\\b(${INTERNAL_TERM_WORDS.join("|")})\\b`, "gi");

export function containsInternalTerms(text: string): boolean {
  INTERNAL_TERM_PATTERN.lastIndex = 0;
  return INTERNAL_TERM_PATTERN.test(text);
}

export function stripInternalTerms(text: string): string {
  INTERNAL_TERM_PATTERN.lastIndex = 0;
  let out = text.replace(INTERNAL_TERM_PATTERN, "");
  out = out.replace(/ {2,}/g, " ").replace(/ ([,.!?])/g, "$1").replace(/,\s*,/g, ",");
  return out;
}

// ─── Full pipeline ───────────────────────────────────────────────────────────

export function normalizeReply(raw: string): string {
  let text = unwrapJsonOrFence(raw);
  text = unescapeNewlines(text);
  text = collapseBlankLines(text);
  text = stripInternalLeakage(text);
  text = stripInternalTerms(text);
  text = normalizeCurrency(text);
  text = limitEmojis(text, 2);
  text = normalizeBullets(text);
  text = collapseBlankLines(text);
  text = splitLongParagraphs(text);
  return text.trim();
}
