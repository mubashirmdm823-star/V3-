// V2 phase 3 — AI intent parser.
//
// Responsibility: take raw customer text (+ conversation state) and return a
// single Intent (see v2/types/intent.ts). Nothing else. This module must NOT
// touch CartState/ConversationState — it only classifies what the customer
// said. Deterministic resolution of that intent against the real menu, and
// any cart/order mutation, belongs to cart-engine / order-state-engine.
//
// Not implemented yet — scaffolding only, so nothing imports this module.

export {};
