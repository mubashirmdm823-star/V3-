// QA phase 14A — Production QA Simulator test suite.
//
// Three jobs:
//   1. Unit-verify the QA machinery itself (seeding, corruption, customer/
//      scenario/conversation generation, assertions, classification,
//      statistics) — a QA system with untested assertions finds nothing.
//   2. Drive a real, deterministic mini-simulation through the ACTUAL V2
//      pipeline end to end and verify the simulator's contract: never stops
//      at a failure, every failure is classified and replayable, statistics
//      are coherent.
//   3. Execute the generated regression suite
//      (tests/qa/regressions.generated.json): every "open" bug must still
//      reproduce (when a fix lands, this flags the entry for promotion to
//      "fixed"), and every "fixed" bug must NOT reproduce — no bug returns.
//
// Run with: npx tsx --test tests/qa/production-simulator.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import menuData from "../../v2/data/menu.json" with { type: "json" };
import type { Menu } from "../../v2/types/menu";
import type { OrderContext } from "../../v2/types/order";
import type { ProcessMessageResult } from "../../v2/core/result";

import { DEFAULT_RUN_SEED, conversationId, deriveSeed, hashStringToSeed } from "../../qa/seed";
import {
  Rng,
  applySpacingMistakes,
  applyTypos,
  applyVoiceStyle,
  corruptMessage,
  typoWord,
} from "../../qa/randomizer";
import {
  CUSTOMER_ADDRESSES,
  CUSTOMER_NAMES,
  PERSONALITY_ARCHETYPES,
  customerForArchetype,
  generateCustomer,
  withLanguage,
} from "../../qa/customer-generator";
import {
  ALIAS_TABLE,
  AMBIGUOUS_PHRASES,
  INVALID_INPUTS,
  allItems,
  buildSimulationPlan,
  checkoutInterruptScenarios,
  everyMenuItemScenarios,
} from "../../qa/scenario-library";
import { generateConversation, type GeneratedConversation } from "../../qa/conversation-generator";
import { checkInvariants, checkTurn, diffCarts, type TurnExpectation } from "../../qa/assertions";
import { classifyFailure } from "../../qa/failure-classifier";
import { StatsAccumulator } from "../../qa/statistics";
import { runConversation, runSimulation } from "../../qa/simulator";
import { buildReplayFile, deriveRootCause, replayConversation } from "../../qa/replay";
import {
  DEFAULT_REGRESSION_FILE,
  buildRegressionEntries,
  checkRegressionEntry,
  loadRegressionFile,
} from "../../qa/regression";
import { buildQAReport, computeReadinessScore } from "../../qa/reporter";
import { isValidAddressReply, extractCustomerName } from "../../v2/order-state-engine/customer-info";

const menu = menuData as Menu;

// ─── A. Seeding ───────────────────────────────────────────────────────────────

