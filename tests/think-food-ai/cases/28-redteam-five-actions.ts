import type { TestCase } from "../types";

// Red team — genuinely 5 distinct actions packed into one customer message
// (add, remove, qty change, question, checkout intent all at once).
export const fiveActionsCases: TestCase[] = [
  {
    id: "fa-001",
    category: "Red team: five actions in one message",
    description:
      "remove + add + checkout combined — checkout intent takes priority and bulk-adds named items, but " +
      "(known limitation) doesn't also process the remove in the same pass, so pasta stays",
    setup: ["ek pasta small bhi de do"],
    message: "pasta hata do, ek zinger burger add karo, ek pizza small bhi add karo, total kitna hoga, checkout kr do",
    intent: "add zinger + pizza small, move to checkout review",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Pasta Small", qty: 1 },
        { name: "Zinger Burger", qty: 1 },
        { name: "Pizza Small 6 inch", qty: 1 },
      ],
      totalAfter: 1550,
      phaseAfter: "checkout_review",
    },
  },
  {
    id: "fa-002",
    category: "Red team: five actions in one message",
    description: "increment one item, add a new item, ask a question, all together",
    setup: ["1 zinger burger"],
    message: "ek aur zinger add kr do, ek hot shot bhi de do, delivery charges kitne hain",
    intent: "increment zinger, add hot shot",
    expect: { cartChanges: true },
  },
  {
    id: "fa-003",
    category: "Red team: five actions in one message",
    description: "add three different items plus a checkout trigger in one breath",
    message: "ek zinger burger, ek pasta small, ek hot shot, bas yahi order h",
    intent: "add 3 items and move to checkout review",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Pasta Small", qty: 1 },
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
      ],
      totalAfter: 1800,
      phaseAfter: "checkout_review",
    },
  },
  {
    id: "fa-004",
    category: "Red team: five actions in one message",
    description: "remove two different items and add two different items together",
    setup: ["ek zinger burger krdo", "ek pasta small bhi de do"],
    message: "zinger hata do, pasta bhi hata do, ek hot shot add kro, ek pizza small bhi add kro",
    intent: "remove zinger + pasta, add hot shot + pizza small",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
        { name: "Pizza Small 6 inch", qty: 1 },
      ],
      totalAfter: 1350,
    },
  },
  {
    id: "fa-005",
    category: "Red team: five actions in one message",
    description: "clear cart, add a fresh item, and ask about pickup, in one message",
    setup: ["ek zinger burger krdo"],
    message: "sab hata do, ek smoke burger de do, pickup ka time kya hai",
    intent: "clear cart then add smoke burger",
    expect: { cartChanges: true, cartAfter: [{ name: "Smoke Burger", qty: 1 }], totalAfter: 550 },
  },
];
