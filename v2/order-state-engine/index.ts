// V2 phase 5 — order state engine.
//
// Responsibility: deterministic conversation/phase transitions (see
// ConversationPhase in v2/types/order.ts) — checkout steps, address/name
// collection, and handing off a completed ConversationState into a real
// Order (types/order.ts) as "pending_verification". Encodes the business
// rule that orders never reach the kitchen without explicit staff
// confirmation (see restaurantConfig.orderFlow.requiresManualVerification in
// v2/data/restaurant-config.json).
//
// Not implemented yet — scaffolding only, so nothing imports this module.

export {};
