import type { TestCase } from "../types";
import { MENU } from "@/lib/think-food-ai";

// ─── Programmatic, menu-driven test generation ─────────────────────────────
// Hand-authoring 1000+ cases with the same rigor as the curated categories
// isn't tractable, so this file generates a large, *provably correct* battery
// of cases directly from the live MENU data: every dimension below derives
// its expected outcome mechanically from the item's own name/price, not from
// guesswork, so a failure here is a real engine bug, not a flaky assertion.
//
// Every orderable menu item (toppings excluded — they're chat-unorderable by
// design) is run through ~13 phrasing dimensions: clean English, Roman Urdu,
// explicit digit/word quantities, filler-padded, copy-pasted PKR lines,
// two-item combos (both "aur" and comma separators), social-filler prefixes,
// ALL-CAPS, removal after add, quantity update, and a pure price inquiry that
// must NOT mutate the cart.

interface OrderableItem {
  name: string;
  price: number;
}

const ITEMS: OrderableItem[] = [];
const CATEGORY_OF = new Map<string, string>();
for (const [catKey, cat] of Object.entries(MENU)) {
  if (catKey === "toppings") continue; // not orderable via chat — separately tested
  for (const item of cat.items) {
    ITEMS.push({ name: item.name, price: item.price });
    CATEGORY_OF.set(item.name, catKey);
  }
}

// Step 10 coverage manifest — every dimension loop below runs unconditionally
// for every item in ITEMS (dimension P's 3-item-cart guard is verified never
// to exclude an item: offsets +5/+11 never collide with the item itself or
// each other across 39 items), so coverage is "every dimension, every
// product" by construction. coverage-report.ts cross-checks this against
// MENU_INVENTORY and FAILS the suite if any product is missing.
export const COVERAGE_DIMENSIONS = [
  "individual",
  "alias",
  "pair",
  "remove",
  "qtyUpdate",
  "priceInquiry",
  "checkout",
  "replace",
] as const;
export const coverageManifest: Record<string, readonly string[]> = {};
for (const item of ITEMS) {
  // "replace" needs another item in the SAME category to swap to — a
  // single-item category (Steaks: only Chicken Steak) has no such partner,
  // so that dimension is genuinely not applicable, not a gap.
  const hasSameCategoryPartner = ITEMS.some(
    (other) => other.name !== item.name && CATEGORY_OF.get(other.name) === CATEGORY_OF.get(item.name)
  );
  coverageManifest[item.name] = hasSameCategoryPartner
    ? COVERAGE_DIMENSIONS
    : COVERAGE_DIMENSIONS.filter((d) => d !== "replace");
}

const cases: TestCase[] = [];
let n = 0;
const id = () => `gen-${String(++n).padStart(4, "0")}`;

