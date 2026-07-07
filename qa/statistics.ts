// QA phase 14A — statistics accumulation.
//
// The simulator streams every finished conversation through
// StatsAccumulator.addConversation() and throws the bulky per-turn data
// away for passing conversations — only aggregates survive, so a 20,000
// conversation run doesn't hold 160k replies in memory. finalize()
// produces the SimulationStatistics the reporter renders.

import type { FailureCode } from "./assertions";
import type { FailureCategory, ClassifiedFailure } from "./failure-classifier";
import type { Language } from "./customer-generator";
import type { ScenarioKind } from "./scenario-library";

export interface TurnStats {
  op: string;
  tier: string;
  templateId: string;
  language: Language;
  understood: boolean;
  timingMs: number;
  stateBefore: string;
  stateAfter: string;
  itemId?: string;
  phrase?: string;
  failureCodes: FailureCode[];
}

export interface ConversationStats {
  id: string;
  scenarioId: string;
  scenarioKind: ScenarioKind;
  quotaBucket?: string;
  personality: string;
  language: Language;
  turns: TurnStats[];
  failures: ClassifiedFailure[];
  clarificationCategories: string[]; // pendingClarification.category values seen
  replacements: string[]; // "from->to" pairs that succeeded
  interruptions: string[]; // checkout stage a cart edit interrupted
}

interface RateBucket {
  attempts: number;
  understood: number;
}