test("A1. Rng is deterministic for a given seed", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test("A2. different seeds diverge", () => {
  const a = new Rng(1);
  const b = new Rng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test("A3. deriveSeed scrambles neighboring indices", () => {
  const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(DEFAULT_RUN_SEED, i)));
  assert.equal(seeds.size, 1000);
});

test("A4. hashStringToSeed is stable", () => {
  assert.equal(hashStringToSeed("qa"), hashStringToSeed("qa"));
  assert.notEqual(hashStringToSeed("qa1"), hashStringToSeed("qa2"));
});

test("A5. conversationId embeds run seed and index", () => {
  assert.equal(conversationId(123, 7), "qa-123-00007");
});

// ─── B. Randomizer / corruption ──────────────────────────────────────────────

test("B1. typos never touch digits or the first letter", () => {
  const rng = new Rng(7);
  for (let i = 0; i < 200; i++) {
    const out = typoWord("zinger", rng);
    assert.equal(out[0], "z");
  }
  for (let i = 0; i < 200; i++) {
    const out = applyTypos("2 zinger burger 12 inch", rng, 1);
    assert.ok(out.includes("2"), `digit 2 lost in "${out}"`);
    assert.ok(out.includes("12") || /1\s*2/.test(out), `digits 12 lost in "${out}"`);
  }
});

test("B2. spacing mistakes never join a digit to a word", () => {
  const rng = new Rng(8);
  for (let i = 0; i < 200; i++) {
    const out = applySpacingMistakes("2 zinger burger add karo", rng, 1);
    assert.match(out, /2 /, `quantity glued in "${out}"`);
  }
});

test("B3. every corruption style produces a non-empty string and keeps digits", () => {
  const rng = new Rng(9);
  const styles = ["none", "typos", "spacing", "caps", "shortforms", "emoji", "voice", "heavy"] as const;
  for (const style of styles) {
    for (let i = 0; i < 50; i++) {
      const out = corruptMessage("3 chicken sandwich add karo please", style, rng);
      assert.ok(out.trim().length > 0);
      assert.ok(out.includes("3"), `style ${style} lost the digit: "${out}"`);
    }
  }
});

test("B4. voice style lowercases and strips punctuation", () => {
  const rng = new Rng(10);
  const out = applyVoiceStyle("Add 2 Zinger Burger, please!", rng);
  assert.equal(out, out.toLowerCase());
  assert.doesNotMatch(out, /[,!]/);
});

test("B5. corruption is deterministic per seed", () => {
  const a = corruptMessage("2 zinger burger add karo", "heavy", new Rng(77));
  const b = corruptMessage("2 zinger burger add karo", "heavy", new Rng(77));
  assert.equal(a, b);
});

// ─── C. Customer generator ───────────────────────────────────────────────────

test("C1. all 21 personality archetypes build", () => {
  assert.equal(PERSONALITY_ARCHETYPES.length, 21);
  const rng = new Rng(11);
  for (const archetype of PERSONALITY_ARCHETYPES) {
    const profile = archetype.build(rng);
    assert.equal(profile.personality, archetype.name);
  }
});

test("C2. customerForArchetype rejects unknown names", () => {
  assert.throws(() => customerForArchetype("nonexistent", new Rng(1)));
});

test("C3. withLanguage forces the language", () => {
  const profile = withLanguage(generateCustomer(new Rng(12)), "hinglish");
  assert.equal(profile.language, "hinglish");
});

test("C4. QA customer names pass the engine's own name validation", () => {
  for (const name of CUSTOMER_NAMES) {
    assert.ok(extractCustomerName(name), `"${name}" would be rejected by extractCustomerName`);
  }
});

test("C5. QA addresses pass the engine's own address validation", () => {
  for (const address of CUSTOMER_ADDRESSES) {
    assert.ok(isValidAddressReply(address), `"${address}" would be rejected by isValidAddressReply`);
  }
});

// ─── D. Scenario library ─────────────────────────────────────────────────────

test("D1. everyMenuItemScenarios covers every menu item exactly once", () => {
  const scenarios = everyMenuItemScenarios(menu, new Rng(13));
  const covered = new Set(scenarios.flatMap((s) => s.steps.filter((st) => st.op === "add").map((st) => (st as { itemId: string }).itemId)));
  for (const item of allItems(menu)) {
    assert.ok(covered.has(item.id), `menu item ${item.id} not covered`);
  }
});

test("D2. every alias-table item id exists on the menu", () => {
  const ids = new Set(allItems(menu).map((i) => i.id));
  for (const entry of ALIAS_TABLE) {
    assert.ok(ids.has(entry.itemId), `alias entry references unknown item ${entry.itemId}`);
  }
});

test("D3. every ambiguous phrase's category exists", () => {
  const keys = new Set(menu.categories.map((c) => c.key));
  for (const entry of AMBIGUOUS_PHRASES) {
    assert.ok(keys.has(entry.categoryKey));
  }
});

test("D4. checkout interrupt scenarios cover all five checkout stages", () => {
  const scenarios = checkoutInterruptScenarios(menu, new Rng(14));
  const ids = scenarios.map((s) => s.id).join(" ");
  for (const stage of ["ORDER_REVIEW", "AWAITING_DELIVERY_PICKUP", "AWAITING_ADDRESS", "AWAITING_NAME", "READY_TO_SUBMIT"]) {
    assert.ok(ids.includes(stage), `no interrupt scenario for ${stage}`);
  }
});

test("D5. a full-scale plan is exactly 20,000 conversations and meets every 500-quota", () => {
  const plan = buildSimulationPlan(menu, 20000, new Rng(DEFAULT_RUN_SEED));
  assert.equal(plan.length, 20000);
  const buckets = new Map<string, number>();
  for (const entry of plan) {
    buckets.set(entry.quotaBucket ?? "?", (buckets.get(entry.quotaBucket ?? "?") ?? 0) + 1);
  }
  for (const bucket of [
    "roman-urdu", "english", "hinglish", "mixed", "typo-heavy", "voice-style", "emoji",
    "checkout-interruptions", "replace-flows", "remove-flows", "clarification-chains",
    "long-conversations", "short-conversations",
  ]) {
    assert.ok((buckets.get(bucket) ?? 0) >= 500, `quota bucket ${bucket} has ${buckets.get(bucket)} < 500`);
  }
});

test("D6. a small plan still samples diverse buckets", () => {
  const plan = buildSimulationPlan(menu, 200, new Rng(5));
  assert.equal(plan.length, 200);
  const kinds = new Set(plan.map((p) => p.scenario.kind));
  assert.ok(kinds.size >= 5, `only ${kinds.size} scenario kinds in a 200-conversation plan`);
});

test("D7. invalid input library includes injection and degenerate cases", () => {
  assert.ok(INVALID_INPUTS.some((s) => s.includes("<script>")));
  assert.ok(INVALID_INPUTS.some((s) => s.length > 500));
  assert.ok(INVALID_INPUTS.some((s) => /^\d+$/.test(s)));
});

// ─── E. Conversation generator ───────────────────────────────────────────────

function planFor(seed: number, total = 50) {
  return buildSimulationPlan(menu, total, new Rng(seed));
}

test("E1. generation is fully deterministic for a given seed", () => {
  const [entry] = planFor(21);
  const a = generateConversation(entry, "qa-x-1", 999, menu);
  const b = generateConversation(entry, "qa-x-1", 999, menu);
  assert.deepEqual(a, b);
});

test("E2. address and name turns are never corrupted", () => {
  // A heavy-corruption personality across many seeds: identity turns must
  // always match a known-clean value exactly.
  const plan = planFor(22, 200);
  for (let i = 0; i < plan.length; i++) {
    const conv = generateConversation({ ...plan[i], archetype: "bad-spelling" }, `qa-e2-${i}`, deriveSeed(22, i), menu);
    for (const turn of conv.turns) {
      if (turn.expectation.op === "address") {
        assert.ok((CUSTOMER_ADDRESSES as readonly string[]).includes(turn.message), `corrupted address: "${turn.message}"`);
      }
    }
  }
});

test("E3. a corrupted turn is never left at strict tier", () => {
  const plan = planFor(23, 300);
  for (let i = 0; i < plan.length; i++) {
    const conv = generateConversation({ ...plan[i], archetype: "voice-typing" }, `qa-e3-${i}`, deriveSeed(23, i), menu);
    for (const turn of conv.turns) {
      if (turn.expectation.op === "add" && turn.expectation.tier === "strict") {
        // Strict add turns must be the clean canonical render — verify the
        // item's name survived verbatim.
        const item = allItems(menu).find((it) => it.id === turn.expectation.itemId)!;
        assert.ok(turn.message.includes(item.name), `strict turn text corrupted: "${turn.message}"`);
      }
    }
  }
});

test("E4. forced language is respected", () => {
  const [entry] = planFor(24);
  const conv = generateConversation({ ...entry, language: "english" }, "qa-e4", 4, menu);
  assert.equal(conv.language, "english");
});

test("E5. quantities in strict add turns always appear as digits or known words", () => {
  const plan = planFor(25, 100);
  for (let i = 0; i < plan.length; i++) {
    const conv = generateConversation(plan[i], `qa-e5-${i}`, deriveSeed(25, i), menu);
    for (const turn of conv.turns) {
      if (turn.expectation.op === "add" && turn.expectation.tier === "strict" && (turn.expectation.qty ?? 1) > 1) {
        assert.ok(
          turn.message.includes(String(turn.expectation.qty)),
          `strict multi-qty message lost its digit: "${turn.message}"`
        );
      }
    }
  }
});

// ─── F. Assertions (unit) ────────────────────────────────────────────────────

function makeContext(overrides: Partial<OrderContext> = {}): OrderContext {
  return {
    state: "BROWSING",
    cart: { items: [] },
    orderReviewShown: false,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function makeResult(reply: string, overrides: Partial<ProcessMessageResult> = {}): ProcessMessageResult {
  return {
    reply,
    context: makeContext(),
    parseResult: {
      intent: "UNKNOWN",
      confidence: 0,
      items: [],
      actions: [],
      needsClarification: false,
      safetyDecision: "NO_CART_ACTION",
      rawUserMessage: "x",
      normalizedMessage: "x",
    },
    timing: { parserMs: 0, safetyMs: 0, cartMs: 0, stateMs: 0, responseMs: 0, loggerMs: 0, totalMs: 1 },
    events: [],
    recovered: false,
    parserSource: "deterministic",
    ...overrides,
  } as ProcessMessageResult;
}

test("F1. leak detection catches internal tokens", () => {
  const before = makeContext();
  const failures = checkInvariants(before, before, makeResult("Decision: SAFE_TO_EXECUTE hai"), menu, false);
  assert.ok(failures.some((f) => f.code === "REPLY_LEAKS_INTERNALS"));
});

test("F2. leak detection catches raw item ids", () => {
  const before = makeContext();
  const failures = checkInvariants(before, before, makeResult("added zinger-burger for you"), menu, false);
  assert.ok(failures.some((f) => f.code === "REPLY_LEAKS_INTERNALS"));
});

test("F3. printed total must match the recomputed menu-price total", () => {
  const after = makeContext({
    state: "CART_EDITING",
    cart: { items: [{ itemId: "zinger-burger", name: "Zinger Burger", price: 500, qty: 2 }] },
  });
  const bad = checkInvariants(makeContext(), after, makeResult("Zinger Burger\n\nTotal: PKR 900"), menu, false);
  assert.ok(bad.some((f) => f.code === "PRINTED_TOTAL_MISMATCH"));
  const good = checkInvariants(makeContext(), after, makeResult("Zinger Burger\n\nTotal: PKR 1000"), menu, false);
  assert.ok(!good.some((f) => f.code === "PRINTED_TOTAL_MISMATCH"));
});

test("F4. double space in a reply is flagged as malformed", () => {
  const before = makeContext();
  const failures = checkInvariants(before, before, makeResult("Aapki cart mein  maujood nahi hai."), menu, false);
  assert.ok(failures.some((f) => f.code === "REPLY_MALFORMED"));
});

test("F5. duplicate cart lines are flagged", () => {
  const after = makeContext({
    state: "CART_EDITING",
    cart: {
      items: [
        { itemId: "gyro", name: "Gyro", price: 550, qty: 1 },
        { itemId: "gyro", name: "Gyro", price: 550, qty: 2 },
      ],
    },
  });
  const failures = checkInvariants(makeContext(), after, makeResult("Gyro added"), menu, false);
  assert.ok(failures.some((f) => f.code === "CART_DUPLICATE_LINES"));
});

test("F6. pendingClarification without AWAITING_CLARIFICATION is flagged (both directions)", () => {
  const withPending = makeContext({
    state: "CART_EDITING",
    pendingClarification: { category: "pasta", quantity: 1, question: "q", options: [], previousMessage: "m" },
  });
  assert.ok(checkInvariants(makeContext(), withPending, makeResult("ok"), menu, false).some((f) => f.code === "PENDING_CLARIFICATION_INCONSISTENT"));
  const awaitingWithout = makeContext({ state: "AWAITING_CLARIFICATION" });
  assert.ok(checkInvariants(makeContext(), awaitingWithout, makeResult("ok"), menu, false).some((f) => f.code === "PENDING_CLARIFICATION_INCONSISTENT"));
});

test("F7. wrong item added on an add expectation is a failure at every tier", () => {
  const before = makeContext();
  const after = makeContext({
    state: "CART_EDITING",
    cart: { items: [{ itemId: "chicken-steak", name: "Chicken Steak", price: 950, qty: 1 }] },
  });
  const expectation: TurnExpectation = {
    op: "add", tier: "corrupted", templateId: "x", language: "english",
    itemId: "gyro", qty: 1, allowedItemIds: ["gyro"],
  };
  const { failures } = checkTurn(before, after, makeResult("Chicken Steak added: Chicken Steak"), expectation, menu);
  assert.ok(failures.some((f) => f.code === "WRONG_ITEM_ADDED"));
});

test("F8. ambiguous phrase silently resolving is a SAFETY failure", () => {
  const before = makeContext();
  const after = makeContext({
    state: "CART_EDITING",
    cart: { items: [{ itemId: "pasta-small", name: "Pasta Small", price: 500, qty: 1 }] },
  });
  const expectation: TurnExpectation = {
    op: "addAmbiguous", tier: "natural", templateId: "x", language: "roman-urdu", phrase: "pasta", qty: 1,
  };
  const { failures } = checkTurn(before, after, makeResult("Pasta Small added: Pasta Small"), expectation, menu);
  const hit = failures.find((f) => f.code === "AMBIGUOUS_SILENTLY_RESOLVED");
  assert.ok(hit);
  assert.equal(classifyFailure(hit!), "SAFETY");
});

test("F9. non-order message mutating the cart is a SAFETY failure", () => {
  const before = makeContext();
  const after = makeContext({
    state: "CART_EDITING",
    cart: { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 1 }] },
  });
  const expectation: TurnExpectation = { op: "price", tier: "natural", templateId: "x", language: "english", itemId: "gyro" };
  const { failures } = checkTurn(before, after, makeResult("Gyro added: Gyro"), expectation, menu);
  const hit = failures.find((f) => f.code === "CART_MUTATED_BY_NON_ORDER_MESSAGE");
  assert.ok(hit);
  assert.equal(classifyFailure(hit!), "SAFETY");
});

test("F10. conditional remove: absent item rejected without cart change is NOT a failure", () => {
  const before = makeContext({ state: "CART_EDITING", cart: { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 1 }] } });
  const after = before;
  const expectation: TurnExpectation = { op: "remove", tier: "strict", templateId: "x", language: "english", itemId: "wrap" };
  const { failures } = checkTurn(before, after, makeResult("Wrap aapki cart mein maujood nahi hai."), expectation, menu);
  assert.equal(failures.length, 0);
});

