// QA phase 14A — the final QA report.
//
// Renders one SimulationRunResult into the markdown report the task asks
// for: totals, coverage, failures by category, weakest areas, performance,
// recommended fixes, and an overall Production Readiness Score.
//
// Score formula (documented, not hand-waved):
//   base = 100 × (0.45 × conversation success rate
//                 + 0.25 × strict-tier understanding rate
//                 + 0.15 × natural-tier understanding rate
//                 + 0.15 × coverage fraction)
//   minus 3 points per distinct SAFETY-class bug signature (worst kind:
//   silently wrong cart mutations), minus 1 per other distinct bug
//   signature, floored at 0 and capped at 100.

import type { SimulationRunResult } from "./simulator";
import type { WeakArea } from "./statistics";
import { deriveRootCause } from "./replay";

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function tierRate(result: SimulationRunResult, tier: string): number {
  const entry = result.statistics.understandingByTier.find(([t]) => t === tier);
  return entry ? entry[1].rate : 1;
}

export function computeReadinessScore(result: SimulationRunResult): number {
  const stats = result.statistics;
  const distinctCodes = stats.failuresByCode.length;
  const safetyCount = stats.failuresByCategory.find(([cat]) => cat === "SAFETY")?.[1] ?? 0;
  const distinctSafety = safetyCount > 0 ? stats.failuresByCode.filter(([code]) =>
    ["AMBIGUOUS_SILENTLY_RESOLVED", "CLARIFICATION_NOT_OPENED", "CART_MUTATED_BY_NON_ORDER_MESSAGE"].includes(code)
  ).length : 0;

  const base =
    100 *
    (0.45 * stats.successRate +
      0.25 * tierRate(result, "strict") +
      0.15 * tierRate(result, "natural") +
      0.15 * (stats.coveragePercent / 100));
  const penalized = base - 3 * distinctSafety - 1 * Math.max(0, distinctCodes - distinctSafety);
  return Math.max(0, Math.min(100, Math.round(penalized)));
}

function weakAreaLines(areas: WeakArea[]): string {
  if (areas.length === 0) return "_None — every measured area is at 100% understanding._";
  return areas
    .map(
      (area, i) =>
        `${i + 1}. ${area.area} — understood ${pct(area.understoodRate)} of ${area.attempts} attempts`
    )
    .join("\n");
}

function recommendedFixes(result: SimulationRunResult): string {
  const lines: string[] = [];
  const byCategory = new Map(result.statistics.failuresByCategory);

  if ((byCategory.get("SAFETY") ?? 0) > 0) {
    lines.push("- **SAFETY failures first**: any case where an ambiguous phrase silently resolved or a non-order message mutated the cart is a wrong-order risk in production — fix before anything else.");
  }
  if ((byCategory.get("PARSER") ?? 0) > 0) {
    lines.push("- **Parser misses on canonical phrasing**: each STRICT_* failure code below is a phrasing the engine's own tests claim to support — reproduce via the saved replay files and fix in v2/intent-parser/.");
  }
  if ((byCategory.get("STATE") ?? 0) > 0) {
    lines.push("- **State-machine gaps**: CHECKOUT_STAGE_MISSED / STATE_UNEXPECTED entries show transitions that diverge from the documented flow — fix in v2/order-state-engine/.");
  }
  if ((byCategory.get("RESPONSE") ?? 0) > 0) {
    lines.push("- **Response inconsistencies**: replies that leak internals, claim actions that didn't happen, or print totals that don't match the cart — fix in v2/response-builder/.");
  }
  for (const area of result.statistics.weakestAreas.slice(0, 5)) {
    if (area.understoodRate < 0.6) {
      lines.push(`- Improve understanding of ${area.area} (currently ${pct(area.understoodRate)}) — likely a vocabulary/alias gap in v2/intent-parser/matching.ts.`);
    }
  }
  if (lines.length === 0) lines.push("- No fixes required from this run.");
  return lines.join("\n");
}

