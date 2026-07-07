// QA phase 14A — the Production QA Simulator.
//
// Drives thousands of generated customer conversations through the REAL V2
// pipeline — v2/core/process-message.ts#processCustomerMessage, the exact
// function app/api/chat/route.ts serves in production — never a mock,
// never a shortcut. Every turn is judged by qa/assertions.ts; every
// failure is classified (qa/failure-classifier.ts), kept replayable
// (qa/replay.ts), and folded into statistics (qa/statistics.ts).
//
// The simulator NEVER stops at a failure: a failed conversation is
// recorded and the run continues, producing one final report at the end.
//
// CLI (offline, no API keys, no LLM — the pipeline's deterministic parser
// path only):
//   npx tsx qa/simulator.ts --conversations=20000 --seed=20260703 --out=qa/output

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import menuData from "../v2/data/menu.json" with { type: "json" };
import restaurantConfigData from "../v2/data/restaurant-config.json" with { type: "json" };
import type { Menu, RestaurantConfig } from "../v2/types/menu";
import type { OrderContext } from "../v2/types/order";
import { Logger } from "../v2/logger";
import {
  createConversationContext,
  saveContext,
  restoreContext,
  type ConversationContext,
} from "../v2/core/context-manager";
import { processCustomerMessage } from "../v2/core/process-message";

import { Rng } from "./randomizer";
import { DEFAULT_RUN_SEED, conversationId, deriveSeed } from "./seed";
import { buildSimulationPlan, allItems } from "./scenario-library";
import { generateConversation, type GeneratedConversation } from "./conversation-generator";
import { checkTurn } from "./assertions";
import { classifyFailure, type ClassifiedFailure } from "./failure-classifier";
import { StatsAccumulator, type ConversationStats, type SimulationStatistics, type TurnStats } from "./statistics";

export const QA_MENU = menuData as Menu;
export const QA_RESTAURANT_CONFIG = restaurantConfigData as RestaurantConfig;

const CHECKOUT_PHASE_STATES: ReadonlySet<string> = new Set([
  "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
]);

export interface TurnLog {
  turnIndex: number;
  message: string;
  reply: string;
  stateBefore: string;
  stateAfter: string;
  cartAfter: Array<{ itemId: string; qty: number }>;
  timingMs: number;
  understood: boolean;
  failures: ClassifiedFailure[];
}

export interface ConversationRunOutcome {
  conversation: GeneratedConversation;
  turnLogs: TurnLog[];
  failures: ClassifiedFailure[];
  stats: ConversationStats;
  finalContext: ConversationContext;
}

// Runs ONE generated conversation through the real pipeline, checking every
// turn. Exported for qa/replay.ts and the test suite.
export async function runConversation(
  generated: GeneratedConversation,
  menu: Menu = QA_MENU,
  restaurantConfig: RestaurantConfig = QA_RESTAURANT_CONFIG
): Promise<ConversationRunOutcome> {
  let conversation = createConversationContext(generated.id, `qa-session-${generated.id}`);
  const logger = new Logger(`qa-session-${generated.id}`, generated.id);

  const turnLogs: TurnLog[] = [];
  const allFailures: ClassifiedFailure[] = [];
  const turnStats: TurnStats[] = [];
  const clarificationCategories: string[] = [];
  const replacements: string[] = [];
  const interruptions: string[] = [];

  for (let turnIndex = 0; turnIndex < generated.turns.length; turnIndex++) {
    const planned = generated.turns[turnIndex];
    const before: OrderContext = conversation.order;

    const { result, conversation: next } = await processCustomerMessage({
      rawMessage: planned.message,
      conversation,
      menu,
      restaurantConfig,
      logger,
    });
    conversation = next;
    const after: OrderContext = conversation.order;

    const { failures, understood } = checkTurn(before, after, result, planned.expectation, menu);
    const classified: ClassifiedFailure[] = failures.map((failure) => ({
      ...failure,
      category: classifyFailure(failure, result.failedStage),
      turnIndex,
      message: planned.message,
    }));
    allFailures.push(...classified);

    if (after.pendingClarification && !before.pendingClarification) {
      clarificationCategories.push(after.pendingClarification.category);
    }
    if (planned.expectation.op === "replace" && understood) {
      replacements.push(`${planned.expectation.fromItemId}->${planned.expectation.toItemId}`);
    }
    const isCartEditOp =
      planned.expectation.op === "add" || planned.expectation.op === "remove" || planned.expectation.op === "replace";
    if (isCartEditOp && CHECKOUT_PHASE_STATES.has(before.state)) {
      interruptions.push(before.state);
    }

    turnLogs.push({
      turnIndex,
      message: planned.message,
      reply: result.reply,
      stateBefore: before.state,
      stateAfter: after.state,
      cartAfter: after.cart.items.map((line) => ({ itemId: line.itemId, qty: line.qty })),
      timingMs: result.timing.totalMs,
      understood,
      failures: classified,
    });
    turnStats.push({
      op: planned.expectation.op,
      tier: planned.expectation.tier,
      templateId: planned.expectation.templateId,
      language: planned.expectation.language,
      understood,
      timingMs: result.timing.totalMs,
      stateBefore: before.state,
      stateAfter: after.state,
      ...(planned.expectation.itemId ? { itemId: planned.expectation.itemId } : {}),
      ...(planned.expectation.phrase ? { phrase: planned.expectation.phrase } : {}),
      failureCodes: classified.map((f) => f.code),
    });
  }

  // Context memory invariant: the whole conversation state must survive a
  // save/restore round trip byte-identically.
  try {
    const restored = restoreContext(saveContext(conversation));
    if (JSON.stringify(restored) !== JSON.stringify(conversation)) {
      allFailures.push({
        code: "CONTEXT_ROUNDTRIP_FAILED",
        detail: "Restored context differs from the saved one.",
        category: "CONTEXT",
        turnIndex: generated.turns.length - 1,
        message: "(context round trip)",
      });
    }
  } catch (error) {
    allFailures.push({
      code: "CONTEXT_ROUNDTRIP_FAILED",
      detail: `saveContext/restoreContext threw: ${String(error)}`,
      category: "CONTEXT",
      turnIndex: generated.turns.length - 1,
      message: "(context round trip)",
    });
  }

  const stats: ConversationStats = {
    id: generated.id,
    scenarioId: generated.scenarioId,
    scenarioKind: generated.scenarioKind,
    ...(generated.quotaBucket ? { quotaBucket: generated.quotaBucket } : {}),
    personality: generated.personality,
    language: generated.language,
    turns: turnStats,
    failures: allFailures,
    clarificationCategories,
    replacements,
    interruptions,
  };

  return { conversation: generated, turnLogs, failures: allFailures, stats, finalContext: conversation };
}

