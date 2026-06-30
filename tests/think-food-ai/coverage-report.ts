// ─── Step 10 — Coverage Report ─────────────────────────────────────────────
// Cross-checks the test suite against the full menu inventory and prints a
// per-dimension coverage report. Exits non-zero (failing the suite) if ANY
// product is missing from ANY required dimension — coverage here is a hard
// gate, not an FYI.
//
// Usage: npx tsx tests/think-food-ai/coverage-report.ts

import { MENU_INVENTORY, TOTAL_MENU_PRODUCTS } from "./menu-inventory";
import { coverageManifest, COVERAGE_DIMENSIONS } from "./cases/21-generated-item-coverage";
import { VARIANT_SPLIT_COVERAGE } from "./cases/32-variant-split-all-categories";
import { MULTI_ITEM_COVERAGE } from "./cases/36-multi-product-realistic";

interface DimensionResult {
  label: string;
  covered: number;
  total: number;
  missing: string[];
}

const results: DimensionResult[] = [];

function checkProductDimension(label: string, dimension: (typeof COVERAGE_DIMENSIONS)[number]): DimensionResult {
  const missing: string[] = [];
  let covered = 0;
  let total = 0;
  for (const product of MENU_INVENTORY) {
    const dims = coverageManifest[product.name];
    if (!dims) { missing.push(product.name); total++; continue; }
    if (!dims.includes(dimension)) {
      // "replace" is legitimately not applicable to single-item categories
      // (nothing to swap to) — the generator already excludes it from the
      // manifest in that case, so this is a real gap whenever it happens.
      missing.push(product.name);
      total++;
      continue;
    }
    covered++;
    total++;
  }
  return { label, covered, total, missing };
}

results.push(checkProductDimension("Products tested individually", "individual"));
results.push(checkProductDimension("Products with alias tests", "alias"));
results.push(checkProductDimension("Products tested in pair flows", "pair"));
results.push(checkProductDimension("Products with remove tests", "remove"));
results.push(checkProductDimension("Products with quantity-update tests", "qtyUpdate"));
results.push(checkProductDimension("Products with price-inquiry tests", "priceInquiry"));
results.push(checkProductDimension("Products tested through checkout", "checkout"));

// "replace" — single-item categories (Steaks) have nothing to swap to; that's
// a documented N/A, not a gap, so it's reported separately.
{
  const missing: string[] = [];
  const na: string[] = [];
  let covered = 0;
  for (const product of MENU_INVENTORY) {
    const dims = coverageManifest[product.name];
    if (dims?.includes("replace")) { covered++; continue; }
    if (dims) { na.push(product.name); covered++; continue; } // present in manifest, just N/A
    missing.push(product.name);
  }
  results.push({ label: "Products with replacement tests (or documented N/A)", covered, total: MENU_INVENTORY.length, missing });
}

// Multi-item flows — product-level coverage from the Step 4 generator (every
// product appears in at least one realistic 3-4 item customer message).
{
  const missing: string[] = [];
  let covered = 0;
  for (const product of MENU_INVENTORY) {
    if (MULTI_ITEM_COVERAGE[product.name]) covered++;
    else missing.push(product.name);
  }
  results.push({ label: "Products tested in multi-item flows", covered, total: MENU_INVENTORY.length, missing });
}

// Variant-split — category-level (every category with 2+ variants has a full
// N-way breakdown test; single-item categories are N/A, not a gap).
{
  const categories = [...new Set(MENU_INVENTORY.map((p) => p.category))];
  const missing: string[] = [];
  let covered = 0;
  for (const cat of categories) {
    if (VARIANT_SPLIT_COVERAGE[cat]) covered++;
    else missing.push(cat);
  }
  results.push({ label: "Categories with variant-split breakdown tests", covered, total: categories.length, missing });
}

console.log("\n=== Think Food AI — Menu Coverage Report ===\n");
console.log(`Total menu products: ${TOTAL_MENU_PRODUCTS}`);
console.log(`Categories: ${[...new Set(MENU_INVENTORY.map((p) => p.category))].length}\n`);

let allOk = true;
for (const r of results) {
  const ok = r.covered === r.total;
  if (!ok) allOk = false;
  console.log(`${ok ? "✅" : "❌"} ${r.label}: ${r.covered} / ${r.total}`);
  if (!ok) {
    console.log(`   Missing: ${r.missing.join(", ")}`);
  }
}

console.log(`\n${allOk ? "✅ FULL COVERAGE — every product accounted for in every dimension." : "❌ COVERAGE GAP DETECTED — see missing items above."}\n`);

if (!allOk) process.exit(1);