export function buildQAReport(result: SimulationRunResult): string {
  const stats = result.statistics;
  const score = computeReadinessScore(result);

  const topFailures = result.failedConversations.slice(0, 20).map((record, i) => {
    return `${i + 1}. \`${record.conversation.id}\` (${record.conversation.scenarioKind}, ${record.conversation.personality}, ${record.conversation.language}) — ${deriveRootCause(record.failures)}`;
  });

  const table = (rows: Array<[string, number | string]>, headers: [string, string]) =>
    [`| ${headers[0]} | ${headers[1]} |`, "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");

  return `# Production QA Simulator Report

Run seed: \`${result.runSeed}\` · ${result.totalConversations} conversations · ${(result.wallClockMs / 1000).toFixed(1)}s wall clock · real V2 pipeline, offline, deterministic parser only (no LLM, no API keys).

## Overall Production Readiness Score: **${score} / 100**

## Totals

| Metric | Value |
|---|---|
| Conversations generated | ${result.totalConversations} |
| Total turns | ${stats.totalTurns} |
| Assertion checks executed (approx) | ${stats.totalAssertionChecks} |
| Conversation success rate | ${pct(stats.successRate)} |
| Conversation failure rate | ${pct(stats.failureRate)} |
| Turn-level failure rate | ${pct(stats.turnFailureRate)} |
| Failed conversations | ${result.totalFailedConversations} |
| Average conversation length | ${stats.averageConversationLength.toFixed(1)} turns |
| Average processing time | ${stats.averageProcessingTimeMs.toFixed(2)} ms/turn |
| p95 processing time | ${stats.p95ProcessingTimeMs.toFixed(2)} ms |
| Max processing time | ${stats.maxProcessingTimeMs.toFixed(2)} ms |
| Coverage | ${stats.coveragePercent}% |

## Failures by category

${stats.failuresByCategory.length === 0 ? "_No failures._" : table(stats.failuresByCategory, ["Category", "Count"])}

## Failures by code

${stats.failuresByCode.length === 0 ? "_No failures._" : table(stats.failuresByCode, ["Code", "Count"])}

## Most common

| What | Value |
|---|---|
| Most common failure | ${stats.mostCommonFailure ?? "—"} |
| Most common parser issue | ${stats.mostCommonParserIssue ?? "—"} |
| Most common clarification | ${stats.mostCommonClarification ?? "—"} |
| Most common replacement | ${stats.mostCommonReplacement ?? "—"} |
| Most common interruption stage | ${stats.mostCommonInterruption ?? "—"} |

## Understanding rate by tier

${table(stats.understandingByTier.map(([tier, s]) => [tier, `${pct(s.rate)} of ${s.attempts}`]), ["Tier", "Understood"])}

## Coverage

**By category:** ${stats.coverageByCategory.map(([k, v]) => `${k} (${v})`).join(", ")}

**Menu items covered:** ${stats.coverageByMenuItem.length} — uncovered: ${stats.uncoveredMenuItemIds.length === 0 ? "none" : stats.uncoveredMenuItemIds.join(", ")}

**By language:** ${stats.coverageByLanguage.map(([k, v]) => `${k} (${v})`).join(", ")}

**By checkout stage:** ${stats.coverageByCheckoutStage.map(([k, v]) => `${k} (${v})`).join(", ")}

**By personality:** ${stats.coverageByPersonality.map(([k, v]) => `${k} (${v})`).join(", ")}

**Aliases/phrases exercised:** ${stats.coverageByAlias.length}

**By scenario kind:** ${stats.coverageByScenarioKind.map(([k, v]) => `${k} (${v})`).join(", ")}

## Top 20 weakest areas (lowest understanding rate)

${weakAreaLines(stats.weakestAreas)}

## Sample failures (first ${Math.min(20, result.failedConversations.length)} of ${result.totalFailedConversations})

${topFailures.length === 0 ? "_None._" : topFailures.join("\n")}

## Recommended fixes

${recommendedFixes(result)}
`;
}