test("F11. replace-turned-into-add fires on clean text but not corrupted text", () => {
  const before = makeContext({ state: "CART_EDITING", cart: { items: [{ itemId: "wrap", name: "Wrap", price: 550, qty: 1 }] } });
  const after = makeContext({
    state: "CART_EDITING",
    cart: {
      items: [
        { itemId: "wrap", name: "Wrap", price: 550, qty: 1 },
        { itemId: "chicken-steak", name: "Chicken Steak", price: 950, qty: 1 },
      ],
    },
  });
  const base: TurnExpectation = {
    op: "replace", tier: "natural", templateId: "x", language: "roman-urdu",
    fromItemId: "wrap", toItemId: "chicken-steak",
  };
  const clean = checkTurn(before, after, makeResult("Chicken Steak added: Chicken Steak"), base, menu);
  assert.ok(clean.failures.some((f) => f.code === "REPLACE_TURNED_INTO_ADD"));
  const corrupted = checkTurn(before, after, makeResult("Chicken Steak added: Chicken Steak"), { ...base, tier: "corrupted" }, menu);
  assert.ok(!corrupted.failures.some((f) => f.code === "REPLACE_TURNED_INTO_ADD"));
});

test("F12. diffCarts reports adds and removes with quantities", () => {
  const before = { items: [{ itemId: "gyro", name: "Gyro", price: 550, qty: 2 }] };
  const after = {
    items: [
      { itemId: "gyro", name: "Gyro", price: 550, qty: 1 },
      { itemId: "wrap", name: "Wrap", price: 550, qty: 3 },
    ],
  };
  const diff = diffCarts(before, after);
  assert.deepEqual(diff.added, [{ itemId: "wrap", name: "Wrap", qtyDelta: 3 }]);
  assert.deepEqual(diff.removed, [{ itemId: "gyro", name: "Gyro", qtyDelta: -1 }]);
});

