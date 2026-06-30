import { MENU } from "@/lib/think-food-ai";

// ─── Step 1 — Full Menu Inventory ──────────────────────────────────────────
// The complete, authoritative list of every individually-orderable Think Food
// product, derived directly from the live MENU export so it can never drift
// out of sync with the actual menu data. Toppings are intentionally excluded:
// they are not independently orderable via chat (see TOPPING_INTENT in
// lib/think-food-ai.ts, which explicitly rejects standalone topping orders).
//
// This is the single source of truth the rest of the QA system (the
// per-product generator, the coverage report, and the self-fixing loop) is
// built from — every test file in this directory that claims "every product"
// coverage does so by iterating MENU_INVENTORY, not a hand-typed list that
// could silently fall behind a future menu change.

export interface MenuInventoryItem {
  /** Stable slug derived from the product name, e.g. "zinger-burger-w-c" */
  id: string;
  name: string;
  /** Raw MENU category key, e.g. "burgers", "pizzaFries" */
  category: string;
  /** Customer-facing category label used by getCategoryKey/CATEGORY_ONLY in the engine */
  categoryLabel: string;
  price: number;
  /** Known short-form / Roman-Urdu / typo aliases real customers use for this product */
  aliases: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  burgers: "burger",
  sandwiches: "sandwich",
  pizza: "pizza",
  pizzaFries: "fries",
  rolls: "roll",
  pasta: "pasta",
  noodles: "chowmein",
  rice: "rice",
  starters: "starter",
  steaks: "steak",
};

// Known realistic aliases per product — short forms, Roman Urdu, common typos.
// Not exhaustive (the per-product generator also derives mechanical variants
// like lowercasing/no-spaces), just the hand-known "what a real customer
// actually types" shortcuts worth asserting explicitly.
const ALIASES: Record<string, string[]> = {
  "Zinger Burger": ["zinger burger", "zngr burger", "zinger"],
  "Zinger Burger W/C": ["zinger burger w/c", "zinger burger with cheese", "zinger wc"],
  "Jumbo Zinger": ["jumbo", "jumbo zinger"],
  "Think Food SP Burger": ["sp burger", "think food sp burger"],
  "Smoke Burger": ["smoke burger"],
  "Spicy Stuff Burger": ["spicy stuff", "spicy burger"],
  "Chicken Sandwich": ["chicken sandwich", "chikn sandwich"],
  "Club Sandwich": ["club sandwich", "club"],
  "BBQ Sandwich": ["bbq sandwich", "bbq"],
  "Smoke Sandwich": ["smoke sandwich"],
  "Vegi Sandwich": ["vegi sandwich", "veggie sandwich"],
  "Mexican Sandwich": ["mexican sandwich"],
  "Crispy Sandwich": ["crispy sandwich"],
  "Think Food Special Sandwich": ["special sandwich", "think food special sandwich"],
  "Grill Sandwich": ["grill sandwich", "grilled sandwich"],
  "Pizza Large 12 inch": ["pizza large", "large pizza", "piza large"],
  "Pizza Regular 9 inch": ["pizza regular", "regular pizza", "piza regular"],
  "Pizza Small 6 inch": ["pizza small", "small pizza", "piza small"],
  "Think Food Special Pizza": ["special pizza", "think food special pizza"],
  "Mexican Pizza": ["mexican pizza"],
  "Pizza Fries Small Box": ["pizza fries small", "fries small"],
  "Pizza Fries Large Box": ["pizza fries large", "fries large"],
  "Wrap": ["wrap"],
  "Gyro": ["gyro", "gyroo"],
  "Pasta Small": ["pasta small", "psta small"],
  "Pasta Large": ["pasta large", "psta large"],
  "Alfredo Pasta white sauce": ["alfredo", "alfredo pasta", "white sauce pasta"],
  "Macaroni Pasta red sauce": ["macaroni", "macaroni pasta", "red sauce pasta"],
  "Mexican Pasta white sauce": ["mexican pasta"],
  "Chicken Chowmein": ["chicken chowmein", "chicken noodles", "chikn chowmien"],
  "Vegetable Chowmein": ["vegetable chowmein", "veg chowmein", "vegetable noodles"],
  "Chicken Fried Rice": ["chicken fried rice", "fried rice"],
  "Vegetable Rice": ["vegetable rice", "veg rice"],
  "Egg Rice": ["egg rice"],
  "Singaporean Rice": ["singaporean rice", "singapore rice"],
  "White Singaporean": ["white singaporean"],
  "Chicken Strips 6 pcs with fries": ["chicken strips", "strips"],
  "Hot Shot 8 pcs with fries": ["hot shot", "hotshot"],
  "Chicken Steak": ["chicken steak", "steak"],
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const MENU_INVENTORY: MenuInventoryItem[] = (() => {
  const out: MenuInventoryItem[] = [];
  for (const [catKey, cat] of Object.entries(MENU)) {
    if (catKey === "toppings") continue; // not independently orderable via chat
    for (const item of cat.items) {
      out.push({
        id: slugify(item.name),
        name: item.name,
        category: catKey,
        categoryLabel: CATEGORY_LABELS[catKey] ?? catKey,
        price: item.price,
        aliases: ALIASES[item.name] ?? [item.name.toLowerCase()],
      });
    }
  }
  return out;
})();

export const TOTAL_MENU_PRODUCTS = MENU_INVENTORY.length;

// Grouped by category, for variant-split / category-clarification tests.
export const MENU_BY_CATEGORY: Record<string, MenuInventoryItem[]> = (() => {
  const out: Record<string, MenuInventoryItem[]> = {};
  for (const item of MENU_INVENTORY) {
    (out[item.category] ??= []).push(item);
  }
  return out;
})();
