// V3 reply normalizer — tests.
//
// The normalizer is the last step before an LLM-written reply reaches the
// customer (see final-reply.ts). Every test here drives the REAL
// normalizeReply() pipeline (and, where useful, its individual named
// steps) against realistic broken output a model actually produced during
// live testing (escaped newlines, Rs./Rs currency, emoji spam, JSON
// wrapping) — never hand-waved examples.
//
// Run with: npx tsx --test tests/v3/reply-normalizer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReply,
  unescapeNewlines,
  normalizeCurrency,
  limitEmojis,
  normalizeBullets,
  collapseBlankLines,
  splitLongParagraphs,
  stripInternalLeakage,
  unwrapJsonOrFence,
} from "../../v3/agent/reply-normalizer";

// ─── Escaped newlines ────────────────────────────────────────────────────────

test("escaped '\\n' becomes a real line break", () => {
  const out = unescapeNewlines("Line one\\nLine two");
  assert.equal(out, "Line one\nLine two");
});

test("escaped '\\n\\n' becomes a real paragraph break (blank line)", () => {
  const out = unescapeNewlines("Paragraph one.\\n\\nParagraph two.");
  assert.equal(out, "Paragraph one.\n\nParagraph two.");
});

test("full pipeline: a reply full of literal \\n never shows a backslash to the customer", () => {
  const raw = "Ji bilkul!\\n\\nZinger Burger - PKR 500\\n\\nKya order karna chahenge?";
  const out = normalizeReply(raw);
  assert.doesNotMatch(out, /\\n/);
  assert.match(out, /Ji bilkul!\n\nZinger Burger/);
});

// ─── Real newlines are preserved (never collapsed into one line) ───────────

test("real newlines already present are preserved as real line breaks", () => {
  const raw = "Line one\nLine two\n\nParagraph two.";
  const out = normalizeReply(raw);
  assert.match(out, /Line one\nLine two/);
  assert.match(out, /\n\nParagraph two\./);
});

test("collapseBlankLines removes 3+ consecutive newlines down to one blank line", () => {
  const out = collapseBlankLines("A\n\n\n\nB");
  assert.equal(out, "A\n\nB");
});

test("collapseBlankLines trims trailing whitespace on each line", () => {
  const out = collapseBlankLines("A   \nB\t\n");
  assert.equal(out, "A\nB");
});

// ─── Rs./Rs -> PKR, consistent spacing ──────────────────────────────────────

test("'Rs.' becomes 'PKR'", () => {
  assert.equal(normalizeCurrency("Total: Rs.500"), "Total: PKR 500");
});

test("'Rs' (no period) becomes 'PKR'", () => {
  assert.equal(normalizeCurrency("Total: Rs 500"), "Total: PKR 500");
});

test("'500 Rs' (currency after the number) becomes 'PKR 500'", () => {
  assert.equal(normalizeCurrency("Total: 500 Rs"), "Total: PKR 500");
});

test("currency format is always exactly 'PKR <amount>' with a single space", () => {
  for (const input of ["Rs.500", "Rs. 500", "Rs500", "Rs 500", "500Rs", "500 Rs."]) {
    const out = normalizeCurrency(input);
    assert.match(out, /^PKR 500$/, `"${input}" -> "${out}"`);
  }
});

test("full pipeline never leaves 'Rs' anywhere in the reply", () => {
  const raw = "Zinger Burger Rs. 500, Jumbo Zinger Rs 750, aur total 1250 Rs hai.";
  const out = normalizeReply(raw);
  assert.doesNotMatch(out, /\bRs\.?\b/);
  assert.match(out, /PKR 500/);
  assert.match(out, /PKR 750/);
});

// ─── Emoji limit ─────────────────────────────────────────────────────────────

test("limitEmojis keeps at most 2 emojis, removing the rest", () => {
  const out = limitEmojis("🍔🔥✅😊👍 Order add ho gaya! 🎉", 2);
  const emojiCount = [...out.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)].length;
  assert.equal(emojiCount, 2);
});

test("limitEmojis leaves text with 2 or fewer emojis untouched", () => {
  const input = "✅ Order confirm ho gaya!";
  assert.equal(limitEmojis(input, 2), input);
});

test("full pipeline never lets more than 2 emojis reach the customer", () => {
  const raw = "🎉🍔🔥✅😊👍😍 Bohat bohat shukriya! 🙏";
  const out = normalizeReply(raw);
  const emojiCount = [...out.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)].length;
  assert.ok(emojiCount <= 2, `expected <=2 emojis, got ${emojiCount} in "${out}"`);
});

// ─── Long paragraph splitting ────────────────────────────────────────────────