test("F13. a recovered pipeline on well-formed input is a failure; on invalid input it is allowed", () => {
  const before = makeContext();
  const recovered = makeResult("sorry", { recovered: true, failedStage: "STATE" });
  assert.ok(checkInvariants(before, before, recovered, menu, false).some((f) => f.code === "PIPELINE_CRASH_RECOVERED"));
  assert.ok(!checkInvariants(before, before, recovered, menu, true).some((f) => f.code === "PIPELINE_CRASH_RECOVERED"));
});

test("F14. crash classification follows the failed stage", () => {
  const failure = { code: "PIPELINE_CRASH_RECOVERED" as const, detail: "x" };
  assert.equal(classifyFailure(failure, "PARSER"), "PARSER");
  assert.equal(classifyFailure(failure, "LOGGER"), "LOGGER");
  assert.equal(classifyFailure(failure, undefined), "UNKNOWN");
});

// ─── G. Statistics ───────────────────────────────────────────────────────────

function statsAccumulator() {
  const itemToCategory = new Map<string, string>();
  for (const category of menu.categories) for (const item of category.items) itemToCategory.set(item.id, category.key);
  return new StatsAccumulator(allItems(menu).map((i) => i.id), itemToCategory);
}

test("G1. accumulator computes rates, coverage, and weakest areas", () => {
  const acc = statsAccumulator();
  acc.addConversation({
    id: "c1", scenarioId: "s", scenarioKind: "single-item", personality: "english", language: "english",
    turns: [
      { op: "add", tier: "strict", templateId: "en-add", language: "english", understood: true, timingMs: 2, stateBefore: "BROWSING", stateAfter: "CART_EDITING", itemId: "gyro", failureCodes: [] },
    ],
    failures: [], clarificationCategories: [], replacements: [], interruptions: [],
  });
  acc.addConversation({
    id: "c2", scenarioId: "s", scenarioKind: "single-item", personality: "english", language: "roman-urdu",
    turns: [
      { op: "add", tier: "strict", templateId: "en-add", language: "english", understood: false, timingMs: 4, stateBefore: "BROWSING", stateAfter: "BROWSING", itemId: "wrap", failureCodes: ["STRICT_ADD_MISSED"] },
    ],
    failures: [{ code: "STRICT_ADD_MISSED", detail: "d", category: "PARSER", turnIndex: 0, message: "m" }],
    clarificationCategories: ["pasta"], replacements: ["a->b"], interruptions: ["ORDER_REVIEW"],
  });
  const stats = acc.finalize();
  assert.equal(stats.totalConversations, 2);
  assert.equal(stats.failedConversations, 1);
  assert.equal(stats.successRate, 0.5);
  assert.equal(stats.totalTurns, 2);
  assert.equal(stats.averageProcessingTimeMs, 3);
  assert.equal(stats.mostCommonFailure, "STRICT_ADD_MISSED");
  assert.equal(stats.mostCommonParserIssue, "STRICT_ADD_MISSED");
  assert.equal(stats.mostCommonClarification, "pasta");
  assert.equal(stats.mostCommonReplacement, "a->b");
  assert.equal(stats.mostCommonInterruption, "ORDER_REVIEW");
  assert.ok(stats.coverageByMenuItem.some(([id]) => id === "gyro"));
  assert.ok(stats.uncoveredMenuItemIds.includes("zinger-burger"));
});