export interface FailedConversationRecord {
  conversation: GeneratedConversation;
  turnLogs: TurnLog[];
  failures: ClassifiedFailure[];
}

export interface SimulationOptions {
  totalConversations?: number;
  runSeed?: number;
  onProgress?: (done: number, total: number, failedSoFar: number) => void;
  // Full replayable records are kept for at most this many failed
  // conversations (every failure still counts in the statistics).
  maxFailedRecords?: number;
}

export interface SimulationRunResult {
  runSeed: number;
  totalConversations: number;
  statistics: SimulationStatistics;
  failedConversations: FailedConversationRecord[];
  totalFailedConversations: number;
  wallClockMs: number;
}

export async function runSimulation(options: SimulationOptions = {}): Promise<SimulationRunResult> {
  const total = options.totalConversations ?? 20000;
  const runSeed = options.runSeed ?? DEFAULT_RUN_SEED;
  const maxFailedRecords = options.maxFailedRecords ?? 500;
  const menu = QA_MENU;

  const itemIdToCategory = new Map<string, string>();
  for (const category of menu.categories) {
    for (const item of category.items) itemIdToCategory.set(item.id, category.key);
  }
  const accumulator = new StatsAccumulator(allItems(menu).map((i) => i.id), itemIdToCategory);

  const planRng = new Rng(runSeed);
  const plan = buildSimulationPlan(menu, total, planRng);

  const failedRecords: FailedConversationRecord[] = [];
  let totalFailed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < plan.length; i++) {
    const generated = generateConversation(plan[i], conversationId(runSeed, i), deriveSeed(runSeed, i), menu);
    const outcome = await runConversation(generated, menu, QA_RESTAURANT_CONFIG);
    accumulator.addConversation(outcome.stats);
    if (outcome.failures.length > 0) {
      totalFailed += 1;
      if (failedRecords.length < maxFailedRecords) {
        failedRecords.push({
          conversation: outcome.conversation,
          turnLogs: outcome.turnLogs,
          failures: outcome.failures,
        });
      }
    }
    options.onProgress?.(i + 1, plan.length, totalFailed);
  }

  return {
    runSeed,
    totalConversations: plan.length,
    statistics: accumulator.finalize(),
    failedConversations: failedRecords,
    totalFailedConversations: totalFailed,
    wallClockMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main(): Promise<void> {
  const total = Number(parseArg("conversations", "20000"));
  const runSeed = Number(parseArg("seed", String(DEFAULT_RUN_SEED)));
  const outDir = parseArg("out", "qa/output");

  console.log(`[qa-simulator] ${total} conversations, seed ${runSeed} — real V2 pipeline, offline, no LLM.`);
  const result = await runSimulation({
    totalConversations: total,
    runSeed,
    onProgress: (done, all, failed) => {
      if (done % 1000 === 0 || done === all) {
        console.log(`[qa-simulator] ${done}/${all} conversations (${failed} failed so far)`);
      }
    },
  });

  mkdirSync(outDir, { recursive: true });

  // Report (qa/reporter.ts) + replayable failures (qa/replay.ts) +
  // regression entries (qa/regression.ts). Imported lazily so the module
  // graph stays clean for tests that import runSimulation only.
  const { buildQAReport } = await import("./reporter");
  const { saveFailedConversations } = await import("./replay");
  const { buildRegressionEntries, mergeAndWriteRegressionFile, DEFAULT_REGRESSION_FILE } = await import("./regression");

  const report = buildQAReport(result);
  const reportPath = join(outDir, "qa-report.md");
  writeFileSync(reportPath, report, "utf8");

  const failuresDir = join(outDir, "failures");
  const savedFailures = saveFailedConversations(failuresDir, result);

  const entries = buildRegressionEntries(result.failedConversations);
  const regressionCount = mergeAndWriteRegressionFile(DEFAULT_REGRESSION_FILE, entries);

  console.log(`[qa-simulator] done in ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`[qa-simulator] report: ${reportPath}`);
  console.log(`[qa-simulator] replayable failures saved: ${savedFailures} -> ${failuresDir}`);
  console.log(`[qa-simulator] regression entries: ${regressionCount} -> ${DEFAULT_REGRESSION_FILE}`);
  console.log(
    `[qa-simulator] conversations failed: ${result.totalFailedConversations}/${result.totalConversations} ` +
      `(success rate ${(result.statistics.successRate * 100).toFixed(2)}%)`
  );
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error("[qa-simulator] fatal:", error);
    process.exitCode = 1;
  });
}
