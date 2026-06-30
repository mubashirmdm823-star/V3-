import type { TestCase } from "../types";

// ─── Step 8 — Negative / safety tests ──────────────────────────────────────
// Two failure modes that must never happen: (1) an off-menu item silently
// lands in the cart, and (2) a "remove X" for something that was never
// ordered silently does nothing wrong (or worse, removes a different item by
// mistake) instead of clearly saying X isn't in the cart.
export const negativeSafetyCases: TestCase[] = [
  // ── Unavailable items must never be added ──────────────────────────────
  {
    id: "ns-001",
    category: "Negative / safety",
    description: "coke alone — never added, no cart created",
    message: "ek coke de do",
    intent: "drinks unavailable, cart stays empty",
    expect: { cartChanges: false, cartAfter: [], contains: ["Drinks"] },
  },
  {
    id: "ns-002",
    category: "Negative / safety",
    description: "beef burger — not on menu, offered an alternative but not auto-added",
    message: "ek beef burger de do",
    intent: "off-menu, suggestion only, nothing added without confirmation",
    expect: { cartChanges: false, cartAfter: [] },
  },
  {
    id: "ns-003",
    category: "Negative / safety",
    description: "biryani alone — never added",
    message: "chicken biryani chahiye",
    intent: "off-menu, rice alternatives suggested, cart stays empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
  {
    id: "ns-004",
    category: "Negative / safety",
    description: "shawarma alone — never added",
    message: "ek shawarma de do",
    intent: "off-menu, wrap/gyro alternatives suggested, cart stays empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
  {
    id: "ns-005",
    category: "Negative / safety",
    description: "broast alone — never added",
    message: "broast chicken de do",
    intent: "off-menu, crispy chicken alternatives suggested, cart stays empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
  {
    id: "ns-006",
    category: "Negative / safety",
    description: "water/paani — never added",
    message: "ek paani ki bottle de do",
    intent: "off-menu, cart stays empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
  {
    id: "ns-007",
    category: "Negative / safety",
    description: "coke mixed with a valid item — coke never lands in cart, valid item still added",
    message: "ek zinger burger aur ek coke de do",
    intent: "zinger burger added, coke flagged unavailable and excluded from cart",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      totalAfter: 500,
      contains: ["Unavailable"],
    },
  },
  {
    id: "ns-008",
    category: "Negative / safety",
    description: "beef burger mixed with a valid item — only the valid item is added",
    message: "ek beef burger aur ek pasta small chahiye",
    intent: "pasta small added, beef burger not silently added as any burger",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Pasta Small", qty: 1 }],
      totalAfter: 500,
    },
  },
  {
    id: "ns-009",
    category: "Negative / safety",
    description: "drinks category mention alone — never added",
    message: "drinks kya hain",
    intent: "drinks unavailable info only, cart stays empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
  // ── Wrong-remove safety: removing something never ordered must no-op ──
  {
    id: "ns-010",
    category: "Negative / safety",
    description: "cart has pizza/zinger/pasta — 'sandwich remove kar do' must no-op, cart untouched",
    setup: ["ek pizza small krdo", "ek zinger burger bhi de do", "ek pasta small bhi de do"],
    message: "sandwich remove kar do",
    intent: "sandwich was never ordered — no-op, says not in cart",
    expect: {
      cartChanges: false,
      cartAfter: [
        { name: "Pizza Small 6 inch", qty: 1 },
        { name: "Zinger Burger", qty: 1 },
        { name: "Pasta Small", qty: 1 },
      ],
      contains: ["maujood nahi"],
    },
  },
  {
    id: "ns-011",
    category: "Negative / safety",
    description: "cart has pizza/pasta only — 'burger hata do' must no-op, neither pizza nor pasta touched",
    setup: ["ek pizza small krdo", "ek pasta small bhi de do"],
    message: "burger hata do",
    intent: "burger was never ordered — no-op, cart fully intact",
    expect: {
      cartChanges: false,
      cartAfter: [
        { name: "Pizza Small 6 inch", qty: 1 },
        { name: "Pasta Small", qty: 1 },
      ],
      contains: ["maujood nahi"],
    },
  },
  {
    id: "ns-012",
    category: "Negative / safety",
    description: "cart has zinger burger only — 'pizza nikal do' must no-op, zinger burger untouched",
    setup: ["ek zinger burger krdo"],
    message: "pizza nikal do",
    intent: "pizza was never ordered — no-op, zinger burger stays",
    expect: {
      cartChanges: false,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      contains: ["maujood nahi"],
    },
  },
  {
    id: "ns-013",
    category: "Negative / safety",
    description: "cart has chowmein only — removing a never-ordered rice item must no-op",
    setup: ["ek chicken chowmein krdo"],
    message: "rice hata do",
    intent: "rice was never ordered — no-op, chowmein stays",
    expect: {
      cartChanges: false,
      cartAfter: [{ name: "Chicken Chowmein", qty: 1 }],
      contains: ["maujood nahi"],
    },
  },
  {
    id: "ns-014",
    category: "Negative / safety",
    description: "empty cart — any remove attempt must no-op, not crash",
    message: "zinger burger hata do",
    intent: "nothing to remove, cart was already empty",
    expect: { cartChanges: false, cartAfter: [] },
  },
];