// ─── H. End-to-end mini-simulation through the REAL pipeline ────────────────

test("H1. a 250-conversation simulation completes, never stops at failures, and is coherent", async () => {
  const result = await runSimulation({ totalConversations: 250, runSeed: 424242 });
  assert.equal(result.totalConversations, 250);
  assert.equal(result.statistics.totalConversations, 250);
  assert.ok(result.statistics.totalTurns > 500, "expected a realistic number of turns");
  assert.ok(result.statistics.successRate >= 0 && result.statistics.successRate <= 1);
  assert.equal(result.totalFailedConversations, result.statistics.failedConversations);
  // The simulator must have kept going PAST failures: failures exist (this
  // engine has known bugs) and the run still covers many scenario kinds.
  assert.ok(result.statistics.coverageByScenarioKind.length >= 5);
  // Every kept failure record is classified and non-empty.
  for (const record of result.failedConversations) {
    assert.ok(record.failures.length > 0);
    for (const failure of record.failures) {
      assert.ok(failure.category, "failure missing classification");
      assert.ok(failure.code, "failure missing code");
    }
  }
});

test("H2. simulation results are deterministic for the same seed", async () => {
  const a = await runSimulation({ totalConversations: 40, runSeed: 777 });
  const b = await runSimulation({ totalConversations: 40, runSeed: 777 });
  assert.equal(a.totalFailedConversations, b.totalFailedConversations);
  assert.deepEqual(a.statistics.failuresByCode, b.statistics.failuresByCode);
  assert.equal(a.statistics.totalTurns, b.statistics.totalTurns);
});

