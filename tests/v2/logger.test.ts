// V2 logger & analytics tests. Drives the real pipeline (parseMessage ->
// processMessage) through processMessageWithLogging so these also prove
// logging never changes cart/state behavior — not just that the logger
// produces plausible-looking data.
// Run with:
//   npx tsx --test tests/v2/logger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { OrderContext } from "../../v2/types/order";
import { createInitialContext, processMessage, cancelOrder } from "../../v2/order-state-engine";
import { parseMessage } from "../../v2/intent-parser/parser";
import {
  processMessageWithLogging,
  Logger,
  buildLogEntry,
  detectLanguage,
  time,
  computePerformanceStats,
  createSessionAnalyticsState,
  recordMessageInSession,
  getSessionAnalytics,
  computeCartAnalytics,
  buildReasoningSummary,
  buildDebugReport,
  exportAsJSON,
  exportAsCSV,
  exportDebugReport,
  type MessageLogEntry,
} from "../../v2/logger";

const menu = menuData as Menu;

function newLogger(): Logger {
  return new Logger("session-1", "conversation-1");
}

function driveWithLogging(logger: Logger, messages: string[], ctx: OrderContext = createInitialContext()): OrderContext {
  let current = ctx;
  for (const m of messages) {
    current = processMessageWithLogging(m, current, menu, logger).context;
  }
  return current;
}

// ─── Message logging ──────────────────────────────────────────────────────────

test("message logging: captures sessionId, conversationId, raw and normalized message", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.sessionId, "session-1");
  assert.equal(entry.conversationId, "conversation-1");
  assert.equal(entry.rawMessage, "ek jumbo zinger dedo");
  assert.equal(entry.normalizedMessage, "ek jumbo zinger dedo");
});

test("message logging: timestamp is a valid, parseable ISO string", () => {
  const logger = newLogger();
  processMessageWithLogging("menu dikhao", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(Number.isNaN(Date.parse(entry.timestamp)), false);
});

test("message logging: one entry is recorded per message processed", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]);
  assert.equal(logger.getEntries().length, 3);
});

test("message logging: Logger.clear() empties the entry list", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  assert.equal(logger.getEntries().length, 1);
  logger.clear();
  assert.equal(logger.getEntries().length, 0);
});

// ─── Intent / language logging ────────────────────────────────────────────────

test("intent logging: detectedIntent and confidence are captured from the parse result", () => {
  const logger = newLogger();
  const { parseResult } = processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.detectedIntent, parseResult.intent);
  assert.equal(entry.confidence, parseResult.confidence);
});

test("intent logging: safetyDecision is captured from the parse result", () => {
  const logger = newLogger();
  const { parseResult } = processMessageWithLogging("beef burger chahiye", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.safetyDecision, parseResult.safetyDecision);
  assert.equal(entry.safetyDecision, "REJECT_UNAVAILABLE");
});

test("detectLanguage: recognizes English, Roman Urdu, Hinglish, and unknown", () => {
  assert.equal(detectLanguage("please show me the menu"), "english");
  assert.equal(detectLanguage("mera naam Fahad hai"), "roman-urdu");
  assert.equal(detectLanguage("please ek jumbo zinger dedo"), "hinglish");
  assert.equal(detectLanguage("Bilal"), "unknown");
});

test("message logging: detectedLanguage is attached to the entry", () => {
  const logger = newLogger();
  processMessageWithLogging("mera naam Fahad hai", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.detectedLanguage, "roman-urdu");
});

// ─── State logging ────────────────────────────────────────────────────────────

test("state logging: previousState/currentState/nextState reflect the transition", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.previousState, "BROWSING");
  assert.equal(entry.currentState, "BROWSING");
  assert.equal(entry.nextState, "CART_EDITING");
});

