// Golden Conversation Test Runner — node:test integration.
//
// Thin wrapper around run-golden.ts's runner: one node:test `test()` per
// scenario, so a granular pass/fail shows up in `npx tsx --test` output
// (and, if wired into package.json, in `npm run test`). No execution
// logic lives here — this file only loads scenarios, drives them via the
// exact same runner run-golden.ts's CLI uses, and asserts each one's
// collected failures array is empty. Test infrastructure only; no
// production code is imported for anything other than read-only driving.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGoldenScenarios, runAllGoldenScenarios } from "./run-golden";

const scenarios = loadGoldenScenarios();

test(`golden conversation suite loads (${scenarios.length} scenarios found)`, () => {
  assert.ok(scenarios.length >= 100, `expected at least 100 golden scenarios, found ${scenarios.length}`);
  const ids = new Set(scenarios.map((s) => s.id));
  assert.equal(ids.size, scenarios.length, "every golden scenario id must be unique");
});

test("golden conversation suite: run every scenario and report results", async (t) => {
  const outcomes = await runAllGoldenScenarios();

  for (const outcome of outcomes) {
    await t.test(`${outcome.scenario.id} — ${outcome.scenario.title}`, () => {
      if (outcome.failures.length > 0) {
        const detail = [
          `Failures:`,
          ...outcome.failures.map((f) => `  - ${f}`),
          `Transcript:`,
          ...outcome.transcript.map((turn) => `  customer: ${turn.message}\n  reply: ${turn.reply}`),
          `Final cart: ${JSON.stringify(outcome.finalCart)}`,
          `Final state: ${outcome.finalState}`,
        ].join("\n");
        assert.fail(`${outcome.scenario.id} failed:\n${detail}`);
      }
    });
  }
});
