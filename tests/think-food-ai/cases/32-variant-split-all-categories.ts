import type { TestCase } from "../types";
import { MENU_BY_CATEGORY } from "../menu-inventory";

// ─── Step 5 — Category Variant Split Tests, every category ────────────────
// "5 pasta" → AI asks which pasta → "2 small 2 large 1 alfredo" must
// distribute the quantity across the named variants, not dump it onto one
// guessed item. This file proves that rule holds for EVERY menu category
// that has 2+ variants — not just the ones already exercised incidentally by
// other test files — by generating one full N-way breakdown test per
// category directly from MENU_BY_CATEGORY.
//
// Categories with a "category-only" trigger word that the engine recognises
// (CATEGORY_ONLY in lib/think-food-ai.ts) get a "N <category>" clarification
// opener. Steaks (1 item, no variants to split) is intentionally excluded —
// see VARIANT_SPLIT_COVERAGE below for the documented reason.

const CATEGORY_TRIGGER_WORD: Record<string, string> = {
  burgers: "burger",
  sandwiches: "sandwich",
  pizza: "pizza",
  pizzaFries: "pizza fries",
  rolls: "roll",
  pasta: "pasta",
  noodles: "chowmein",
  rice: "rice",
  starters: "starter",
};

const cases: TestCase[] = [];
let n = 0;
const id = () => `vsplit-${String(++n).padStart(3, "0")}`;

// category key -> whether this file generated a full N-way breakdown test for it
export const VARIANT_SPLIT_COVERAGE: Record<string, boolean> = {};

for (const [catKey, items] of Object.entries(MENU_BY_CATEGORY)) {
  const triggerWord = CATEGORY_TRIGGER_WORD[catKey];
  if (!triggerWord || items.length < 2) {
    // Steaks has only 1 item — there is nothing to "split"; not a gap.
    VARIANT_SPLIT_COVERAGE[catKey] = items.length < 2;
    continue;
  }

  const total = items.length;
  const replyMessage = items.map((it) => `1 ${it.name.toLowerCase()}`).join(" ");
  const expectedTotal = items.reduce((s, it) => s + it.price, 0);

  cases.push({
    id: id(),
    category: "Variant split — every category",
    description: `${catKey}: full ${total}-way breakdown reply distributes one of each variant`,
    setup: [`${total} ${triggerWord}`],
    message: replyMessage,
    intent: `ask which ${triggerWord} for qty ${total}, then distribute 1 each across all ${total} variants`,
    expect: {
      cartChanges: true,
      cartAfter: items.map((it) => ({ name: it.name, qty: 1 })),
      totalAfter: expectedTotal,
    },
  });

  VARIANT_SPLIT_COVERAGE[catKey] = true;
}

export const variantSplitAllCategoriesCases: TestCase[] = cases;