test("state logging: a full flow logs the correct state sequence", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup"]);
  const states = logger.getEntries().map((e) => `${e.previousState}->${e.nextState}`);
  assert.deepEqual(states, [
    "BROWSING->CART_EDITING",
    "CART_EDITING->ORDER_REVIEW",
    "ORDER_REVIEW->AWAITING_DELIVERY_PICKUP",
    "AWAITING_DELIVERY_PICKUP->AWAITING_NAME",
  ]);
});

test("state logging: an ignored/no-op message logs an unchanged nextState", () => {
  const logger = newLogger();
  processMessageWithLogging("menu dikhao", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.previousState, entry.nextState);
});

// ─── Cart logging ─────────────────────────────────────────────────────────────

test("cart logging: cartBefore/cartAfter reflect the actual cart change", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.cartBefore.items.length, 0);
  assert.equal(entry.cartAfter.items.length, 1);
  assert.equal(entry.cartAfter.items[0].itemId, "jumbo-zinger");
});

test("cart logging: itemsAdded captures the added line", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.itemsAdded.length, 1);
  assert.equal(entry.itemsAdded[0].itemId, "jumbo-zinger");
  assert.equal(entry.itemsRemoved.length, 0);
});

test("cart logging: itemsRemoved captures the removed line", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo", "ek gyro dedo"]);
  logger.clear();
  processMessageWithLogging("gyro remove karo", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.itemsRemoved.length, 1);
  assert.equal(entry.itemsRemoved[0].itemId, "gyro");
});

test("cart logging: itemsReplaced captures a from/to pair with resolved names", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  logger.clear();
  processMessageWithLogging("zinger hata kar steak add karo", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.deepEqual(entry.itemsReplaced, [{ from: "Jumbo Zinger", to: "Chicken Steak" }]);
});

test("cart logging: quantityChanges captures before/after quantities", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  logger.clear();
  processMessageWithLogging("jumbo zinger ki quantity 5 kardo", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.deepEqual(entry.quantityChanges, [{ itemId: "jumbo-zinger", before: 1, after: 5 }]);
});

test("cart logging: totalBefore/totalAfter are computed from menu prices", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.totalBefore, 0);
  assert.equal(entry.totalAfter, 750); // Jumbo Zinger price
});

test("cart logging: cartAction names the action(s) that ran", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.cartAction, "ADD_ITEM");
});

test("cart logging: compound remove-all + add logs both cart actions", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  logger.clear();
  processMessageWithLogging("remove everything and add 1 large pizza", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.cartAction, "REMOVE_ALL, ADD_ITEM");
  assert.equal(entry.itemsRemoved.length, 1);
  assert.equal(entry.itemsAdded.length, 1);
});

test("cart logging: an info-only message (no cart action) leaves cart fields empty/unchanged", () => {
  const logger = newLogger();
  processMessageWithLogging("menu dikhao", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.cartAction, undefined);
  assert.deepEqual(entry.itemsAdded, []);
  assert.deepEqual(entry.cartBefore, entry.cartAfter);
});

// ─── Performance timing ───────────────────────────────────────────────────────

test("performance: executionTimeMs is a non-negative number", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(typeof entry.executionTimeMs, "number");
  assert.equal(entry.executionTimeMs >= 0, true);
});

test("performance: time() measures a synchronous function's elapsed ms", () => {
  const { result, ms } = time(() => {
    let x = 0;
    for (let i = 0; i < 1000; i++) x += i;
    return x;
  });
  assert.equal(result, 499500);
  assert.equal(ms >= 0, true);
});

test("performance: computePerformanceStats aggregates average/max/min over samples", () => {
  const stats = computePerformanceStats([10, 20, 30]);
  assert.equal(stats.count, 3);
  assert.equal(stats.average, 20);
  assert.equal(stats.max, 30);
  assert.equal(stats.min, 10);
});

test("performance: computePerformanceStats on an empty sample set is all zero", () => {
  const stats = computePerformanceStats([]);
  assert.deepEqual(stats, { count: 0, average: 0, max: 0, min: 0 });
});

