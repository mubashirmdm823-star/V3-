import type { TestCase } from "../types";

// Regression tests for two real-conversation bugs reported after the v1 red-team
// pass:
//
// 1. Category-clarification CONTINUATION must distribute a multi-variant
//    breakdown reply ("2 small 2 large 1 alfredo") across each named variant
//    with its OWN quantity, not dump the original total ("5 pasta") onto
//    whichever single variant a crude scorer happens to pick first.
// 2. "dikhao"/"show"/"batao"/"options"/"menu" mean the customer wants
//    INFORMATION, not an action — they must never be read as an implicit
//    ADD, even when the rest of the message would otherwise resolve to an
//    unambiguous single item (e.g. bare "zinger").
//
// Both fixes are in the shared intent engine (detectsOrderSignal / the
// pendingClarifications resolver), so they apply to every category and every
// menu item — not just the exact phrasings below.
export const clarificationAndShowIntentCases: TestCase[] = [
  {
    id: "cs-001",
    category: "Clarification & show-intent regressions",
    description:
      "Test 1 — pasta clarification breakdown reply distributes qty per variant, not 5x Pasta Small",
    setup: ["mere 5 pasta hain"],
    message: "2 small 2 large 1 alfredo",
    intent: "distribute breakdown across 3 pasta variants",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pasta Small", qty: 2 },
        { name: "Pasta Large", qty: 2 },
        { name: "Alfredo Pasta white sauce", qty: 1 },
      ],
      totalAfter: 500 * 2 + 600 * 2 + 850,
    },
  },
  {
    id: "cs-002",
    category: "Clarification & show-intent regressions",
    description:
      "Test 2 — 'or zinger dikhao' after an add must show options, not add a second zinger",
    setup: ["ek zinger burger kardo"],
    message: "or zinger dikhao",
    intent: "show burger/zinger options, cart untouched",
    expect: {
      cartChanges: false,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      contains: ["Burger"],
    },
  },
  {
    id: "cs-003",
    category: "Clarification & show-intent regressions",
    description: "Test 3 — pizza clarification breakdown reply distributes qty per variant",
    setup: ["5 pizza chahiye"],
    message: "2 large 2 regular 1 small",
    intent: "distribute breakdown across 3 pizza variants",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pizza Large 12 inch", qty: 2 },
        { name: "Pizza Regular 9 inch", qty: 2 },
        { name: "Pizza Small 6 inch", qty: 1 },
      ],
      totalAfter: 1200 * 2 + 850 * 2 + 550,
    },
  },
  {
    id: "cs-004",
    category: "Clarification & show-intent regressions",
    description: "Test 4 — 'burger options batao' shows options, adds nothing",
    message: "burger options batao",
    intent: "show burger options, no add",
    expect: { cartChanges: false, contains: ["Burger"] },
  },
  {
    id: "cs-005",
    category: "Clarification & show-intent regressions",
    description: "rice clarification breakdown reply (global rule — every category with variants)",
    setup: ["mujhe 4 rice chahiye"],
    message: "2 chicken fried 1 egg 1 vegetable",
    intent: "distribute breakdown across 3 rice variants",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Chicken Fried Rice", qty: 2 },
        { name: "Egg Rice", qty: 1 },
        { name: "Vegetable Rice", qty: 1 },
      ],
      totalAfter: 450 * 2 + 450 + 400,
    },
  },
  {
    id: "cs-006",
    category: "Clarification & show-intent regressions",
    description: "sandwich clarification breakdown reply (global rule)",
    setup: ["3 sandwich chahiye"],
    message: "1 club 1 bbq 1 grill",
    intent: "distribute breakdown across 3 sandwich variants",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Club Sandwich", qty: 1 },
        { name: "BBQ Sandwich", qty: 1 },
        { name: "Grill Sandwich", qty: 1 },
      ],
      totalAfter: 500 + 550 + 650,
    },
  },
  {
    id: "cs-007",
    category: "Clarification & show-intent regressions",
    description: "single-variant clarification reply (no breakdown) keeps the original total quantity behavior",
    setup: ["mere 5 pasta hain"],
    message: "alfredo",
    intent: "all 5 are alfredo — pre-existing single-variant behavior must be unchanged",
    expect: { cartChanges: true, cartAfter: [{ name: "Alfredo Pasta white sauce", qty: 5 }], totalAfter: 4250 },
  },
  {
    id: "cs-008",
    category: "Clarification & show-intent regressions",
    description: "'zinger options batao' shows options, no add, no setup needed",
    message: "zinger options batao",
    intent: "show zinger/burger options, no add",
    expect: { cartChanges: false, contains: ["Burger"] },
  },
  {
    id: "cs-009",
    category: "Clarification & show-intent regressions",
    description: "'burger menu dikhao' shows the burger menu specifically, no add",
    message: "burger menu dikhao",
    intent: "show burger menu, no add",
    expect: { cartChanges: false, contains: ["Burger"] },
  },
  {
    id: "cs-010",
    category: "Clarification & show-intent regressions",
    description: "bare 'menu dikhao' shows the full menu, no add",
    message: "menu dikhao",
    intent: "show full menu, no add",
    expect: { cartChanges: false, contains: ["Burgers", "Pizza"] },
  },
  {
    id: "cs-011",
    category: "Clarification & show-intent regressions",
    description: "'konsay zinger hain' (which zingers are there) shows options, no add",
    message: "konsay zinger hain",
    intent: "show burger options, no add",
    expect: { cartChanges: false, contains: ["Burger"] },
  },
  {
    id: "cs-012",
    category: "Clarification & show-intent regressions",
    description: "explicit add still works for an unambiguous item — show-intent fix must not over-trigger on ordinary adds",
    message: "ek smoke burger add karo",
    intent: "explicit add — must still add",
    expect: { cartChanges: true, cartAfter: [{ name: "Smoke Burger", qty: 1 }], totalAfter: 550 },
  },
  {
    id: "cs-013",
    category: "Clarification & show-intent regressions",
    description: "'kardo' (no dikhao/show word at all) still adds normally — show-intent fix must not over-trigger",
    message: "ek smoke burger kardo",
    intent: "explicit add via kardo",
    expect: { cartChanges: true, cartAfter: [{ name: "Smoke Burger", qty: 1 }], totalAfter: 550 },
  },
  {
    id: "cs-016",
    category: "Clarification & show-intent regressions",
    description:
      "explicit add intent does NOT bypass family ambiguity — Issue 3: even with clear add intent, bare 'zinger' must still ask which variant",
    message: "ek zinger add karo",
    intent: "ambiguous family — ask which zinger, even though add intent is explicit",
    expect: { cartChanges: false, contains: ["Zinger Burger", "Zinger Burger W/C", "Jumbo Zinger"] },
  },
  {
    id: "cs-014",
    category: "Clarification & show-intent regressions",
    description: "show-then-add in two separate turns — show does not add, the following explicit add does",
    setup: ["zinger options dikhao"],
    message: "ek zinger burger chahiye",
    intent: "first turn shows options only, second turn adds",
    expect: { cartChanges: true, cartAfter: [{ name: "Zinger Burger", qty: 1 }], totalAfter: 500 },
  },
  {
    id: "cs-015",
    category: "Clarification & show-intent regressions",
    description: "pizza fries clarification breakdown reply (global rule, two-variant category)",
    setup: ["2 pizza fries chahiye"],
    message: "1 small 1 large",
    intent: "distribute breakdown across pizza fries sizes",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pizza Fries Small Box", qty: 1 },
        { name: "Pizza Fries Large Box", qty: 1 },
      ],
      totalAfter: 500 + 600,
    },
  },
  {
    id: "cs-017",
    category: "Clarification & show-intent regressions",
    description:
      "Issue 1 (verbatim) — multiple DIFFERENT categories/families in one sentence must ALL be processed, " +
      "none silently dropped. Bare 'zinger' is itself a 3-variant family, so all three segments end up asking " +
      "for clarification — the key regression this guards is that pasta and chowmein are NOT dropped.",
    message: "2 zinger 2 pasta or 2 chowmien kardo",
    intent: "ask about zinger family, pasta category, AND chowmein category — all three, none dropped",
    expect: {
      cartChanges: false,
      contains: ["Zinger Burger", "Pasta Small", "Chicken Chowmein"],
    },
  },
  {
    id: "cs-018",
    category: "Clarification & show-intent regressions",
    description: "Issue 2 (verbatim) — same-category multiple EXACT variants in one message must all be added, not just first/last",
    message: "2 Jumbo Zinger 2 Zinger Burger W/C or 2 Spicy Stuff Burger",
    intent: "add all three named burger variants, none dropped",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Jumbo Zinger", qty: 2 },
        { name: "Zinger Burger W/C", qty: 2 },
        { name: "Spicy Stuff Burger", qty: 2 },
      ],
      totalAfter: 750 * 2 + 550 * 2 + 700 * 2,
    },
  },
  {
    id: "cs-019",
    category: "Clarification & show-intent regressions",
    description: "Issue 3 (verbatim) — '5 zinger' must ask which variant, not silently default to Zinger Burger",
    message: "5 zinger",
    intent: "ask which of the 3 zinger variants, preserving the total qty of 5 for the follow-up split",
    expect: {
      cartChanges: false,
      contains: ["Zinger Burger", "Zinger Burger W/C", "Jumbo Zinger", "5"],
    },
  },
  {
    id: "cs-020",
    category: "Clarification & show-intent regressions",
    description: "Issue 3 follow-up (verbatim) — breakdown reply after the zinger family clarification",
    setup: ["5 zinger"],
    message: "2 Jumbo Zinger 2 Zinger Burger W/C 1 Zinger Burger",
    intent: "distribute the 5 across the 3 named zinger variants",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Jumbo Zinger", qty: 2 },
        { name: "Zinger Burger W/C", qty: 2 },
        { name: "Zinger Burger", qty: 1 },
      ],
      totalAfter: 750 * 2 + 550 * 2 + 500,
    },
  },
  {
    id: "cs-021",
    category: "Clarification & show-intent regressions",
    description: "family ambiguity is global — 'pizza fries' style 2-item ties already worked; sanity-check a 3-item family stays correct with qty>1",
    message: "3 zinger chahiye",
    intent: "ask which zinger, total qty 3 preserved",
    expect: { cartChanges: false, contains: ["Zinger Burger", "Zinger Burger W/C", "Jumbo Zinger", "3"] },
  },
  {
    id: "cs-022",
    category: "Clarification & show-intent regressions",
    description:
      "global segmentation across Steak/Roll/Starter — an exact unambiguous item (steak) adds while two " +
      "DIFFERENT ambiguous categories (roll, starter) both get asked about, neither dropped",
    message: "2 roll 1 starter 1 steak",
    intent: "add Chicken Steak; ask about roll AND starter, both preserved",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Chicken Steak", qty: 1 }],
      contains: ["Roll", "Starter", "Wrap", "Gyro", "Hot Shot", "Chicken Strips"],
    },
  },
  {
    id: "cs-023",
    category: "Clarification & show-intent regressions",
    description: "cross-category family ambiguity — 'chicken' alone spans Sandwich/Steak/Starter/Chowmein/Rice, must ask rather than guess",
    message: "3 chicken",
    intent: "ask which chicken item, no silent guess",
    expect: { cartChanges: false },
  },
  {
    id: "cs-024",
    category: "Clarification & show-intent regressions",
    description: "cross-category family breakdown reply — each named chicken item resolves to its own category correctly",
    setup: ["3 chicken"],
    message: "1 chicken sandwich 1 chicken steak 1 chicken strips",
    intent: "distribute across Sandwich, Steak, and Starter categories from a single family clarification",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Chicken Sandwich", qty: 1 },
        { name: "Chicken Steak", qty: 1 },
        { name: "Chicken Strips 6 pcs with fries", qty: 1 },
      ],
      totalAfter: 550 + 950 + 750,
    },
  },
];
