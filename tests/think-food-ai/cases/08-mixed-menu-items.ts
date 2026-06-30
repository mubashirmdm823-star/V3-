import type { TestCase } from "../types";

// Category 8 — multiple different menu items combined in a single order message.
export const mixedMenuItemsCases: TestCase[] = [
  {
    id: "mx-001",
    category: "Mixed menu items",
    description: "burger + pizza + rice in one message",
    message: "ek zinger burger, ek pizza large aur ek singaporean rice de do",
    intent: "add 3 different items",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Pizza Large 12 inch", qty: 1 },
        { name: "Singaporean Rice", qty: 1 },
      ],
      totalAfter: 2400,
    },
  },
  {
    id: "mx-002",
    category: "Mixed menu items",
    description: "two of one item and one of another",
    message: "do zinger burger aur ek pasta large",
    intent: "add 2 zinger + 1 pasta large",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 2 },
        { name: "Pasta Large", qty: 1 },
      ],
      totalAfter: 1600,
    },
  },
  {
    id: "mx-003",
    category: "Mixed menu items",
    description: "sandwich + roll + starter combo",
    message: "ek club sandwich, ek wrap aur ek hot shot chahiye",
    intent: "add 3 items",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Club Sandwich", qty: 1 },
        { name: "Wrap", qty: 1 },
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
      ],
      totalAfter: 1850,
    },
  },
  {
    id: "mx-004",
    category: "Mixed menu items",
    description: "one valid, one unavailable item mixed",
    message: "ek zinger burger aur ek biryani de do",
    intent: "add zinger burger, flag biryani unavailable",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      totalAfter: 500,
      contains: ["Unavailable"],
    },
  },
  {
    id: "mx-005",
    category: "Mixed menu items",
    description: "valid item plus category-only mention",
    message: "ek smoke burger aur ek pasta chahiye",
    intent: "add smoke burger, ask which pasta",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Smoke Burger", qty: 1 }],
      contains: ["pasta"],
    },
  },
  {
    id: "mx-006",
    category: "Mixed menu items",
    description: "three pasta variants in one message",
    message: "ek pasta small, ek pasta large aur ek macaroni pasta chahiye",
    intent: "add 3 different pasta items",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pasta Small", qty: 1 },
        { name: "Pasta Large", qty: 1 },
        { name: "Macaroni Pasta red sauce", qty: 1 },
      ],
      totalAfter: 1850,
    },
  },
  {
    id: "mx-007",
    category: "Mixed menu items",
    description: "duplicate item mentioned twice merges quantity",
    message: "ek zinger burger aur ek zinger burger aur ek pizza small",
    intent: "merge duplicate zinger mentions, add pizza small",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Pizza Small 6 inch", qty: 1 },
      ],
      totalAfter: 1050,
    },
  },
  {
    id: "mx-008",
    category: "Mixed menu items",
    description: "two steaks-adjacent items, starter + steak",
    message: "ek chicken strips aur ek chicken steak chahiye",
    intent: "add chicken strips + chicken steak",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Chicken Strips 6 pcs with fries", qty: 1 },
        { name: "Chicken Steak", qty: 1 },
      ],
      totalAfter: 1700,
    },
  },
  {
    id: "mx-009",
    category: "Mixed menu items",
    description: "four items across categories with comma + aur mix",
    message: "ek jumbo zinger, ek mexican pizza, ek gyro aur ek egg rice",
    intent: "add 4 items",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Jumbo Zinger", qty: 1 },
        { name: "Mexican Pizza", qty: 1 },
        { name: "Gyro", qty: 1 },
        { name: "Egg Rice", qty: 1 },
      ],
      totalAfter: 3350,
    },
  },
  {
    id: "mx-010",
    category: "Mixed menu items",
    description: "english 'and' separator with mixed items",
    message: "1 vegi sandwich and 1 vegetable chowmein",
    intent: "add vegi sandwich + vegetable chowmein",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Vegi Sandwich", qty: 1 },
        { name: "Vegetable Chowmein", qty: 1 },
      ],
      totalAfter: 1100,
    },
  },
  {
    id: "mx-011",
    category: "Mixed menu items",
    description: "three different sandwiches",
    message: "ek bbq sandwich, ek crispy sandwich aur ek mexican sandwich",
    intent: "add 3 different sandwiches",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "BBQ Sandwich", qty: 1 },
        { name: "Crispy Sandwich", qty: 1 },
        { name: "Mexican Sandwich", qty: 1 },
      ],
      totalAfter: 1750,
    },
  },
  {
    id: "mx-012",
    category: "Mixed menu items",
    description: "two premium burgers",
    message: "ek spicy stuff burger aur ek jumbo zinger",
    intent: "add spicy stuff burger + jumbo zinger",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Spicy Stuff Burger", qty: 1 },
        { name: "Jumbo Zinger", qty: 1 },
      ],
      totalAfter: 1450,
    },
  },
  {
    id: "mx-013",
    category: "Mixed menu items",
    description: "two pasta sauce variants",
    message: "ek macaroni pasta aur ek mexican pasta",
    intent: "add macaroni pasta + mexican pasta",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Macaroni Pasta red sauce", qty: 1 },
        { name: "Mexican Pasta white sauce", qty: 1 },
      ],
      totalAfter: 1600,
    },
  },
  {
    id: "mx-014",
    category: "Mixed menu items",
    description: "three rice variants",
    message: "ek vegetable rice aur ek egg rice aur ek chicken fried rice",
    intent: "add 3 rice items",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Vegetable Rice", qty: 1 },
        { name: "Egg Rice", qty: 1 },
        { name: "Chicken Fried Rice", qty: 1 },
      ],
      totalAfter: 1300,
    },
  },
  {
    id: "mx-015",
    category: "Mixed menu items",
    description: "pizza fries size + starter combo",
    message: "ek pizza fries large aur ek hot shot",
    intent: "add pizza fries large box + hot shot",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pizza Fries Large Box", qty: 1 },
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
      ],
      totalAfter: 1400,
    },
  },
];