test("performance: stats aggregate correctly across a full logged conversation", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]);
  const samples = logger.getEntries().map((e) => e.executionTimeMs);
  const stats = computePerformanceStats(samples);
  assert.equal(stats.count, 6);
  assert.equal(stats.max >= stats.average, true);
  assert.equal(stats.min <= stats.average, true);
});

// ─── Error / warning / fallback logging ──────────────────────────────────────

test("error logging: an unavailable item produces a warning, not an error", () => {
  const logger = newLogger();
  processMessageWithLogging("beef burger chahiye", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.warnings.some((w) => w.includes("REJECT_UNAVAILABLE")), true);
  assert.deepEqual(entry.errors, []);
});

test("error logging: removing an item not in the cart produces a warning", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  logger.clear();
  processMessageWithLogging("sandwich remove karo", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.warnings.some((w) => w.includes("REJECT_NOT_IN_CART")), true);
});

test("error logging: an unrecognized message is logged as a fallback (UNKNOWN)", () => {
  const logger = newLogger();
  processMessageWithLogging("asdkjaslkdj qqzz", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.detectedIntent, "UNKNOWN");
  assert.equal(entry.fallbacks.length > 0, true);
});

test("error logging: a clean, unambiguous add produces no warnings or fallbacks", () => {
  const logger = newLogger();
  processMessageWithLogging("ek gyro dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.deepEqual(entry.warnings, []);
  assert.deepEqual(entry.fallbacks, []);
  assert.deepEqual(entry.errors, []);
});

test("error logging: reasoningSummary is always a non-empty string", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "beef burger chahiye", "menu dikhao", "asdkjaslkdj"]);
  for (const entry of logger.getEntries()) {
    assert.equal(typeof entry.reasoningSummary, "string");
    assert.equal(entry.reasoningSummary.length > 0, true);
  }
});

// ─── Clarification logging ───────────────────────────────────────────────────

test("clarification logging: '5 pasta' sets clarificationTriggered and category", () => {
  const logger = newLogger();
  processMessageWithLogging("5 pasta", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.clarificationTriggered, true);
  assert.equal(entry.category, "pasta");
  assert.equal(entry.safetyDecision, "ASK_CLARIFICATION");
});

test("clarification logging: ambiguousMenuItems captures the ambiguous query", () => {
  const logger = newLogger();
  processMessageWithLogging("5 pasta", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.deepEqual(entry.ambiguousMenuItems, ["pasta"]);
  assert.deepEqual(entry.matchedMenuItems, []);
});

test("clarification logging: resolving the clarification logs no clarificationTriggered on the resolving message", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["5 pasta"]);
  logger.clear();
  processMessageWithLogging("2 small 2 large 1 alfredo", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.clarificationTriggered, false);
  assert.equal(entry.nextState, "CART_EDITING");
});

test("clarification logging: an unambiguous match logs matchedItemDetails with query and matched name", () => {
  const logger = newLogger();
  processMessageWithLogging("ek gyro dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.deepEqual(entry.matchedItemDetails, [{ query: "gyro", matchedName: "Gyro" }]);
});

// ─── Logger class ─────────────────────────────────────────────────────────────

test("Logger: exposes its sessionId/conversationId", () => {
  const logger = new Logger("s-42", "c-99");
  assert.equal(logger.sessionId, "s-42");
  assert.equal(logger.conversationId, "c-99");
});

test("Logger: getEntries() returns entries in the order they were logged", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "ek gyro dedo"]);
  const entries = logger.getEntries();
  assert.equal(entries[0].rawMessage, "ek jumbo zinger dedo");
  assert.equal(entries[1].rawMessage, "ek gyro dedo");
});