test("a long single paragraph with multiple sentences gets split at sentence boundaries", () => {
  const raw =
    "Assalam o alaikum aur bohat bohat shukriya Think Food choose karne ke liye. Hum aapko behtareen khana dene ki koshish karenge. Hamari team bohat jald aapse rabta karegi order confirm karne ke liye.";
  const out = splitLongParagraphs(raw, 100);
  const paragraphs = out.split("\n\n");
  assert.ok(paragraphs.length > 1, "expected the long paragraph to be split into multiple paragraphs");
  for (const p of paragraphs) assert.ok(p.length <= 130, `paragraph too long: "${p}"`);
});

test("a short paragraph is never split", () => {
  const raw = "Kya order karna chahenge?";
  assert.equal(splitLongParagraphs(raw), raw);
});

test("a long paragraph that already has line breaks (e.g. a bullet list) is left alone", () => {
  const raw = "Yeh raha menu:\n- Zinger Burger\n- Jumbo Zinger\n- Smoke Burger — a genuinely long line of text that exceeds the threshold on its own but already has real line breaks around it";
  assert.equal(splitLongParagraphs(raw, 50), raw);
});

// ─── Bullets preserved / normalized ──────────────────────────────────────────

test("dash and asterisk bullets are normalized to the same '•' bullet", () => {
  const out = normalizeBullets("- Zinger Burger\n* Jumbo Zinger\n• Smoke Burger");
  assert.equal(out, "• Zinger Burger\n• Jumbo Zinger\n• Smoke Burger");
});

test("full pipeline keeps a clean, one-bullet-per-line menu listing", () => {
  const raw = "Burgers ki list:\\n- Zinger Burger - PKR 500\\n- Jumbo Zinger - PKR 750\\n- Smoke Burger - PKR 550";
  const out = normalizeReply(raw);
  const bulletLines = out.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(bulletLines.length, 3);
  assert.match(out, /• Zinger Burger - PKR 500/);
});

// ─── No JSON leakage ─────────────────────────────────────────────────────────

test("unwrapJsonOrFence extracts plain text from a {\"reply\": \"...\"} wrapper", () => {
  const out = unwrapJsonOrFence('{"reply": "Total PKR 500 hai."}');
  assert.equal(out, "Total PKR 500 hai.");
});

test("unwrapJsonOrFence strips a markdown code fence", () => {
  const out = unwrapJsonOrFence("```\nHello, kya order karna chahenge?\n```");
  assert.equal(out, "Hello, kya order karna chahenge?");
});

test("full pipeline never shows the customer a raw JSON object", () => {
  const out = normalizeReply('{"message": "Aapka order PKR 500 ka hai. Confirm karein?"}');
  assert.doesNotMatch(out, /[{}]/);
  assert.doesNotMatch(out, /"reply"|"message"/);
  assert.match(out, /PKR 500/);
});

test("stripInternalLeakage removes stray braces left over from partial JSON", () => {
  const out = stripInternalLeakage('Order confirm { "state": "done" } ho gaya hai.');
  assert.doesNotMatch(out, /[{}]/);
});

// ─── No debug/internal-id leakage ───────────────────────────────────────────

test("stripInternalLeakage removes raw menu-item ids (lowercase, hyphen-joined, 3+ segments)", () => {
  const out = stripInternalLeakage("Aapka zinger-burger-w-c cart mein add ho gaya.");
  assert.doesNotMatch(out, /zinger-burger-w-c/);
});

test("stripInternalLeakage removes a leaked tool name", () => {
  const out = stripInternalLeakage("Calling add_multiple_items now for you.");
  assert.doesNotMatch(out, /add_multiple_items/);
});

test("full pipeline never leaks a tool name or raw item id even if the model mentions one", () => {
  const raw = "Maine add_item tool se pizza-large-12-inch aapke cart mein add kar diya hai.";
  const out = normalizeReply(raw);
  assert.doesNotMatch(out, /add_item/);
  assert.doesNotMatch(out, /pizza-large-12-inch/);
});

test("full pipeline never contains literal debug-shaped tokens like 'toolPlan' or 'executed'", () => {
  const raw = 'Here is the toolPlan: [{"tool":"add_item"}] and executed facts: {"added":true}';
  const out = normalizeReply(raw);
  assert.doesNotMatch(out, /toolPlan|"tool"|"added"/);
});

// ─── Currency prices stay numerically correct (never recalculated) ─────────

test("normalizer never changes the numeric amount, only the currency label/spacing", () => {
  const out = normalizeCurrency("Zinger Burger Rs.500, Jumbo Zinger Rs.750");
  assert.match(out, /PKR 500/);
  assert.match(out, /PKR 750/);
});
