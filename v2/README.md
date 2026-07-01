# Think Food AI — V2 architecture (in progress)

Goal: split the current monolithic `lib/think-food-ai.ts` engine (parsing +
cart mutation + reply text all mixed in `ai()`/`applyCartAction()`) into
separate deterministic layers, with one hard rule:

> The AI only ever returns a JSON `Intent` (v2/types/intent.ts). It never
> updates the cart or order state directly. Cart/order mutation is done by
> plain deterministic code that reads that JSON.

The current V1 demo (`lib/think-food-ai.ts`, `WhatsAppSimulator.tsx`,
`tests/think-food-ai/`) is untouched and still runs the live UI. Nothing
here is wired up yet.

## Status

| # | Piece | Location | Status |
|---|-------|----------|--------|
| 1 | Menu JSON | `v2/data/menu.json` | Done — generated from the live `MENU` export |
| 2 | Restaurant config | `v2/data/restaurant-config.json` | Done — generated from the live `INFO` export |
| 3 | AI intent parser | `v2/intent-parser/` | Scaffolded only |
| 4 | Cart engine | `v2/cart-engine/` | Scaffolded only |
| 5 | Order state engine | `v2/order-state-engine/` | Scaffolded only |
| 6 | Response builder | `v2/response-builder/` | Scaffolded only |
| 7 | API chat route | `app/api/chat/route.ts` | Scaffolded only, returns 501, not called by anything |
| 8 | Test suite | `tests/v2/` | Placeholder only |

## Types

`v2/types/menu.ts`, `cart.ts`, `intent.ts`, `order.ts` define the shapes each
layer passes to the next. They're modeled on the existing, battle-tested
`CartItem`/`Draft`/`CartAction`/`AIOut`/`Phase` types in
`lib/think-food-ai.ts` rather than invented from scratch — see that file
for the proven behaviour being ported.