test("buildLogEntry is a pure function — same inputs produce an equivalent entry", () => {
  const before = createInitialContext();
  const parseResult = parseMessage("ek gyro dedo", before.cart, menu);
  const after = processMessage(before, parseResult, menu);
  const entry1 = buildLogEntry({
    sessionId: "s", conversationId: "c", rawMessage: "ek gyro dedo", parseResult, before, after, menu,
    performance: { parserMs: 1, safetyMs: 0, cartMs: 0, stateMs: 1, responseMs: 0, totalMs: 2 },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const entry2 = buildLogEntry({
    sessionId: "s", conversationId: "c", rawMessage: "ek gyro dedo", parseResult, before, after, menu,
    performance: { parserMs: 1, safetyMs: 0, cartMs: 0, stateMs: 1, responseMs: 0, totalMs: 2 },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(entry1, entry2);
});

// ─── Logging never affects behavior ──────────────────────────────────────────

test("logging never changes the resulting OrderContext vs running the pipeline unlogged", () => {
  const messages = ["ek jumbo zinger dedo", "checkout", "confirm order", "delivery", "House 45 Street 12 Nazimabad Karachi", "mera naam Fahad hai", "submit"];

  let unlogged = createInitialContext();
  for (const m of messages) {
    const pr = parseMessage(m, unlogged.cart, menu);
    unlogged = processMessage(unlogged, pr, menu);
  }

  const logger = newLogger();
  const logged = driveWithLogging(logger, messages);

  // createdAt/updatedAt are real wall-clock timestamps stamped independently
  // by each of these two separate pipeline runs, so they're expected to
  // differ by a millisecond or two regardless of logging — everything ELSE
  // (state, cart, delivery/address/name) must be identical.
  const { createdAt: _c1, updatedAt: _u1, ...loggedRest } = logged;
  const { createdAt: _c2, updatedAt: _u2, ...unloggedRest } = unlogged;
  assert.deepEqual(loggedRest, unloggedRest);
});

test("logging never mutates the OrderContext object passed in", () => {
  const ctx = createInitialContext();
  const before = JSON.parse(JSON.stringify(ctx));
  processMessageWithLogging("ek jumbo zinger dedo", ctx, menu, newLogger());
  assert.deepEqual(ctx, before);
});

// ─── Export format ────────────────────────────────────────────────────────────

test("export: JSON round-trips through JSON.parse with the same entry count", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "ek gyro dedo"]);
  const json = exportAsJSON(logger.getEntries());
  const parsed = JSON.parse(json) as MessageLogEntry[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].rawMessage, "ek jumbo zinger dedo");
});

test("export: CSV has a header row plus one row per entry", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "ek gyro dedo", "checkout"]);
  const csv = exportAsCSV(logger.getEntries());
  const lines = csv.split("\n");
  assert.equal(lines.length, 4); // header + 3 entries
  assert.match(lines[0], /^sessionId,conversationId,timestamp/);
});

test("export: CSV escapes a cartAction value that itself contains a comma", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(newLogger(), ["ek jumbo zinger dedo"]);
  processMessageWithLogging("remove everything and add 1 large pizza", ctx, menu, logger);
  const [entry] = logger.getEntries();
  assert.equal(entry.cartAction, "REMOVE_ALL, ADD_ITEM"); // the raw value genuinely contains a comma

  const csv = exportAsCSV(logger.getEntries());
  const [header, ...rows] = csv.split("\n");
  const headerCols = header.split(",").length;
  assert.equal(rows.length, 1);
  // Quoted so the embedded comma doesn't silently split into extra columns.
  assert.match(rows[0], /"REMOVE_ALL, ADD_ITEM"/);
  assert.equal(rows[0].split(",").length > headerCols, true); // proves the quoted comma would otherwise have broken the column count
  assert.equal(headerCols, 18);
});

test("export: debug report contains one section per entry with Intent/Confidence/Safety lines", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "checkout"]);
  const report = exportDebugReport(logger.getEntries());
  assert.equal((report.match(/--- Message \d+ ---/g) ?? []).length, 2);
  assert.match(report, /Intent: ADD_ITEM/);
  assert.match(report, /Intent: CHECKOUT_START/);
});