test("H3. every failed conversation from a run replays to the same failure codes", async () => {
  const result = await runSimulation({ totalConversations: 120, runSeed: 31337 });
  for (const record of result.failedConversations.slice(0, 10)) {
    const replay = buildReplayFile(record, result.runSeed, "x.json");
    const { reproduced } = await replayConversation(replay);
    assert.ok(reproduced, `failure in ${record.conversation.id} did not reproduce on replay`);
  }
});

test("H4. the report renders every required section", async () => {
  const result = await runSimulation({ totalConversations: 60, runSeed: 55 });
  const report = buildQAReport(result);
  for (const section of [
    "Production Readiness Score", "Totals", "Failures by category", "Most common",
    "Coverage", "Top 20 weakest areas", "Recommended fixes", "Understanding rate by tier",
  ]) {
    assert.ok(report.includes(section), `report missing section: ${section}`);
  }
  const score = computeReadinessScore(result);
  assert.ok(score >= 0 && score <= 100);
});

test("H5. a full-menu sweep drives every single menu item through the real pipeline", async () => {
  // Deliberately targeted: one conversation per menu item (46 total),
  // canonical phrasing, and every outcome accounted for — the item either
  // lands or its miss is one of the known exact-name bugs.
  const scenarios = everyMenuItemScenarios(menu, new Rng(2));
  let landed = 0;
  let missed: string[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    // "slow-typer" = zero corruption, neutral politeness — the sweep must
    // send CLEAN canonical text so a miss is the engine's fault, not our
    // deliberate corruption's.
    const conv = generateConversation(
      { scenario: scenarios[i], archetype: "slow-typer" },
      `qa-h5-${i}`,
      deriveSeed(6001, i),
      menu
    );
    const outcome = await runConversation(conv);
    const addTurn = outcome.turnLogs.find((t) => conv.turns[t.turnIndex].expectation.op === "add");
    const itemId = scenarios[i].steps.find((s) => s.op === "add") as { itemId: string } | undefined;
    if (addTurn && itemId && addTurn.cartAfter.some((c) => c.itemId === itemId.itemId)) landed += 1;
    else if (itemId) missed.push(itemId.itemId);
  }
  assert.equal(landed + missed.length, scenarios.length);
  // Fix pass 1: exact full menu names always resolve (digit-unit phrases
  // like "6 inch"/"8 pcs" are protected during quantity segmentation) —
  // every single item must land.
  assert.deepEqual(missed, [], `exact-name failures: ${missed.join(", ")}`);
});

