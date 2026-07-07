// QA phase 14A — the replay engine.
//
// Every failed conversation is saved as a self-contained JSON file holding
// everything needed to reproduce it: the generated conversation (messages +
// expectations + seed), the observed turn logs (reply, state, cart,
// timing), the classified failures, a derived root cause, and the exact
// replay command. Replaying re-runs the SAME messages through the REAL
// pipeline and re-checks the same expectations — a deterministic bug
// reproduces identically every time.
//
// CLI:
//   npx tsx qa/replay.ts qa/output/failures/qa-20260703-00042.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GeneratedConversation } from "./conversation-generator";
import type { ClassifiedFailure } from "./failure-classifier";
import {
  runConversation,
  type ConversationRunOutcome,
  type FailedConversationRecord,
  type SimulationRunResult,
  type TurnLog,
} from "./simulator";

export interface ReplayFile {
  id: string;
  runSeed: number;
  conversation: GeneratedConversation;
  turnLogs: TurnLog[];
  failures: ClassifiedFailure[];
  rootCause: string;
  replayCommand: string;
}

// A human-readable one-liner naming the layer, the failure code, and the
// exact customer message that triggered the first failure.
export function deriveRootCause(failures: ClassifiedFailure[]): string {
  if (failures.length === 0) return "No failures.";
  const first = failures[0];
  return `${first.category} layer — ${first.code} on turn ${first.turnIndex} (${JSON.stringify(first.message)}): ${first.detail}`;
}

export function buildReplayFile(record: FailedConversationRecord, runSeed: number, filePath: string): ReplayFile {
  return {
    id: record.conversation.id,
    runSeed,
    conversation: record.conversation,
    turnLogs: record.turnLogs,
    failures: record.failures,
    rootCause: deriveRootCause(record.failures),
    replayCommand: `npx tsx qa/replay.ts ${filePath.replace(/\\/g, "/")}`,
  };
}

export function saveFailedConversations(dir: string, result: SimulationRunResult): number {
  if (result.failedConversations.length === 0) return 0;
  mkdirSync(dir, { recursive: true });
  let saved = 0;
  for (const record of result.failedConversations) {
    const filePath = join(dir, `${record.conversation.id}.json`);
    const replayFile = buildReplayFile(record, result.runSeed, filePath);
    writeFileSync(filePath, JSON.stringify(replayFile, null, 2), "utf8");
    saved += 1;
  }
  return saved;
}

export interface ReplayResult {
  outcome: ConversationRunOutcome;
  reproduced: boolean; // the original failure codes all appeared again
  originalCodes: string[];
  replayCodes: string[];
}

// Re-runs a saved failed conversation through the real pipeline and checks
// whether the originally-recorded failures reproduce.
export async function replayConversation(replay: ReplayFile): Promise<ReplayResult> {
  const outcome = await runConversation(replay.conversation);
  const originalCodes = [...new Set(replay.failures.map((f) => f.code))].sort();
  const replayCodes = [...new Set(outcome.failures.map((f) => f.code))].sort();
  const reproduced = originalCodes.every((code) => replayCodes.includes(code));
  return { outcome, reproduced, originalCodes, replayCodes };
}

export function loadReplayFile(path: string): ReplayFile {
  return JSON.parse(readFileSync(path, "utf8")) as ReplayFile;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx qa/replay.ts <failure-file.json>");
    process.exitCode = 1;
    return;
  }
  const replay = loadReplayFile(path);
  console.log(`[qa-replay] ${replay.id} — ${replay.conversation.scenarioKind} / ${replay.conversation.personality} / ${replay.conversation.language}`);
  console.log(`[qa-replay] recorded root cause: ${replay.rootCause}`);

  const { outcome, reproduced, originalCodes, replayCodes } = await replayConversation(replay);
  for (const log of outcome.turnLogs) {
    const mark = log.failures.length > 0 ? "✗" : "·";
    console.log(`  ${mark} [${log.stateBefore} -> ${log.stateAfter}] "${log.message}"`);
    for (const failure of log.failures) {
      console.log(`      ${failure.category}/${failure.code}: ${failure.detail}`);
    }
  }
  console.log(`[qa-replay] original failure codes: ${originalCodes.join(", ") || "none"}`);
  console.log(`[qa-replay] replayed failure codes: ${replayCodes.join(", ") || "none"}`);
  console.log(reproduced ? "[qa-replay] REPRODUCED ✅" : "[qa-replay] NOT reproduced — behavior has changed since the run.");
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error("[qa-replay] fatal:", error);
    process.exitCode = 1;
  });
}