test("debug: buildDebugReport reports 'Cart changed: Yes' only when the cart actually changed", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [addEntry] = logger.getEntries();
  assert.match(buildDebugReport(addEntry), /Cart changed: Yes/);

  logger.clear();
  processMessageWithLogging("menu dikhao", createInitialContext(), menu, logger);
  const [showEntry] = logger.getEntries();
  assert.match(buildDebugReport(showEntry), /Cart changed: No/);
});

test("debug: buildReasoningSummary for SHOW_OPTIONS mentions the matched category", () => {
  const logger = newLogger();
  processMessageWithLogging("or zinger dikhao", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  assert.match(entry.reasoningSummary, /zinger/);
});

test("debug: buildReasoningSummary never returns an empty string even for edge-case entries", () => {
  const base = {
    sessionId: "s", conversationId: "c", timestamp: new Date().toISOString(),
    rawMessage: "x", normalizedMessage: "x", detectedLanguage: "unknown" as const,
    detectedIntent: "UNKNOWN" as const, confidence: 0.1, safetyDecision: "NO_CART_ACTION" as const,
    matchedMenuItems: [], matchedItemDetails: [], rejectedMenuItems: [], ambiguousMenuItems: [],
    clarificationTriggered: false,
    previousState: "BROWSING" as const, currentState: "BROWSING" as const, nextState: "BROWSING" as const,
    cartBefore: { items: [] }, cartAfter: { items: [] }, itemsAdded: [], itemsRemoved: [],
    itemsReplaced: [], quantityChanges: [], totalBefore: 0, totalAfter: 0,
    executionTimeMs: 1, errors: [], warnings: [], fallbacks: [],
  };
  assert.equal(buildReasoningSummary(base).length > 0, true);
});

// ─── Session tracking ─────────────────────────────────────────────────────────

test("session: createSessionAnalyticsState starts at zero", () => {
  const state = createSessionAnalyticsState("s1", "2026-01-01T00:00:00.000Z");
  const summary = getSessionAnalytics(state);
  assert.equal(summary.messageCount, 0);
  assert.equal(summary.successfulOrders, 0);
  assert.equal(summary.cancelledOrders, 0);
});

test("session: recordMessageInSession never mutates the state passed in", () => {
  const logger = newLogger();
  processMessageWithLogging("ek jumbo zinger dedo", createInitialContext(), menu, logger);
  const [entry] = logger.getEntries();
  const state = createSessionAnalyticsState("s1", entry.timestamp);
  const before = JSON.parse(JSON.stringify(state));
  recordMessageInSession(state, entry);
  assert.deepEqual(state, before);
});

test("session: messageCount and cartEditCount increment correctly across a flow", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "menu dikhao", "ek gyro dedo"]);
  let state = createSessionAnalyticsState("s1", logger.getEntries()[0].timestamp);
  for (const e of logger.getEntries()) state = recordMessageInSession(state, e);
  const summary = getSessionAnalytics(state);
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.averageCartEditsPerMessage, 2 / 3);
});

test("session: clarificationCount increments when a clarification is triggered", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["5 pasta", "2 small 2 large 1 alfredo"]);
  let state = createSessionAnalyticsState("s1", logger.getEntries()[0].timestamp);
  for (const e of logger.getEntries()) state = recordMessageInSession(state, e);
  assert.equal(getSessionAnalytics(state).clarificationCount, 1);
});

test("session: a full completed order increments successfulOrders and tracks per-order averages", () => {
  const logger = newLogger();
  driveWithLogging(logger, ["ek jumbo zinger dedo", "checkout", "confirm order", "pickup", "Bilal", "submit"]);
  let state = createSessionAnalyticsState("s1", logger.getEntries()[0].timestamp);
  for (const e of logger.getEntries()) state = recordMessageInSession(state, e);
  const summary = getSessionAnalytics(state);
  assert.equal(summary.successfulOrders, 1);
  assert.equal(summary.averageItemsPerOrder, 1);
});