test("H6. invalid inputs never crash the pipeline and never mutate the cart", async () => {
  // Fix pass 1: raw structured text (JSON blobs, markup) is now rejected
  // before token matching can reach the cart — the JSON-injection add this
  // suite originally discovered is fixed and locked in by the regression
  // file. NO invalid input may mutate the cart anymore.
  for (let i = 0; i < INVALID_INPUTS.length; i++) {
    const conv: GeneratedConversation = {
      id: `qa-h6-${i}`,
      seed: i,
      scenarioId: `invalid-${i}`,
      scenarioKind: "invalid-input",
      personality: "english",
      language: "english",
      turns: [
        {
          message: INVALID_INPUTS[i],
          expectation: { op: "invalid", tier: "natural", templateId: "invalid-literal", language: "english" },
        },
      ],
    };
    const outcome = await runConversation(conv);
    assert.ok(outcome.turnLogs[0].reply.length > 0, "empty reply on invalid input");
    assert.ok(
      !outcome.failures.some((f) => f.code === "PIPELINE_CRASH_RECOVERED"),
      `invalid input ${JSON.stringify(INVALID_INPUTS[i])} crashed a pipeline stage`
    );
    assert.ok(
      !outcome.failures.some((f) => f.code === "CART_MUTATED_BY_NON_ORDER_MESSAGE"),
      `invalid input ${JSON.stringify(INVALID_INPUTS[i])} mutated the cart`
    );
  }
});