function rate(bucket: RateBucket): number {
  return bucket.attempts === 0 ? 1 : bucket.understood / bucket.attempts;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function bumpRate(map: Map<string, RateBucket>, key: string, understood: boolean): void {
  const bucket = map.get(key) ?? { attempts: 0, understood: 0 };
  bucket.attempts += 1;
  if (understood) bucket.understood += 1;
  map.set(key, bucket);
}

export interface WeakArea {
  area: string;
  attempts: number;
  understoodRate: number;
}

export interface SimulationStatistics {
  totalConversations: number;
  failedConversations: number;
  totalTurns: number;
  totalAssertionChecks: number;
  successRate: number; // conversation-level
  failureRate: number;
  turnFailureRate: number;
  averageConversationLength: number;
  averageProcessingTimeMs: number;
  maxProcessingTimeMs: number;
  p95ProcessingTimeMs: number;
  failuresByCode: Array<[string, number]>;
  failuresByCategory: Array<[FailureCategory, number]>;
  mostCommonFailure?: string;
  mostCommonParserIssue?: string;
  mostCommonClarification?: string;
  mostCommonReplacement?: string;
  mostCommonInterruption?: string;
  coverageByCategory: Array<[string, number]>;
  coverageByMenuItem: Array<[string, number]>;
  uncoveredMenuItemIds: string[];
  coverageByAlias: Array<[string, number]>;
  coverageByLanguage: Array<[string, number]>;
  coverageByCheckoutStage: Array<[string, number]>;
  coverageByPersonality: Array<[string, number]>;
  coverageByScenarioKind: Array<[string, number]>;
  understandingByTier: Array<[string, { attempts: number; rate: number }]>;
  weakestAreas: WeakArea[]; // lowest understanding rate, min 20 attempts
  coveragePercent: number;
}

// Approximate discrete checks per turn: the invariant suite runs ~14
// independent checks and each expectation adds ~3.
export const ASSERTION_CHECKS_PER_TURN = 17;

const CHECKOUT_STAGES = [
  "ORDER_REVIEW",
  "AWAITING_DELIVERY_PICKUP",
  "AWAITING_ADDRESS",
  "AWAITING_NAME",
  "READY_TO_SUBMIT",
  "PENDING_VERIFICATION",
] as const;

export class StatsAccumulator {
  private readonly allMenuItemIds: readonly string[];

  private conversations = 0;
  private failedConvs = 0;
  private turns = 0;
  private turnFailures = 0;
  private totalTimingMs = 0;
  private maxTimingMs = 0;
  private timings: number[] = [];

  private failureCodes = new Map<string, number>();
  private failureCategories = new Map<string, number>();
  private parserIssues = new Map<string, number>();
  private clarifications = new Map<string, number>();
  private replacements = new Map<string, number>();
  private interruptions = new Map<string, number>();

  private categoryCoverage = new Map<string, number>();
  private itemCoverage = new Map<string, number>();
  private aliasCoverage = new Map<string, number>();
  private languageCoverage = new Map<string, number>();
  private checkoutStageCoverage = new Map<string, number>();
  private personalityCoverage = new Map<string, number>();
  private scenarioKindCoverage = new Map<string, number>();

  private templateRates = new Map<string, RateBucket>();
  private aliasRates = new Map<string, RateBucket>();
  private tierRates = new Map<string, RateBucket>();

  constructor(allMenuItemIds: readonly string[], private readonly itemIdToCategory: ReadonlyMap<string, string>) {
    this.allMenuItemIds = allMenuItemIds;
  }

  addConversation(conv: ConversationStats): void {
    this.conversations += 1;
    if (conv.failures.length > 0) this.failedConvs += 1;
    bump(this.languageCoverage, conv.language);
    bump(this.personalityCoverage, conv.personality);
    bump(this.scenarioKindCoverage, conv.scenarioKind);

    for (const failure of conv.failures) {
      bump(this.failureCodes, failure.code);
      bump(this.failureCategories, failure.category);
      if (failure.category === "PARSER") bump(this.parserIssues, failure.code);
    }
    for (const category of conv.clarificationCategories) bump(this.clarifications, category);
    for (const pair of conv.replacements) bump(this.replacements, pair);
    for (const stage of conv.interruptions) bump(this.interruptions, stage);

    for (const turn of conv.turns) {
      this.turns += 1;
      if (turn.failureCodes.length > 0) this.turnFailures += 1;
      this.totalTimingMs += turn.timingMs;
      this.maxTimingMs = Math.max(this.maxTimingMs, turn.timingMs);
      this.timings.push(turn.timingMs);

      if (turn.itemId) {
        bump(this.itemCoverage, turn.itemId);
        const category = this.itemIdToCategory.get(turn.itemId);
        if (category) bump(this.categoryCoverage, category);
      }
      if (turn.phrase) {
        bump(this.aliasCoverage, turn.phrase);
        bumpRate(this.aliasRates, turn.phrase, turn.understood);
      }
      if ((CHECKOUT_STAGES as readonly string[]).includes(turn.stateAfter)) {
        bump(this.checkoutStageCoverage, turn.stateAfter);
      }
      bumpRate(this.templateRates, `${turn.op}:${turn.templateId}:${turn.language}`, turn.understood);
      bumpRate(this.tierRates, turn.tier, turn.understood);
    }
  }

  finalize(): SimulationStatistics {
    const sortDesc = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
    const failuresByCode = sortDesc(this.failureCodes);
    const failuresByCategory = sortDesc(this.failureCategories) as Array<[FailureCategory, number]>;
    const sortedTimings = this.timings.slice().sort((a, b) => a - b);
    const p95 = sortedTimings.length === 0 ? 0 : sortedTimings[Math.floor(sortedTimings.length * 0.95)];

    const weakest: WeakArea[] = [];
    for (const [key, bucket] of this.templateRates) {
      if (bucket.attempts >= 20) weakest.push({ area: `template ${key}`, attempts: bucket.attempts, understoodRate: rate(bucket) });
    }
    for (const [key, bucket] of this.aliasRates) {
      if (bucket.attempts >= 10) weakest.push({ area: `alias/phrase "${key}"`, attempts: bucket.attempts, understoodRate: rate(bucket) });
    }
    weakest.sort((a, b) => a.understoodRate - b.understoodRate);

    const uncovered = this.allMenuItemIds.filter((id) => !this.itemCoverage.has(id));
    const coverageAxes = [
      this.itemCoverage.size / Math.max(1, this.allMenuItemIds.length),
      this.categoryCoverage.size / Math.max(1, new Set(this.itemIdToCategory.values()).size),
      this.checkoutStageCoverage.size / CHECKOUT_STAGES.length,
      Math.min(1, this.languageCoverage.size / 4),
      Math.min(1, this.personalityCoverage.size / 21),
    ];
    const coveragePercent = Math.round((coverageAxes.reduce((a, b) => a + b, 0) / coverageAxes.length) * 100);

    return {
      totalConversations: this.conversations,
      failedConversations: this.failedConvs,
      totalTurns: this.turns,
      totalAssertionChecks: this.turns * ASSERTION_CHECKS_PER_TURN,
      successRate: this.conversations === 0 ? 1 : (this.conversations - this.failedConvs) / this.conversations,
      failureRate: this.conversations === 0 ? 0 : this.failedConvs / this.conversations,
      turnFailureRate: this.turns === 0 ? 0 : this.turnFailures / this.turns,
      averageConversationLength: this.conversations === 0 ? 0 : this.turns / this.conversations,
      averageProcessingTimeMs: this.turns === 0 ? 0 : this.totalTimingMs / this.turns,
      maxProcessingTimeMs: this.maxTimingMs,
      p95ProcessingTimeMs: p95,
      failuresByCode,
      failuresByCategory,
      mostCommonFailure: failuresByCode[0]?.[0],
      mostCommonParserIssue: sortDesc(this.parserIssues)[0]?.[0],
      mostCommonClarification: sortDesc(this.clarifications)[0]?.[0],
      mostCommonReplacement: sortDesc(this.replacements)[0]?.[0],
      mostCommonInterruption: sortDesc(this.interruptions)[0]?.[0],
      coverageByCategory: sortDesc(this.categoryCoverage),
      coverageByMenuItem: sortDesc(this.itemCoverage),
      uncoveredMenuItemIds: uncovered,
      coverageByAlias: sortDesc(this.aliasCoverage),
      coverageByLanguage: sortDesc(this.languageCoverage),
      coverageByCheckoutStage: sortDesc(this.checkoutStageCoverage),
      coverageByPersonality: sortDesc(this.personalityCoverage),
      coverageByScenarioKind: sortDesc(this.scenarioKindCoverage),
      understandingByTier: [...this.tierRates.entries()].map(([tier, bucket]) => [tier, { attempts: bucket.attempts, rate: rate(bucket) }]),
      weakestAreas: weakest.slice(0, 20),
      coveragePercent,
    };
  }
}
