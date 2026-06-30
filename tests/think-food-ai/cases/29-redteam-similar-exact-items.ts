import type { TestCase } from "../types";

// Red team — "similar item" vs "exact item" disambiguation stress tests.
// Customers often name something close-but-not-quite a real item, or two real
// items that share words, and the bot must not silently guess wrong.
export const similarExactItemCases: TestCase[] = [
  {
    id: "se-001",
    category: "Red team: similar / exact item queries",
    description: "exact full name resolves precisely, not a near neighbor",
    message: "1 think food special pizza",
    intent: "add the exact Think Food Special Pizza, not a different pizza",
    expect: { cartChanges: true, cartAfter: [{ name: "Think Food Special Pizza", qty: 1 }], totalAfter: 1500 },
  },
  {
    id: "se-002",
    category: "Red team: similar / exact item queries",
    description: "exact full name resolves precisely for the SP burger",
    message: "1 think food sp burger",
    intent: "add the exact Think Food SP Burger, not the special sandwich",
    expect: { cartChanges: true, cartAfter: [{ name: "Think Food SP Burger", qty: 1 }], totalAfter: 550 },
  },
  {
    id: "se-003",
    category: "Red team: similar / exact item queries",
    description: "exact full name resolves precisely for the special sandwich",
    message: "1 think food special sandwich",
    intent: "add the exact Think Food Special Sandwich, not the SP burger",
    expect: { cartChanges: true, cartAfter: [{ name: "Think Food Special Sandwich", qty: 1 }], totalAfter: 550 },
  },
  {
    id: "se-004",
    category: "Red team: similar / exact item queries",
    description: "bare 'special' alone is genuinely ambiguous across categories",
    message: "1 special chahiye",
    intent: "off-menu or no crash — 'special' alone isn't a real item name",
    expect: { cartChanges: false },
  },
  {
    id: "se-005",
    category: "Red team: similar / exact item queries",
    description: "similar-sounding item that isn't on the menu at all",
    message: "1 zinger wrap chahiye",
    intent: "no such item exists — must not silently default to Zinger Burger or Wrap",
    expect: { cartChanges: false },
  },
  {
    id: "se-006",
    category: "Red team: similar / exact item queries",
    description: "asks which sandwiches are similar/available — pure browse",
    message: "sandwich mein kya kya similar options hain",
    intent: "browse sandwich category",
    expect: { cartChanges: false, contains: ["Sandwich"] },
  },
  {
    id: "se-007",
    category: "Red team: similar / exact item queries",
    description: "exact pasta sauce variant must not cross-match the other sauce item",
    message: "1 macaroni pasta red sauce",
    intent: "add Macaroni Pasta red sauce specifically",
    expect: { cartChanges: true, cartAfter: [{ name: "Macaroni Pasta red sauce", qty: 1 }], totalAfter: 750 },
  },
  {
    id: "se-008",
    category: "Red team: similar / exact item queries",
    description: "exact rice variant must not cross-match White Singaporean",
    message: "1 singaporean rice",
    intent: "add Singaporean Rice, not White Singaporean",
    expect: { cartChanges: true, cartAfter: [{ name: "Singaporean Rice", qty: 1 }], totalAfter: 700 },
  },
  {
    id: "se-009",
    category: "Red team: similar / exact item queries",
    description: "exact rice variant for the other similarly-named item",
    message: "1 white singaporean",
    intent: "add White Singaporean, not Singaporean Rice",
    expect: { cartChanges: true, cartAfter: [{ name: "White Singaporean", qty: 1 }], totalAfter: 750 },
  },
  {
    id: "se-010",
    category: "Red team: similar / exact item queries",
    description: "asks for the exact price of a specific variant, not its sibling",
    message: "jumbo zinger ka price kya hai",
    intent: "answers with Jumbo Zinger's own price (750), not the plain Zinger Burger's",
    expect: { cartChanges: false, contains: ["750"] },
  },
];
