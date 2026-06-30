import type { TestCase } from "../types";

// Category 20 — long, natural, paragraph-style customer messages.
export const longNaturalMessagesCases: TestCase[] = [
  {
    id: "ln-001",
    category: "Long natural messages",
    description: "long polite order with multiple items and delivery mention",
    message:
      "Assalam o alaikum, mujhe ek zinger burger, ek pizza large aur ek singaporean rice chahiye, delivery ke liye order karna hai please jaldi bhej dein",
    intent: "add 3 items despite long surrounding text",
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
    id: "ln-002",
    category: "Long natural messages",
    description: "long story before getting to the order",
    message:
      "Bhai mujhe bohat bhook lagi hai aaj poora din kuch nahi khaya, please ek hot shot aur ek pasta large bhej dein jaldi se",
    intent: "add hot shot + pasta large",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Hot Shot 8 pcs with fries", qty: 1 },
        { name: "Pasta Large", qty: 1 },
      ],
      totalAfter: 1400,
    },
  },
  {
    id: "ln-003",
    category: "Long natural messages",
    description: "long message asking questions then placing an order",
    message:
      "Aap log kab tak khule rehte hain aur delivery charges kitne hain, waise mujhe ek smoke burger aur ek club sandwich chahiye",
    intent: "add smoke burger + club sandwich despite leading questions",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Smoke Burger", qty: 1 },
        { name: "Club Sandwich", qty: 1 },
      ],
      totalAfter: 1050,
    },
  },
  {
    id: "ln-004",
    category: "Long natural messages",
    description: "long message finalizing the whole flow in one go",
    setup: ["ek zinger burger krdo"],
    message:
      "theek hai bas yahi order final kar dein, ab mujhe order place karna hai please confirm kar dein jaldi",
    intent: "checkout — long-winded but clear",
    expect: { cartChanges: false, phaseAfter: "checkout_review", contains: ["Total"] },
  },
  {
    id: "ln-005",
    category: "Long natural messages",
    description: "long rambling message that changes its mind mid-sentence",
    setup: ["ek pizza large bhi de do"],
    message:
      "Actually wait, mujhe pizza nahi chahiye ab, iski jagah ek mexican pasta de do please",
    intent: "replace pizza with mexican pasta",
    expect: { cartChanges: true, cartAfter: [{ name: "Mexican Pasta white sauce", qty: 1 }], totalAfter: 850 },
  },
  {
    id: "ln-006",
    category: "Long natural messages",
    description: "long address provided naturally during checkout",
    setup: ["ek zinger burger krdo", "place order", "confirm krdo", "delivery krdo"],
    message:
      "Mera address hai House number 22, Street 5, Block C, Nazimabad number 2, Karachi, please jaldi bhej dein",
    intent: "address accepted",
    expect: { cartChanges: false, phaseAfter: "checkout_name", contains: ["naam"] },
  },
  {
    id: "ln-007",
    category: "Long natural messages",
    description: "very long message with five different items",
    message:
      "Aaj ghar mein guests aa rahe hain to mujhe ek jumbo zinger, ek mexican pizza, ek alfredo pasta, ek chicken chowmein aur ek chicken steak bhi chahiye",
    intent: "add 5 items in one long message",
    expect: {
      cartChanges: true,
      cartAfter: [
        { name: "Jumbo Zinger", qty: 1 },
        { name: "Mexican Pizza", qty: 1 },
        { name: "Alfredo Pasta white sauce", qty: 1 },
        { name: "Chicken Chowmein", qty: 1 },
        { name: "Chicken Steak", qty: 1 },
      ],
      totalAfter: 4800,
    },
  },
  {
    id: "ln-008",
    category: "Long natural messages",
    description: "long apologetic message cancelling the whole order",
    setup: ["ek zinger burger krdo", "ek pizza large bhi de do"],
    message:
      "Sorry yaar mujhe abhi order cancel karna padega, kal phir order karunga, sab hata dein please",
    intent: "clear cart despite long wording",
    expect: { cartChanges: true, cartAfter: [] },
  },
  {
    id: "ln-009",
    category: "Long natural messages",
    description: "long message with name provided naturally",
    setup: ["ek zinger burger krdo", "place order", "confirm krdo", "pickup chahiye"],
    message: "Mera naam Muhammad Hassan hai aur main shaam ko pickup ke liye aa jaunga",
    intent: "provide name",
    expect: { cartChanges: false, phaseAfter: "checkout_summary", contains: ["Hassan"] },
  },
  {
    id: "ln-010",
    category: "Long natural messages",
    description: "long message describing budget and group size",
    message:
      "Hum office se 3 log hain aur humara budget around 2000 rupees hai, kya milega is mein hamein",
    intent: "budget recommendation for group",
    expect: { cartChanges: false, contains: ["2000"] },
  },
];
