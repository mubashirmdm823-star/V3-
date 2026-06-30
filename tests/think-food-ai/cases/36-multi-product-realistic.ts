import type { TestCase } from "../types";
import { MENU_INVENTORY } from "../menu-inventory";

// ─── Step 4 — Multi-product realistic 3-4 item customer messages ──────────
// Real customers don't order one thing at a time. This file proves the
// segmentation engine handles realistic, messy 3-4 item orders end to end:
// every exact item gets added, nothing in the middle of the sentence gets
// silently dropped, ambiguous category-only mentions trigger clarification
// instead of guessing, and already-flagged-unavailable items don't block the
// valid items around them.
//
// Two halves to this file:
//   1) A generator that cycles EVERY menu product through a 3-or-4-item
//      messy order at least once, across rotating realistic phrasing
//      templates — guarantees multi-item coverage for all products "by
//      construction" the same way 21/32 do for their dimensions.
//   2) Hand-curated cases targeting the specific failure modes Step 4 calls
//      out: middle-category-dropped, ambiguous-category-mid-sentence asks
//      clarification, and unavailable-item-mixed-with-valid-items.

const N = MENU_INVENTORY.length;
const at = (i: number) => MENU_INVENTORY[((i % N) + N) % N];

const cases: TestCase[] = [];
let n = 0;
const id = () => `multi-${String(++n).padStart(3, "0")}`;

// product name -> covered by at least one multi-item (3+) message in this file
export const MULTI_ITEM_COVERAGE: Record<string, boolean> = {};

const TEMPLATES_3: ((a: string, b: string, c: string) => string)[] = [
  (a, b, c) => `ek ${a} ek ${b} aur ek ${c} bhej do please`,
  (a, b, c) => `${a}, ${b} aur ${c} chahiye jaldi se`,
  (a, b, c) => `mujhe 1 ${a} or 1 ${b} and 1 ${c} chahiye`,
  (a, b, c) => `bhai ek ${a} ek ${b} ek ${c} de do`,
  (a, b, c) => `${a} aur ${b} aur ${c} order karna hai`,
  (a, b, c) => `can i get 1 ${a} 1 ${b} and 1 ${c}`,
];

const TEMPLATES_4: ((a: string, b: string, c: string, d: string) => string)[] = [
  (a, b, c, d) => `ek ${a}, ek ${b}, ek ${c} aur ek ${d} bhej do`,
  (a, b, c, d) => `mujhe 1 ${a}, 1 ${b}, 1 ${c} aur 1 ${d} chahiye sab ek ek`,
  (a, b, c, d) => `1 ${a}, 1 ${b}, 1 ${c} and 1 ${d} please jaldi karo`,
];

for (let i = 0; i < N; i++) {
  const four = i % 4 === 0;
  const a = at(i);
  const b = at(i + 13);
  const c = at(i + 26);

  if (four) {
    const d = at(i + 33);
    const names = [a, b, c, d];
    const template = TEMPLATES_4[i % TEMPLATES_4.length];
    const message = template(a.name.toLowerCase(), b.name.toLowerCase(), c.name.toLowerCase(), d.name.toLowerCase());
    cases.push({
      id: id(),
      category: "Multi-product realistic — generated",
      description: `4-item messy order: ${names.map((x) => x.name).join(", ")}`,
      message,
      intent: `add all 4 exact items, none dropped`,
      expect: {
        cartChanges: true,
        cartAfter: names.map((x) => ({ name: x.name, qty: 1 })),
        totalAfter: names.reduce((s, x) => s + x.price, 0),
      },
    });
  } else {
    const names = [a, b, c];
    const template = TEMPLATES_3[i % TEMPLATES_3.length];
    const message = template(a.name.toLowerCase(), b.name.toLowerCase(), c.name.toLowerCase());
    cases.push({
      id: id(),
      category: "Multi-product realistic — generated",
      description: `3-item messy order: ${names.map((x) => x.name).join(", ")}`,
      message,
      intent: `add all 3 exact items, none dropped`,
      expect: {
        cartChanges: true,
        cartAfter: names.map((x) => ({ name: x.name, qty: 1 })),
        totalAfter: names.reduce((s, x) => s + x.price, 0),
      },
    });
  }

  for (const x of four ? [a, b, c, at(i + 33)] : [a, b, c]) {
    MULTI_ITEM_COVERAGE[x.name] = true;
  }
}

// ─── Hand-curated: targeted failure-mode coverage ──────────────────────────
const curated: TestCase[] = [
  {
    id: "multicur-001",
    category: "Multi-product realistic — curated",
    description: "ambiguous category in the MIDDLE of a 3-item sentence asks clarification, side items still added",
    message: "ek zinger burger, ek pasta aur ek hot shot chahiye",
    intent: "add zinger burger + hot shot, ask which pasta (middle item ambiguous, must not drop)",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
      ],
      contains: ["pasta"],
    },
  },
  {
    id: "multicur-002",
    category: "Multi-product realistic — curated",
    description: "ambiguous category at the START, two exact items after — first item must not be dropped",
    message: "ek pizza chahiye, ek gyro aur ek vegetable rice bhi de do",
    intent: "ask which pizza, add gyro + vegetable rice (start item ambiguous, must not drop the rest)",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Gyro", qty: 1 },
        { name: "Vegetable Rice", qty: 1 },
      ],
      contains: ["pizza"],
    },
  },
  {
    id: "multicur-003",
    category: "Multi-product realistic — curated",
    description: "four exact items, very messy spacing and mixed connectors",
    message: "ek  club sandwich,ek wrap   aur ek egg rice and 1 chicken steak",
    intent: "add all 4 items despite messy spacing",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Club Sandwich", qty: 1 },
        { name: "Wrap", qty: 1 },
        { name: "Egg Rice", qty: 1 },
        { name: "Chicken Steak", qty: 1 },
      ],
      totalAfter: 500 + 550 + 450 + 950,
    },
  },
  {
    id: "multicur-004",
    category: "Multi-product realistic — curated",
    description: "valid items surrounding an unavailable item — valid ones must not be blocked",
    message: "ek jumbo zinger, ek coke aur ek mexican pizza chahiye",
    intent: "add jumbo zinger + mexican pizza, flag coke unavailable, neither valid item dropped",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Jumbo Zinger", qty: 1 },
        { name: "Mexican Pizza", qty: 1 },
      ],
      contains: ["Unavailable"],
    },
  },
  {
    id: "multicur-005",
    category: "Multi-product realistic — curated",
    description: "long natural paragraph mentioning 3 exact items out of order with filler text",
    message: "bhai aaj ghar pe guests aa rahe hain so mujhe thora zyada order karna hai, ek bbq sandwich bhej dena, ek macaroni pasta bhi daal dena aur haan ek chicken fried rice bhi chahiye please fast",
    intent: "extract and add all 3 exact items buried in a long message",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "BBQ Sandwich", qty: 1 },
        { name: "Macaroni Pasta red sauce", qty: 1 },
        { name: "Chicken Fried Rice", qty: 1 },
      ],
    },
  },
  {
    id: "multicur-006",
    category: "Multi-product realistic — curated",
    description: "two ambiguous categories (pasta + pizza) and one exact item — both ask clarification, exact item still added",
    message: "ek pasta, ek pizza aur ek gyro chahiye",
    intent: "add gyro, ask which pasta and which pizza, neither ambiguity silently guessed",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Gyro", qty: 1 }],
      contains: ["pasta", "pizza"],
    },
  },
];

export const multiProductRealisticCases: TestCase[] = [...cases, ...curated];
