import type { TestCase } from "../types";

// ─── Step 6 — Cart changes BEFORE final confirmation ───────────────────────
// A customer reaching checkout_review (via "Place Order") hasn't committed to
// anything yet — they can still add, remove, replace, change quantity, or
// clear the cart. Any such edit must leave checkout_review (the stale review
// no longer reflects the cart) and must NOT silently jump ahead to asking
// delivery/pickup — that only happens after an explicit, fresh "Confirm
// Order" once the customer is happy with the (possibly edited) cart.
export const cartChangeBeforeConfirmationCases: TestCase[] = [
  {
    id: "cbc-001",
    category: "Cart change before confirmation",
    description: "add an item while in checkout_review — leaves review, item added",
    setup: ["ek zinger burger krdo", "place order"],
    message: "ek pasta small bhi de do",
    intent: "add pasta small, drop out of stale checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Pasta Small", qty: 1 },
      ],
      totalAfter: 1000,
      phaseAfter: "item_selected",
    },
  },
  {
    id: "cbc-002",
    category: "Cart change before confirmation",
    description: "increase quantity while in checkout_review",
    setup: ["ek zinger burger krdo", "place order"],
    message: "2 zinger burger kar do",
    intent: "update qty to 2, leave checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Zinger Burger", qty: 2 }],
      totalAfter: 1000,
      phaseAfter: "item_selected",
    },
  },
  {
    id: "cbc-003",
    category: "Cart change before confirmation",
    description: "remove ONE of two items while in checkout_review — the other survives",
    setup: ["ek zinger burger krdo", "ek pasta small bhi de do", "place order"],
    message: "pasta hata do",
    intent: "remove pasta only, leave checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      totalAfter: 500,
      phaseAfter: "item_selected",
    },
  },
  {
    id: "cbc-004",
    category: "Cart change before confirmation",
    description: "remove the ONLY item while in checkout_review — cart empties, back to browsing",
    setup: ["ek zinger burger krdo", "place order"],
    message: "zinger burger hata do",
    intent: "remove last item, cart empty, browsing",
    expect: { cartChanges: true, cartAfter: [], phaseAfter: "browsing" },
  },
  {
    id: "cbc-005",
    category: "Cart change before confirmation",
    description: "clear the whole cart while in checkout_review",
    setup: ["ek zinger burger krdo", "ek pasta small bhi de do", "place order"],
    message: "sab hata do",
    intent: "clear cart, back to browsing",
    expect: { cartChanges: true, cartAfter: [], phaseAfter: "browsing" },
  },
  {
    id: "cbc-006",
    category: "Cart change before confirmation",
    description: "variant swap while in checkout_review (pasta small -> pasta large)",
    setup: ["ek pasta small krdo", "place order"],
    message: "pasta large kar do",
    intent: "swap variant, leave checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Pasta Large", qty: 1 }],
      totalAfter: 600,
      phaseAfter: "item_selected",
    },
  },
  {
    id: "cbc-007",
    category: "Cart change before confirmation",
    description: "after editing the cart post-review, Confirm Order re-shows a fresh review instead of jumping to delivery/pickup",
    setup: ["ek zinger burger krdo", "place order", "ek pasta small bhi de do"],
    message: "confirm krdo",
    intent: "re-enter checkout_review with the edited cart, do not ask delivery/pickup yet",
    expect: {
      cartChanges: false,
      phaseAfter: "checkout_review",
      contains: ["Total"],
      notContains: ["Delivery"],
    },
  },
  {
    id: "cbc-008",
    category: "Cart change before confirmation",
    description: "after adding mid-review, Place Order again shows an up-to-date review reflecting the new item",
    setup: ["ek zinger burger krdo", "place order", "ek pasta small bhi de do"],
    message: "place order",
    intent: "fresh review reflects both items and the updated total",
    expect: {
      cartChanges: false,
      phaseAfter: "checkout_review",
      contains: ["Zinger Burger", "Pasta Small", "1000"],
    },
  },
  {
    id: "cbc-009",
    category: "Cart change before confirmation",
    description: "explicit Confirm Order only THEN advances to delivery/pickup ask",
    setup: ["ek zinger burger krdo", "place order"],
    message: "confirm krdo",
    intent: "no pending edits — confirm correctly advances to checkout_type",
    expect: { cartChanges: false, phaseAfter: "checkout_type", contains: ["Delivery"] },
  },
  {
    id: "cbc-010",
    category: "Cart change before confirmation",
    description: "cart edit attempted at checkout_type (after confirm, before delivery/pickup answered) is gated — cart unchanged",
    setup: ["ek zinger burger krdo", "place order", "confirm krdo"],
    message: "ek pasta small bhi de do",
    intent: "still waiting for delivery/pickup answer, cart edit ignored at this gate",
    expect: { cartChanges: false, phaseAfter: "checkout_type" },
  },
  {
    id: "cbc-011",
    category: "Cart change before confirmation",
    description: "add two more items in one message while in checkout_review — both land, neither dropped",
    setup: ["ek zinger burger krdo", "place order"],
    message: "ek pasta small aur ek wrap bhi de do",
    intent: "both items added, leave checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Zinger Burger", qty: 1 },
        { name: "Pasta Small", qty: 1 },
        { name: "Wrap", qty: 1 },
      ],
      totalAfter: 1550,
      phaseAfter: "item_selected",
    },
  },
  {
    id: "cbc-012",
    category: "Cart change before confirmation",
    description: "decrease quantity (not to zero) while in checkout_review",
    setup: ["ek zinger burger krdo", "3 zinger burger kar do", "place order"],
    message: "1 zinger burger kar do",
    intent: "qty reduced back to 1, leave checkout_review",
    expect: {
      cartChanges: true,
      cartAfter: [{ name: "Zinger Burger", qty: 1 }],
      totalAfter: 500,
      phaseAfter: "item_selected",
    },
  },
];
