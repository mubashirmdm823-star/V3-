// Real-customer simulator & fuzz test runner for the Think Food WhatsApp AI.
//
// Usage:
//   npx tsx tests/think-food-ai/run-tests.ts                 — run everything, summary only
//   npx tsx tests/think-food-ai/run-tests.ts --verbose        — print every failure's detail
//   npx tsx tests/think-food-ai/run-tests.ts --category="Roman Urdu"   — filter by category
//   npx tsx tests/think-food-ai/run-tests.ts --id=ru-014       — run a single case by id
//   npx tsx tests/think-food-ai/run-tests.ts --json=out.json   — write full machine-readable results

import { writeFileSync } from "node:fs";
import { ai, applyCartAction, type Phase, type Draft, type CartItem } from "../../lib/think-food-ai";
import { ALL_TEST_CASES } from "./cases";
import type { TestCase } from "./types";

interface TurnResult {
  content: string;
  newPhase: Phase;
  newDraft: Draft;
  confirmed: boolean;
}

function threadTurn(message: string, phase: Phase, draft: Draft): TurnResult {
  const out = ai(message, phase, draft);
  let newDraft = draft;
  if (out.draftPatch) newDraft = { ...newDraft, ...out.draftPatch };
  const actions = out.cartActions ?? (out.cartAction ? [out.cartAction] : []);
  for (const a of actions) newDraft = { ...newDraft, cart: applyCartAction(newDraft.cart, a) };
  const newPhase: Phase = out.confirmed ? "done" : out.nextPhase ?? phase;
  return { content: out.content, newPhase, newDraft, confirmed: !!out.confirmed };
}

function cartKey(cart: CartItem[]) {
  return [...cart]
    .map((i) => `${i.name}:${i.qty}`)
    .sort()
    .join("|");
}

interface RunResult {
  case: TestCase;
  pass: boolean;
  failures: string[];
  actualContent: string;
  actualCart: CartItem[];
  actualTotal: number;
  actualPhase: Phase;
  actualConfirmed: boolean;
}

function runCase(tc: TestCase): RunResult {
  let phase: Phase = "browsing";
  let draft: Draft = { cart: [] };

  for (const m of tc.setup ?? []) {
    const r = threadTurn(m, phase, draft);
    phase = r.newPhase;
    draft = r.newDraft;
  }

  const cartBeforeKey = cartKey(draft.cart);
  const r = threadTurn(tc.message, phase, draft);
  const cartAfterKey = cartKey(r.newDraft.cart);
  const total = r.newDraft.cart.reduce((s, i) => s + i.price * i.qty, 0);

  const failures: string[] = [];
  const cartChanged = cartBeforeKey !== cartAfterKey;

  if (cartChanged !== tc.expect.cartChanges) {
    failures.push(
      `cartChanges: expected ${tc.expect.cartChanges}, got ${cartChanged} (before=[${cartBeforeKey}] after=[${cartAfterKey}])`
    );
  }

  if (tc.expect.cartAfter) {
    const expectedKey = [...tc.expect.cartAfter]
      .map((i) => `${i.name}:${i.qty}`)
      .sort()
      .join("|");
    if (expectedKey !== cartAfterKey) {
      failures.push(`cartAfter: expected [${expectedKey}], got [${cartAfterKey}]`);
    }
  }

  if (tc.expect.totalAfter !== undefined && total !== tc.expect.totalAfter) {
    failures.push(`totalAfter: expected ${tc.expect.totalAfter}, got ${total}`);
  }

  if (tc.expect.phaseAfter !== undefined && r.newPhase !== tc.expect.phaseAfter) {
    failures.push(`phaseAfter: expected ${tc.expect.phaseAfter}, got ${r.newPhase}`);
  }

  if (tc.expect.confirmed !== undefined && r.confirmed !== tc.expect.confirmed) {
    failures.push(`confirmed: expected ${tc.expect.confirmed}, got ${r.confirmed}`);
  }

  for (const sub of tc.expect.contains ?? []) {
    if (!r.content.toLowerCase().includes(sub.toLowerCase())) {
      failures.push(`contains: expected response to include "${sub}"`);
    }
  }

  for (const sub of tc.expect.notContains ?? []) {
    if (r.content.toLowerCase().includes(sub.toLowerCase())) {
      failures.push(`notContains: response unexpectedly includes "${sub}"`);
    }
  }

  return {
    case: tc,
    pass: failures.length === 0,
    failures,
    actualContent: r.content,
    actualCart: r.newDraft.cart,
    actualTotal: total,
    actualPhase: r.newPhase,
    actualConfirmed: r.confirmed,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const categoryFilter = args.find((a) => a.startsWith("--category="))?.split("=")[1];
const idFilter = args.find((a) => a.startsWith("--id="))?.split("=")[1];
const jsonOut = args.find((a) => a.startsWith("--json="))?.split("=")[1];

let cases = ALL_TEST_CASES;
if (categoryFilter) cases = cases.filter((c) => c.category === categoryFilter);
if (idFilter) cases = cases.filter((c) => c.id === idFilter);

const seenIds = new Set<string>();
for (const c of ALL_TEST_CASES) {
  if (seenIds.has(c.id)) throw new Error(`Duplicate test id: ${c.id}`);
  seenIds.add(c.id);
}

const results = cases.map(runCase);
const passed = results.filter((r) => r.pass);
const failed = results.filter((r) => !r.pass);

// Per-category breakdown
const byCategory = new Map<string, { pass: number; fail: number }>();
for (const r of results) {
  const entry = byCategory.get(r.case.category) ?? { pass: 0, fail: 0 };
  if (r.pass) entry.pass++;
  else entry.fail++;
  byCategory.set(r.case.category, entry);
}

console.log(`\n=== Think Food AI — Test Run ===`);
console.log(`Total: ${results.length}  Passed: ${passed.length}  Failed: ${failed.length}\n`);

console.log(`Per-category:`);
for (const [cat, { pass, fail }] of byCategory) {
  const total = pass + fail;
  console.log(`  ${fail === 0 ? "✅" : "❌"} ${cat.padEnd(28)} ${pass}/${total}`);
}

if (failed.length > 0) {
  console.log(`\n=== Failures ===`);
  for (const r of failed) {
    console.log(`\n[${r.case.id}] (${r.case.category}) "${r.case.message}"`);
    console.log(`  intent: ${r.case.intent}`);
    for (const f of r.failures) console.log(`  ✗ ${f}`);
    if (verbose) {
      console.log(`  actual content: ${JSON.stringify(r.actualContent.slice(0, 300))}`);
      console.log(`  actual cart: ${JSON.stringify(r.actualCart)}`);
      console.log(`  actual phase: ${r.actualPhase}`);
    }
  }
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        total: results.length,
        passed: passed.length,
        failed: failed.length,
        results: results.map((r) => ({
          id: r.case.id,
          category: r.case.category,
          message: r.case.message,
          intent: r.case.intent,
          pass: r.pass,
          failures: r.failures,
          actualContent: r.actualContent,
          actualCart: r.actualCart,
          actualTotal: r.actualTotal,
          actualPhase: r.actualPhase,
          actualConfirmed: r.actualConfirmed,
        })),
      },
      null,
      2
    )
  );
  console.log(`\nWrote full results to ${jsonOut}`);
}

process.exit(failed.length > 0 ? 1 : 0);