for (let i = 0; i < ITEMS.length; i++) {
  const item = ITEMS[i];
  const lname = item.name.toLowerCase();

  // A — clean English digit qty
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `clean digit add — ${item.name}`,
    message: `1 ${lname}`,
    intent: `add ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // B — Roman Urdu chahiye
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `roman urdu add — ${item.name}`,
    message: `ek ${lname} chahiye`,
    intent: `add ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // C — digit qty 2
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `qty 2 digit add — ${item.name}`,
    message: `2 ${lname}`,
    intent: `add 2x ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 2 }], totalAfter: item.price * 2 },
  });

  // D — Urdu word qty 3 + verb
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `qty 3 urdu word add — ${item.name}`,
    message: `teen ${lname} de do`,
    intent: `add 3x ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 3 }], totalAfter: item.price * 3 },
  });

  // E — trailing filler words after item
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `filler-padded add — ${item.name}`,
    message: `1 ${lname} please jaldi`,
    intent: `add ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // H — copy-pasted PKR line
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `copied PKR line add — ${item.name}`,
    message: `${item.name} — PKR ${item.price} chahiye`,
    intent: `add ${item.name} from copied line`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // N — social-filler prefix
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `social-filler prefix add — ${item.name}`,
    message: `bhai ek ${lname} dedo`,
    intent: `add ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // O — ALL CAPS (case-insensitivity)
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `all-caps add — ${item.name}`,
    message: `${item.name.toUpperCase()} CHAHIYE`,
    intent: `add ${item.name}`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 1 }], totalAfter: item.price },
  });

  // F — add then remove by full name
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `remove after add — ${item.name}`,
    setup: [`ek ${lname} chahiye`],
    message: `${lname} hata do`,
    intent: `remove ${item.name}`,
    expect: { cartChanges: true, cartAfter: [] },
  });

  // G — add then update quantity to 5
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `quantity update — ${item.name}`,
    setup: [`ek ${lname} chahiye`],
    message: `5 ${lname} kar do`,
    intent: `update ${item.name} qty to 5`,
    expect: { cartChanges: true, cartAfter: [{ name: item.name, qty: 5 }], totalAfter: item.price * 5 },
  });

  // K — pure price inquiry must NOT add to cart
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `price inquiry, no add — ${item.name}`,
    message: `${lname} kitna hai`,
    intent: `price inquiry for ${item.name}`,
    expect: { cartChanges: false, contains: [String(item.price)] },
  });

  // J — two-item combo with "aur" (paired with next item, wraps around)
  const partnerAur = ITEMS[(i + 1) % ITEMS.length];
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `combo with aur — ${item.name} + ${partnerAur.name}`,
    message: `ek ${lname} aur ek ${partnerAur.name.toLowerCase()}`,
    intent: `add ${item.name} + ${partnerAur.name}`,
    expect: {
      cartChanges: true,
      cartAfter:
        item.name === partnerAur.name
          ? [{ name: item.name, qty: 1 }]
          : [
              { name: item.name, qty: 1 },
              { name: partnerAur.name, qty: 1 },
            ],
      totalAfter: item.name === partnerAur.name ? item.price : item.price + partnerAur.price,
    },
  });

  // M — two-item combo with comma (paired with item two ahead, wraps around)
  const partnerComma = ITEMS[(i + 2) % ITEMS.length];
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `combo with comma — ${item.name} + ${partnerComma.name}`,
    message: `ek ${lname}, ek ${partnerComma.name.toLowerCase()}`,
    intent: `add ${item.name} + ${partnerComma.name}`,
    expect: {
      cartChanges: true,
      cartAfter:
        item.name === partnerComma.name
          ? [{ name: item.name, qty: 1 }]
          : [
              { name: item.name, qty: 1 },
              { name: partnerComma.name, qty: 1 },
            ],
      totalAfter: item.name === partnerComma.name ? item.price : item.price + partnerComma.price,
    },
  });

  // P — remove the middle item out of a 3-item cart, by full name
  const sideA = ITEMS[(i + 5) % ITEMS.length];
  const sideB = ITEMS[(i + 11) % ITEMS.length];
  if (item.name !== sideA.name && item.name !== sideB.name && sideA.name !== sideB.name) {
    cases.push({
      id: id(),
      category: "Generated: item coverage",
      description: `remove middle of 3-item cart — ${item.name}`,
      setup: [`ek ${sideA.name.toLowerCase()} chahiye`, `ek ${lname} chahiye`, `ek ${sideB.name.toLowerCase()} chahiye`],
      message: `${lname} hata do`,
      intent: `remove only ${item.name}, leave the other two untouched`,
      expect: {
        cartChanges: true,
        cartAfter: [
          { name: sideA.name, qty: 1 },
          { name: sideB.name, qty: 1 },
        ],
        totalAfter: sideA.price + sideB.price,
      },
    });
  }

  // Q — add then immediately trigger checkout in the same message
  cases.push({
    id: id(),
    category: "Generated: item coverage",
    description: `add then checkout in one message — ${item.name}`,
    message: `1 ${lname}, place order`,
    intent: `add ${item.name} and move to checkout review`,
    expect: {
      cartChanges: true,
      cartAfter: [{ name: item.name, qty: 1 }],
      totalAfter: item.price,
      phaseAfter: "checkout_review",
    },
  });

  // R — replace: add this item, then swap to a DIFFERENT item in the SAME
  // category by name ("X kar do"), verifying the swap removes the original
  // and adds the new one rather than just adding a second item.
  {
    const sameCat = ITEMS.filter((other) => other.name !== item.name && CATEGORY_OF.get(other.name) === CATEGORY_OF.get(item.name));
    if (sameCat.length > 0) {
      const swapTo = sameCat[i % sameCat.length];
      cases.push({
        id: id(),
        category: "Generated: item coverage",
        description: `replace within category — ${item.name} → ${swapTo.name}`,
        setup: [`ek ${lname} chahiye`],
        message: `${swapTo.name.toLowerCase()} kar do`,
        intent: `swap ${item.name} for ${swapTo.name} (same category)`,
        expect: {
          cartChanges: true,
          cartAfter: [{ name: swapTo.name, qty: 1 }],
          totalAfter: swapTo.price,
        },
      });
    }
  }
}

export const generatedItemCoverageCases: TestCase[] = cases;