test("session: a cancelled order increments cancelledOrders, not successfulOrders", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  const cancelled = cancelOrder(ctx);
  const fakeEntry: MessageLogEntry = {
    ...buildLogEntry({
      sessionId: "s1", conversationId: "c1", rawMessage: "(cancelled)",
      parseResult: parseMessage("menu dikhao", ctx.cart, menu),
      before: ctx, after: cancelled, menu,
      performance: { parserMs: 0, safetyMs: 0, cartMs: 0, stateMs: 0, responseMs: 0, totalMs: 0 },
    }),
  };
  let state = createSessionAnalyticsState("s1", fakeEntry.timestamp);
  state = recordMessageInSession(state, fakeEntry);
  const summary = getSessionAnalytics(state);
  assert.equal(summary.cancelledOrders, 1);
  assert.equal(summary.successfulOrders, 0);
});

// ─── Analytics aggregation (cart analytics) ──────────────────────────────────

test("analytics: mostOrderedItems counts across multiple messages", () => {
  const logger = newLogger();
  const ctx1 = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  driveWithLogging(logger, ["ek jumbo zinger dedo"], createInitialContext());
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostOrderedItems[0], { name: "Jumbo Zinger", count: 2 });
  void ctx1;
});

test("analytics: mostRequestedUnavailableItems tracks rejected queries", () => {
  const logger = newLogger();
  processMessageWithLogging("beef burger chahiye", createInitialContext(), menu, logger);
  processMessageWithLogging("beef burger chahiye", createInitialContext(), menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostRequestedUnavailableItems[0], { query: "beef burger", count: 2 });
});

test("analytics: mostCommonClarificationCategories tracks the pending category", () => {
  const logger = newLogger();
  processMessageWithLogging("5 pasta", createInitialContext(), menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostCommonClarificationCategories[0], { category: "pasta", count: 1 });
});

test("analytics: mostCommonParserFailures groups UNKNOWN messages", () => {
  const logger = newLogger();
  processMessageWithLogging("asdkjaslkdj", createInitialContext(), menu, logger);
  processMessageWithLogging("asdkjaslkdj", createInitialContext(), menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostCommonParserFailures[0], { message: "asdkjaslkdj", count: 2 });
});

test("analytics: mostCommonAliasesUsed captures an exact-name match", () => {
  const logger = newLogger();
  processMessageWithLogging("ek gyro dedo", createInitialContext(), menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostCommonAliasesUsed[0], { query: "gyro", matchedName: "Gyro", count: 1 });
});

test("analytics: mostCommonReplacementActions tracks from/to pairs", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo"]);
  logger.clear();
  processMessageWithLogging("zinger hata kar steak add karo", ctx, menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostCommonReplacementActions[0], { from: "Jumbo Zinger", to: "Chicken Steak", count: 1 });
});

test("analytics: mostCommonCheckoutInterruptions tracks which stage got interrupted", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["ek jumbo zinger dedo", "checkout", "confirm order"]);
  logger.clear();
  processMessageWithLogging("ek gyro dedo", ctx, menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.deepEqual(analytics.mostCommonCheckoutInterruptions[0], { fromState: "AWAITING_DELIVERY_PICKUP", count: 1 });
});

test("analytics: totalItemsAdded/totalItemsRemoved sum quantities across entries", () => {
  const logger = newLogger();
  const ctx = driveWithLogging(logger, ["2 jumbo zinger"]);
  logger.clear();
  processMessageWithLogging("jumbo zinger remove karo", ctx, menu, logger);
  const analytics = computeCartAnalytics(logger.getEntries());
  assert.equal(analytics.totalItemsRemoved, 2);
});

test("analytics: an empty entry list produces empty/zeroed analytics", () => {
  const analytics = computeCartAnalytics([]);
  assert.equal(analytics.totalItemsAdded, 0);
  assert.deepEqual(analytics.mostOrderedItems, []);
});
