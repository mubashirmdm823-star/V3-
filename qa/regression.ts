// QA phase 14A — the regression generator.
//
// Every bug the simulator discovers automatically becomes a permanent
// regression entry in tests/qa/regressions.generated.json — one entry per
// DISTINCT bug (deduped by failure code + operation + template), each
// carrying the exact message sequence that reproduces it. The test suite
// (tests/qa/production-simulator.test.ts) replays every entry through the
// real pipeline on every `npm run test`:
//
//   status "open"  — the bug is documented but not yet fixed. The test
//                    asserts it STILL REPRODUCES; when a future phase fixes
//                    it, the test flags the entry so its status gets
//                    flipped to "fixed" (and the fix is thereby locked in).
//   status "fixed" — the test asserts the bug does NOT reproduce. If it
//                    ever comes back, the suite fails. No bug returns.
//
// Merging preserves the statuses of existing entries across re-runs, so a
// simulator re-run never silently reopens or discards triage work.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { GeneratedConversation } from "./conversation-generator";
import type { FailedConversationRecord } from "./simulator";
import { runConversation } from "./simulator";

export const DEFAULT_REGRESSION_FILE = "tests/qa/regressions.generated.json";

export interface RegressionEntry {
  id: string; // stable dedupe key
  title: string;
  status: "open" | "fixed";
  classification: string;
  failureCode: string;
  scenarioKind: string;
  personality: string;
  language: string;
  failingTurnIndex: number;
  failingMessage: string;
  detail: string;
  discovered: string; // ISO date
  conversation: GeneratedConversation; // full replayable input
}

// One entry per distinct (failureCode, op, templateId) triple — the same
// misparse hitting 300 conversations is ONE bug.
export function buildRegressionEntries(failed: FailedConversationRecord[]): RegressionEntry[] {
  const seen = new Map<string, RegressionEntry>();
  for (const record of failed) {
    for (const failure of record.failures) {
      const turn = record.conversation.turns[failure.turnIndex];
      const templateId = turn?.expectation.templateId ?? "unknown";
      const op = turn?.expectation.op ?? "unknown";
      const key = `${failure.code}__${op}__${templateId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        id: key,
        title: `${failure.category}: ${failure.code} on ${op} (${templateId})`,
        status: "open",
        classification: failure.category,
        failureCode: failure.code,
        scenarioKind: record.conversation.scenarioKind,
        personality: record.conversation.personality,
        language: record.conversation.language,
        failingTurnIndex: failure.turnIndex,
        failingMessage: failure.message,
        detail: failure.detail,
        discovered: new Date().toISOString().slice(0, 10),
        conversation: record.conversation,
      });
    }
  }
  return [...seen.values()];
}

export function loadRegressionFile(path: string = DEFAULT_REGRESSION_FILE): RegressionEntry[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as RegressionEntry[];
}

// Merge newly-discovered entries into the existing file. Existing entries
// keep their status (and everything else — triage work is never clobbered);
// only genuinely new bug signatures are appended. Returns the total count.
export function mergeAndWriteRegressionFile(path: string, newEntries: RegressionEntry[]): number {
  const existing = loadRegressionFile(path);
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const entry of newEntries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const merged = [...byId.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
  return merged.length;
}

export interface RegressionCheckResult {
  entry: RegressionEntry;
  reproduced: boolean;
  replayCodes: string[];
}

// Replays a regression entry's conversation through the REAL pipeline and
// reports whether its specific failure code appeared again.
export async function checkRegressionEntry(entry: RegressionEntry): Promise<RegressionCheckResult> {
  const outcome = await runConversation(entry.conversation);
  const replayCodes = [...new Set(outcome.failures.map((f) => f.code))];
  return {
    entry,
    reproduced: replayCodes.includes(entry.failureCode as (typeof outcome.failures)[number]["code"]),
    replayCodes,
  };
}