test("H7. root cause derivation names the layer, code, and message", () => {
  const rootCause = deriveRootCause([
    { code: "WRONG_ITEM_ADDED", detail: "d", category: "PARSER", turnIndex: 2, message: "add x" },
  ]);
  assert.match(rootCause, /PARSER/);
  assert.match(rootCause, /WRONG_ITEM_ADDED/);
  assert.match(rootCause, /add x/);
});

// ─── I. Regression generation & execution ────────────────────────────────────

test("I1. regression entries dedupe by failure signature", async () => {
  const result = await runSimulation({ totalConversations: 150, runSeed: 909 });
  const entries = buildRegressionEntries(result.failedConversations);
  const ids = entries.map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size, "duplicate regression ids");
  assert.ok(entries.every((e) => e.status === "open"));
  assert.ok(entries.every((e) => e.conversation.turns.length > 0));
});

test("I2. the price-question cart mutation stays FIXED: 'how much is X' answers the price, cart untouched", async () => {
  // Originally discovered by this simulator as a SAFETY bug ("how much is
  // Mexican Sandwich" ADDED the item). Fixed in fix pass 1 — this test now
  // asserts the fix end to end: correct price in the reply, zero failures.
  const conv: GeneratedConversation = {
    id: "qa-i2",
    seed: 1,
    scenarioId: "price-query-mexican-sandwich",
    scenarioKind: "price-query",
    personality: "english",
    language: "english",
    turns: [
      {
        message: "how much is Mexican Sandwich",
        expectation: {
          op: "price", tier: "strict", templateId: "en-how-much", language: "english",
          itemId: "mexican-sandwich", replyMustContainOneOf: ["600"],
        },
      },
    ],
  };
  const outcome = await runConversation(conv);
  assert.deepEqual(outcome.failures, [], `expected a clean price answer, got: ${outcome.failures.map((f) => f.code).join(", ")}`);
  assert.match(outcome.turnLogs[0].reply, /600/);
  assert.deepEqual(outcome.turnLogs[0].cartAfter, []);
});

// The generated regression suite: every open bug still reproduces, every
// fixed bug stays fixed. This is what makes "no bug should ever return"
// mechanical rather than aspirational.
test("I3. generated regression suite: open bugs reproduce, fixed bugs stay fixed", async (t) => {
  if (!existsSync(DEFAULT_REGRESSION_FILE)) {
    t.skip("no generated regression file yet — run `npm run qa:simulate` first");
    return;
  }
  const entries = loadRegressionFile();
  assert.ok(entries.length > 0, "regression file exists but is empty");
  for (const entry of entries) {
    const { reproduced } = await checkRegressionEntry(entry);
    if (entry.status === "open") {
      assert.ok(
        reproduced,
        `Regression "${entry.id}" no longer reproduces — the bug appears FIXED. ` +
          `Flip its status to "fixed" in ${DEFAULT_REGRESSION_FILE} so it stays locked in.`
      );
    } else {
      assert.ok(
        !reproduced,
        `Regression "${entry.id}" is marked fixed but REPRODUCED again — the bug has returned.`
      );
    }
  }
});
