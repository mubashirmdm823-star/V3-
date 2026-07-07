# Think Food AI — V2 architecture (in progress)

Goal: split the current monolithic `lib/think-food-ai.ts` engine (parsing +
cart mutation + reply text all mixed in `ai()`/`applyCartAction()`) into
separate deterministic layers, with one hard rule:

> The AI only ever returns a JSON `Intent` (v2/types/intent.ts). It never
> updates the cart or order state directly. Cart/order mutation is done by
> plain deterministic code that reads that JSON.

The original V1 demo engine (`lib/think-food-ai.ts`, `tests/think-food-ai/`)
is untouched — completely unmodified, still fully covered by its own 1172
tests. As of phase 13, the live UI (`WhatsAppSimulator.tsx`) and
`app/api/chat/route.ts` both run through a feature flag
(`AI_ENGINE=v1`/`AI_ENGINE=v2`, see `config/ai-engine.ts`) that decides
which engine actually answers a message — switching is a config change
only, no code change, no visual/styling/layout difference either way. See
"Engine feature flag design notes" at the end of this file for the full
picture.

## Status

| # | Piece | Location | Status |
|---|-------|----------|--------|
| 1 | Menu JSON | `v2/data/menu.json` | Done — generated from the live `MENU` export |
| 2 | Restaurant config | `v2/data/restaurant-config.json` | Done — generated from the live `INFO` export |
| 3 | AI intent parser | `v2/intent-parser/` | Safety layer + confidence layer + NLU parser (`parser.ts`) done, tested. Does not call cart/order engines (they don't exist yet). |
| 4 | Cart engine | `v2/cart-engine/` | Done, tested. The only code allowed to produce a new `CartState`. |
| 5 | Order state engine | `v2/order-state-engine/` | Done, tested. Controls conversation flow across all 10 required states. |
| 6 | Response builder | `v2/response-builder/` | Done, tested. The only module allowed to generate customer-facing text — see below. |
| 7 | API chat route | `app/api/chat/route.ts` | **Live.** Delegates entirely to `lib/engine` — see below. |
| 8 | Test suite | `tests/v2/` | 12 test files, 973 tests total, run via `npm run test:v2` (or `npm run test` for V2 + V1 together) |
| — | Logging & analytics | `v2/logger/` | Done, tested. Purely observational — never wired into the UI or the pipeline's actual behavior. |
| 9 | Process message orchestrator | `v2/core/` | Done, tested. The only component that coordinates every V2 layer into one customer turn — see below. |
| 10 | Context builder & conversation memory | `v2/context-builder/` | Done, tested. Prepares a durable, LLM-ready context object between turns — never calls an LLM itself. See below. |
| 11 | LLM integration layer | `v2/llm/` | Done, tested. Provider abstraction (OpenAI/Claude/Gemini/Google AI Studio/OpenRouter) + prompt builder + JSON validator + automatic fallback to the deterministic parser, including graceful fallback when no provider is configured at all. |
| 12 | LLM <-> orchestrator wiring | `v2/core/executor.ts`, `v2/core/process-message.ts`, `v2/llm/router.ts`, `v2/llm/parse-result-mapper.ts` | Done, tested. The orchestrator resolves intent via EITHER path transparently — see below. |
| 13 | Engine feature flag + live UI wiring | `config/ai-engine.ts`, `lib/engine/`, `components/whatsapp/WhatsAppSimulator.tsx`, `app/api/chat/route.ts` | **Live.** `AI_ENGINE=v1`/`v2` switches which engine answers every message, in both the API route and the WhatsApp simulator — see below. |
| 15 | Customer Conversation Layer | `v2/intent-parser/parser.ts`, `v2/order-state-engine/`, `v2/response-builder/conversation.ts` | Done, tested. 14 first-class conversational intents (GREETING/THANKS/YES/NO/WAIT/CANCEL_ORDER/HUMAN_SUPPORT/COMPLAINT/RECOMMENDATION_REQUEST/CONFUSED_CUSTOMER/SMALL_TALK/IRRELEVANT_QUERY/HELP/GOODBYE) — see below. |
| 14A | Production QA Simulator (offline) | `qa/`, `tests/qa/` | Done. 20,000 generated customer conversations driven through the REAL pipeline; 24 distinct bugs found, all auto-converted to permanent regression tests — see below. Run via `npm run qa:simulate`; tests via `npm run test:qa`. |
| 16 | Action Planner + Clarification Queue | `v2/action-planner/`, `v2/cart-engine/action-plan.ts`, `v2/order-state-engine/clarification.ts`, `v2/order-state-engine/index.ts` | Done, tested. Multi-item messages now execute exact items immediately and queue every ambiguity independently instead of one worst-case verdict dropping everything — see below. |
| 17 | V1-vs-V2 behavioral audit | `v2/intent-parser/normalize.ts`, `v2/intent-parser/parser.ts` | Done, tested. Full audit across every intent category found V2 at parity or better everywhere except two concrete gaps (full-menu intensifier words, "order" as a vocabulary-poisoning noise word) — see below. |
| 18 | V3 AI Conversation Agent | `v3/agent/`, `lib/engine/v3.ts` | Done, tested. A real LLM-driven planner + tool-calling agent sits ABOVE V2 — V2's parser/cart-engine/order-state-engine/response-builder are untouched, used only as backend tools and as the whole-turn fallback when no LLM is configured. `AI_ENGINE=v3`. See below. |

All 6 layered V2 modules (safety, intent parser, cart engine, order state
engine, logging, response builder), the orchestrator, the context builder,
and the LLM integration layer are complete and tested —
`v2/core/process-message.ts#processCustomerMessage` is the single entry
point that runs the full pipeline end to end, and can resolve each
customer message's intent via EITHER the deterministic parser OR a
configured LLM provider, with automatic, invisible fallback to the
deterministic parser whenever the LLM path isn't configured or isn't
usable. Every module downstream of intent resolution (safety, cart engine,
order state engine, response builder, logger) is completely unaware of
which path produced the `ParseResult` it's looking at.

As of phase 13, `lib/engine/` sits one level above all of this: a shared
`AIEngine` interface both V1 (`lib/think-food-ai.ts`, wrapped by
`lib/engine/v1.ts`) and V2 (wrapped by `lib/engine/v2.ts`) implement
identically, selected by the `AI_ENGINE` environment variable
(`config/ai-engine.ts`) and served through one Engine Router
(`lib/engine/index.ts`) with automatic V2 -> V1 rollback on an unexpected
failure. `app/api/chat/route.ts` and `WhatsAppSimulator.tsx` both go
through this — no real network call to a provider has ever been made
anywhere in this repo (every LLM-path test injects a fake `fetchImpl`),
but the live demo itself is now genuinely running through the full V2
pipeline whenever `AI_ENGINE=v2` is set.

## Types

`v2/types/menu.ts`, `cart.ts`, `intent.ts`, `order.ts` define the shapes each
layer passes to the next. They're modeled on the existing, battle-tested
`CartItem`/`Draft`/`CartAction`/`AIOut`/`Phase` types in
`lib/think-food-ai.ts` rather than invented from scratch — see that file
for the proven behaviour being ported.

`v2/types/parser.ts` defines a *separate* public contract (`IntentName`,
`ParsedAction`, `ParseResult`) using the SCREAMING_SNAKE_CASE intent names
(`ADD_ITEM`, `REMOVE_ALL`, etc). `v2/intent-parser/parser.ts` builds an
internal `Intent` (the lowercase `v2/types/intent.ts` shape) to run through
the already-shipped `evaluateSafety()`, then reports the result via
`ParseResult` — see the `toLegacyType()` mapping table at the top of
`parser.ts`. This keeps the safety layer's existing contract/tests
untouched while giving the parser the exact output shape requested.

## Intent parser design notes

- **Menu resolution** (`v2/intent-parser/matching.ts`): a query resolves to
  0 (unavailable), 1 (unambiguous), or 2+ (ambiguous) candidate menu item
  ids — never a guess. Bare category/family words ("zinger", "pasta") are
  *designed* to come back ambiguous; the safety layer is what turns that
  into `ASK_CLARIFICATION`.
- **Off-menu rejection**: a query token not found anywhere in the menu's
  vocabulary (item names + category titles) short-circuits to unavailable
  rather than falling back to a broader category guess — this is what makes
  "beef burger" reject instead of silently matching "any burger".
- **Same-message category anchoring**: "2 small 2 large 1 alfredo" has no
  category word at all, but "alfredo" unambiguously anchors "pasta", so the
  otherwise-ambiguous "small"/"large" segments get resolved *within* that
  category. This only works within a single message — a true multi-turn
  "which pasta?" reply (answered in a later message) needs conversation
  state from the order-state-engine, which doesn't exist yet.
- **`ParseResult.items`** is the flattened union of every action's items
  (not just the "primary" one), so compound messages like "remove
  everything and add 1 large pizza" don't hide the pizza at the top level
  even though `intent` reports `REMOVE_ALL` as primary.

## Cart engine design notes

- **Exact ids only.** `v2/cart-engine/{add,remove,replace,quantity,clear}.ts`
  take already-resolved menu item ids and quantities — never free text. No
  string matching, no menu-resolution logic lives here; that's the intent
  parser's job (`v2/intent-parser/matching.ts`).
- **`v2/cart-engine/index.ts`** is the only place that bridges a `ParsedAction`
  (which still carries `candidateItemIds[]`) to a concrete mutation: it
  requires exactly one candidate id per item ref and rejects otherwise,
  rather than guessing. `executeParseResult()` additionally refuses to run
  at all unless `safetyDecision === "SAFE_TO_EXECUTE"` — a second,
  independent gate on top of whatever already called it correctly.
- **Totals always recompute from menu prices** (`totals.ts`) — a
  `CartLineItem.price` is only a display cache, never the source of truth,
  so a tampered/stale cached price can't skew a total.
- **Quantity floor is a hard reject, not V1's auto-remove.** Decreasing to
  zero/negative is rejected (`decreaseQuantity`) rather than silently
  removing the line, per this phase's explicit instruction — a real
  behavior difference from `lib/think-food-ai.ts`'s `applyCartAction`
  `reduce` op. `REMOVE_ITEM` is the only way to zero out a line.
- **History is returned, not persisted.** Every successful mutation returns
  a `{before, after, action, timestamp}` entry (`history.ts`); nothing in
  this module keeps its own log — callers (eventually the order-state-engine)
  own accumulating it via `appendHistory()`.

## Order state engine design notes

- **10 states**: `BROWSING`, `CART_EDITING`, `AWAITING_CLARIFICATION`,
  `ORDER_REVIEW`, `AWAITING_DELIVERY_PICKUP`, `AWAITING_ADDRESS`,
  `AWAITING_NAME`, `READY_TO_SUBMIT`, `PENDING_VERIFICATION`, `CANCELLED`.
  `v2/order-state-engine/index.ts`'s `processMessage(context, parseResult,
  menu)` is the single entry point; it dispatches on `context.state`, never
  on raw text.
- **One rule drives every cart-edit transition**
  (`transitions.ts#nextStateAfterCartMutation`): the first successful edit
  moves `BROWSING -> CART_EDITING`; any edit happening later in the checkout
  flow (delivery/pickup, address, name, ready-to-submit) bounces back to
  `ORDER_REVIEW` so the customer re-confirms against the updated cart.
  `CART_EDITING`/`ORDER_REVIEW` themselves just stay put.
- **`customer-info.ts` is a deliberate, narrow exception to "never parse raw
  language".** Extracting "Fahad" out of "mera naam Fahad hai", and
  rejecting "ok"/"asdf" as an address, both require looking at the actual
  message text. The distinction from real NLU: this code only ever runs
  once the *state* (not language) already establishes that the next message
  is supposed to answer "what's your name/address" — it never classifies
  intent or resolves menu items.
- **Clarification resolution reuses the intent parser's own primitives**
  (`resolveItemQueryWithinCategory` from `v2/intent-parser/matching.ts`)
  rather than re-implementing matching. `clarification.ts` first checks
  whether the stateless parser already resolved the reply on its own (e.g.
  "2 small 2 large 1 alfredo" self-anchors via "alfredo" with no state
  needed at all); only a genuinely bare reply like "small" needs the
  pending category to disambiguate.
- **Two small, additive fixes were needed elsewhere** to make this phase's
  own example phrases work end-to-end through the real pipeline (not just
  hand-built fixtures) — both re-verified against every existing test
  before and after:
  - `v2/intent-parser/parser.ts`: `isCheckoutTrigger`/`isConfirmOrderTrigger`
    were missing "order place kardo", "haan confirm", and "confirm kar do"
    (space-separated) as recognized phrasings.
  - `v2/intent-parser/matching.ts`: bare 2-letter replies like "ok" were
    spuriously substring-matching menu words (e.g. "ok" inside "sm-OK-e
    Burger"), which made `isValidAddressReply`'s upstream classification
    misbehave. Fixed by requiring 3+ characters for that containment check.
  - `v2/cart-engine/index.ts`: `REPLACE_ITEM` now filters
    `sourceCandidateItemIds` down to what's actually in the cart before
    requiring a single match — mirroring what the safety layer already does
    internally — since a source query can be menu-wide-ambiguous (e.g. bare
    "zinger") while still being unambiguous *within the cart*.
- **Known gap**: the intent parser has no dedicated `SUBMIT_ORDER` or
  `CANCEL_ORDER` intent. `checkout.ts#isFinalSubmitTrigger` is a narrow,
  explicitly-scoped keyword check used only while `state === READY_TO_SUBMIT`
  (not general classification). `cancelOrder()` exists as a valid
  terminal-state transition but nothing wires a customer message to it yet.
- **`orderReviewShown` is set synchronously** with entering/re-entering
  `ORDER_REVIEW` in this phase, since there's no response-builder round-trip
  yet to defer it until the updated review is actually shown to the
  customer — see `applyCartEdit()`'s comment for the caveat.

## Logging & analytics design notes

- **Purely observational, one-way data flow.** `v2/logger/` wraps the
  already-built pipeline (`processMessageWithLogging` in `index.ts` calls
  the real `parseMessage()` then `processMessage()`, completely unchanged)
  to time it and record what happened. Nothing in this layer feeds back
  into the cart/order state — a dedicated test
  (`logging never changes the resulting OrderContext vs running the
  pipeline unlogged`) runs the same message sequence with and without a
  logger attached and asserts the resulting contexts are identical.
- **Timing granularity is honest about the current architecture.** Safety
  evaluation happens *inside* `parseMessage()` and cart execution happens
  *inside* `processMessage()` — they aren't separately callable from
  outside without modifying those already-shipped modules. So `parserMs`
  includes safety time and `stateMs` includes cart-engine time in the
  standard instrumented path; `safetyMs`/`cartMs` are 0 there and only get
  populated if a caller times `evaluateSafety`/cart-engine calls directly
  with `performance.ts#time()`. Documented in `performance.ts`'s header.
- **`Logger` is the one intentionally-stateful piece** in an otherwise
  immutable-everywhere codebase — a recorder that doesn't accumulate
  observations over time isn't a recorder. `session.ts`'s
  `recordMessageInSession` still follows the established
  immutable-update convention (`(state, entry) -> new state`), matching
  `context.ts#touch` and every cart-engine function.
  `buildLogEntry`/`computeCartAnalytics`/`buildReasoningSummary` are all
  pure functions of already-computed inputs.
- **Cart analytics approximate "spelling mistake" vs "alias."** There's no
  signal from the parser distinguishing a genuine typo from an intentional
  shorthand — `computeCartAnalytics` classifies a per-item match as an
  alias only when the query text exactly (case-insensitively) equals the
  resolved menu item name, folding everything else (typos and shorthand
  alike) into "spelling mistakes." Uses the precise per-item query text
  (`MessageLogEntry.matchedItemDetails`), not a whole-message approximation.
- **A same-class bug as the order-state-engine's REPLACE_ITEM fix**
  turned up here too: `logger.ts#extractReplacements` initially used the
  raw (menu-wide, possibly multi-candidate) `sourceCandidateItemIds`
  straight off the `ParsedAction`, so a cart-unambiguous-but-menu-ambiguous
  replace source (e.g. bare "zinger" when only one zinger item is actually
  in the cart) logged the raw query text instead of the resolved item name.
  Fixed by filtering source candidates against the cart, mirroring the
  cart engine's own logic — caught by a test that drives the real pipeline
  rather than hand-built fixtures, same lesson as before.

## Response builder design notes

- **The only module allowed to generate customer text.** `v2/response-builder/index.ts`'s
  `buildResponse({parseResult, before, after, menu, restaurantConfig})` reads
  `intent`/`safetyDecision`/`category`/etc for DISPATCH decisions only —
  never prints them. A dedicated test suite section (`no leakage: ...`)
  asserts no reply ever contains an intent name, safety decision, raw
  itemId, or JSON-looking text, across a conversation touching every
  intent type.
- **Deterministic variation, not randomness.** `variation.ts#pickVariation`
  seeds a hash of the input (typically `rawUserMessage`) to pick from a
  fixed pool — same input always picks the same phrase, satisfying "same
  structured input -> same reply" for reliable tests, while still varying
  across a real conversation since messages differ turn to turn.
- **Landing in ORDER_REVIEW always re-prompts to confirm.** Whether via
  `CHECKOUT_START` from `CART_EDITING` or bouncing back after an
  interrupting edit during a later checkout step, `buildCartMutationReply`
  detects `after.state === "ORDER_REVIEW"` and appends the "Confirm Order"
  call-to-action instead of a generic dynamic ending — otherwise a customer
  editing their cart mid-checkout would get a plain add-confirmation with
  no signal that they need to re-confirm.
- **`restaurant.ts` only prints fields that actually exist** in
  `v2/data/restaurant-config.json` — no hardcoded branches/payment-methods
  sections, since the config has no such fields today. Add them to the
  config first if this needs to expand.
- **Two real bugs surfaced by driving the actual pipeline** (not hand-built
  fixtures), consistent with every V2 session so far: (1) `ParseResult.items`
  was silently empty for `SHOW_OPTIONS`/`PRICE_QUERY`/`HYPOTHETICAL_TOTAL` —
  those intents resolve candidates for the safety check but produce no
  cart-mutating `actions`, and `items` was derived only from `actions`.
  Fixed by adding an explicit `items` override to the parser's internal
  `finalize()` helper (`v2/intent-parser/parser.ts`), re-verified against
  the full parser suite. (2) `order-state-engine/clarification.ts`'s
  `buildPendingClarification` prioritized the broad category key (e.g.
  "Burgers") over the parser's already-correctly-scoped family label (e.g.
  "zinger"), so a clarification question like "Aap kaunsa Zinger chahenge?"
  was actually asking "Aap kaunsa Burgers chahenge?" while only listing 3
  zinger options underneath. Fixed by swapping the priority order;
  re-verified against the full order-state-engine suite.
- **Known limitation**: nothing calls `buildResponse` from
  `app/api/chat/route.ts` yet, and the pipeline diagram's "Response Builder
  -> Logger" step (logging the generated reply text itself) isn't wired —
  `v2/logger/` was built before this phase and wasn't in this session's
  file list to update. This gap is closed by the orchestrator below.

## Process message orchestrator design notes

`v2/core/process-message.ts#processCustomerMessage` is the central brain of
V2 — the single function that coordinates all six other layers into one
customer turn. It contains no business rules of its own: every decision
about parsing, safety, cart mutation, state transitions, or reply wording
still happens entirely inside the module that already owns it. What it adds
is sequencing, timing, output validation, logging, and safe-failure
recovery.

- **Fused stages are represented honestly, not re-run.** `evaluateSafety`
  runs *inside* `parseMessage` and `executeParseResult` runs *inside*
  `processMessage` in this codebase's already-shipped architecture (see
  `v2/logger/performance.ts`'s header, which documents the same thing for
  the logging layer). Rather than pretend to call a separate safety/cart
  step, `v2/core/executor.ts#checkSafetyStage` just re-validates the field
  the safety layer already set on the `ParseResult`, and cart execution is
  validated as part of the state stage. `PipelineTiming.safetyMs`/`cartMs`
  are always `0` for the same reason `v2/logger/index.ts`'s `safetyMs`/
  `cartMs` are — documented, not a bug. `responseMs` and `loggerMs`,
  however, *are* genuinely measured here (unlike in `v2/logger/index.ts`),
  since the orchestrator is the first place `buildResponse` and the logger
  call are both invoked from outside their own modules.
- **`v2/core/validator.ts`** does structural "is this shape well-formed"
  checks only — it never re-decides what a safety decision or state
  transition *should* be, only that the value returned is one of the real
  ones. `v2/core/executor.ts` wraps every stage call with this validation
  plus timing, and normalizes any thrown exception into a `PipelineError`
  tagged with the stage that was running (`v2/core/errors.ts`).
- **Safe-failure recovery matches the spec's per-stage table exactly**
  (`v2/core/process-message.ts`): a parser failure rolls back to the prior
  context and returns a clarification reply (`clarifyUnclearMessage()`); a
  state failure rolls back to the prior context with a generic fallback
  reply; a response-builder failure keeps the already-valid state
  transition (the cart/state change genuinely happened) but substitutes a
  generic fallback reply instead of crashing; a logger failure never
  touches the reply or context at all — it only gets recorded via
  `recovered`/`failedStage` on the result. All four paths are proven with
  tests that force a *real* module to throw (a menu with `categories`
  stripped out breaks `parseMessage`/`processMessage`; a missing
  `restaurantConfig` breaks `buildRestaurantInfoReply`) rather than
  simulating the failure with a mock.
- **`v2/core/context-manager.ts`'s `ConversationContext`** wraps the
  order-state-engine's already-existing `OrderContext` with just the
  identity/observability fields the spec asks for beyond it: conversation
  id, session id, and the response seed used for that turn's deterministic
  reply variation. It adds no new cart/state/checkout rules — `OrderContext`
  already carries state, cart, pending clarification, customer name,
  delivery type/address, and last intent/action. Being plain, JSON-safe data
  makes `saveContext`/`restoreContext`/`resetContext`/`cloneContext` trivial,
  which is what "prepares V2 for future database/session storage" means
  here — no actual storage backend was added, on purpose.
- **Interrupt handling and clarification-chain persistence needed no new
  code.** Both were already correct in the order-state-engine (every state
  handler already checks `isCartEditIntent` first; `pendingClarification`
  already lives on `OrderContext` and threads forward automatically once
  the caller carries the context to the next turn) — the orchestrator's job
  was proving it end-to-end through `ConversationContext`, including across
  a save/restore round-trip, which the test suite does directly.
- **A same-class discovery as every prior phase**: re-confirming an order
  after a checkout-stage interruption does not resume from where it was
  interrupted — `order-state-engine/index.ts#handleOrderReview` always
  re-asks delivery/pickup (and, transitively, address/name) on every
  `CONFIRM_ORDER`, by design (`applyCartEdit`'s comment: any edit later in
  checkout bounces back to `ORDER_REVIEW` so the customer re-confirms
  against the updated cart). A first draft of one orchestrator test assumed
  the interrupted flow could resume straight from `AWAITING_NAME`; the fix
  was to the test, not the code, once tracing `nextStateAfterCartMutation`
  and `handleOrderReview` confirmed this is the existing, intentional
  behavior.

## Context builder & conversation memory design notes

`v2/context-builder/` is the intelligence layer that gives a future LLM
memory between messages. It never calls an LLM and never parses/mutates
cart or order state — `updateMemoryAfterTurn()` only ever copies fields
already produced by `OrderContext`/`ParseResult`/the response builder, and
`buildAIContext()` only combines already-known memory with lexical menu
matching to produce a "Final AI Context Object" for the *next* customer
message (which hasn't been parsed yet — that's still the intent parser's
job in a later phase).

- **Pending clarification is pure restoration, never re-derivation.**
  `memory.ts#syncMemoryFromOrderContext` copies `OrderContext.pendingClarification`
  verbatim — the actual clarification logic still lives entirely in
  `order-state-engine/clarification.ts`. This module adds nothing on top
  except carrying it forward across turns and exposing it in the built
  context.
- **`currentTopic` is deliberately stickier than `lastMentionedCategory`/
  `lastMentionedProduct`.** A first draft updated all three from any
  resolved item mention regardless of intent, which broke the "never lose
  topic" requirement: asking `"gyro ki price kya hai"` while discussing
  Burgers silently changed the topic to Roll. Fixed by only letting
  `currentTopic` move for intents that mean the customer is actively
  steering the order (`ADD_ITEM`, `ADD_MULTIPLE_ITEMS`, `REPLACE_ITEM`,
  `CHANGE_QUANTITY`, `SHOW_OPTIONS`, `ASK_CLARIFICATION`) or when an item
  actually lands in the cart (checked via a before/after cart diff, which
  is what makes `REPLACE_ITEM`'s target register correctly even though its
  `ParsedAction` carries no `items`/`category` field at all) — incidental
  mentions (price checks, restaurant info, show-cart) only ever move the
  more volatile `lastMentionedCategory`/`lastMentionedProduct`.
- **The relevant-menu builder (`menu-context.ts`) reuses the intent
  parser's own tokenizer** (`significantTokens` from
  `v2/intent-parser/matching.ts`) rather than a second copy, plus a small,
  self-contained plural-tolerance rule (`burgers`/`sandwiches`/`noodles`/
  `steaks` <-> their singular forms) needed to match this menu's category
  titles against singular customer phrasing. Matching priority: a whole
  category title mentioned outright always wins outright (`"pizza"` ->
  only Pizza, even though "Pizza Fries" also contains the token "pizza");
  otherwise item-name-token overlap; an ambiguous multi-category overlap
  (e.g. "large" appears in Pizza/Pasta/Toppings item names) is narrowed to
  the current topic's category if the topic is among the matches, or
  returned as-is if not; a message matching none of the menu vocabulary but
  containing a `SHOW_WORDS` word (reused from `v2/intent-parser/safety.ts`)
  returns the full menu (the one deliberate exception to "never send the
  full menu" — a customer literally asking to see everything IS relevant);
  restaurant-info-shaped phrasing (its own small, narrow keyword list,
  scoped only to this "does menu matter at all" decision) returns no menu
  at all.
- **Serialization surfaced a real class of bug**: `JSON.stringify` drops
  object keys whose value is `undefined`, but several functions in
  `memory.ts`/`conversation.ts` were building objects with explicit
  `key: undefined` (e.g. `customerName: order.customerName ?? memory.customerName`
  when neither side has a name yet). That made an in-memory
  `ConversationMemory`/`ConversationTurn` structurally different from the
  same object after a `saveMemorySession`/`restoreMemorySession` round trip
  (missing keys vs. present-but-undefined keys), failing `assert.deepEqual`
  in five different tests. Fixed with a shared `omitUndefined()` helper
  (`memory.ts`) applied everywhere these objects are constructed, so the
  in-memory shape already matches its own serialized form — the round trip
  in `session.ts` is a true no-op rather than a normalization step.
- **History pruning prunes whole finished orders, not just the literal
  terminal turn.** A first draft only treated a turn as "old completed
  checkout" if *that turn's own* `stateAfter` was `PENDING_VERIFICATION`/
  `CANCELLED` — which meant the actual `ADD_ITEM`/`CHECKOUT_START`/
  `CONFIRM_ORDER` turns (whose own `stateAfter` is `CART_EDITING`/
  `ORDER_REVIEW`/etc.) were never pruned, contradicting the spec's "remove
  finished checkout" requirement. Fixed by finding the last terminal turn
  outside the recency window and treating every turn up to and including
  it as belonging to that finished order (all prunable together), rather
  than judging each turn's prunability only from its own individual state.
- **`v2/core/`'s `ConversationContext` (session 8) is not duplicated here.**
  This module consumes the same `OrderContext`/`ParseResult` shapes the
  orchestrator already produces — `ConversationMemory` is a read-derived
  enrichment on top, not a competing source of truth for cart/state.
- **Known limitation**: nothing calls `buildAIContext`/`updateMemoryAfterTurn`
  from `app/api/chat/route.ts` yet, and no LLM has been introduced anywhere
  in V2 — this phase explicitly stops at "prepare context," per its
  instructions.

## LLM Integration Layer design notes

`v2/llm/` is V2's only external dependency, and its only job is NLU: turn a
customer message (plus the context builder's already-assembled `AIContext`)
into the same structured intent/items/confidence shape the deterministic
parser already produces — never a cart mutation, a state change, a
checkout flow, or a customer-facing reply. This phase deliberately stops at
the provider abstraction: nothing here is called from
`app/api/chat/route.ts` or anywhere else in the pipeline, and no test in
`tests/v2/llm.test.ts` ever performs a real network request (every provider
test injects a fake `fetchImpl`).

- **One interface, five interchangeable providers.**
  `v2/llm/provider.ts#createProvider(config)` dispatches to
  `openai.ts`/`claude.ts`/`gemini.ts`/`google-ai.ts`/`openrouter.ts` purely
  off `config.provider` — switching providers is an `LLM_PROVIDER=`
  environment variable change (`loadProviderConfigFromEnv`), never a code
  change. Every concrete provider does the same two things differently per
  vendor (request shaping, response-envelope parsing — e.g. OpenAI/
  OpenRouter's `choices[0].message.content` vs. Claude's `content[0].text`
  vs. Gemini/Google AI Studio's `candidates[0].content.parts[0].text`) and
  delegates timeout/retry handling to the one shared
  `callWithTimeoutAndRetry()` helper rather than each reimplementing it.
- **Google AI Studio (`google-ai`) is a distinct, first-class provider
  identity, not a rename of the existing `gemini` one.** Both currently
  talk to the same underlying `generativelanguage.googleapis.com` REST API
  (that's what "Gemini" already was), but they have independent env-var
  identities (`GEMINI_API_KEY` vs `GOOGLE_API_KEY`) and independent
  `LLM_PROVIDER` selector values, so a deployment can be configured for
  either without the two colliding. To avoid duplicating the request/
  response logic between them, `gemini.ts` exports a parameterized
  `createGeminiStyleProvider(name, config, defaultModel, defaultBaseUrl)`
  that both `createGeminiProvider` and `google-ai.ts#createGoogleAIProvider`
  call — `google-ai.ts` itself is a thin ~10-line file supplying only its
  own name and defaults, per "do not duplicate business logic."
- **API key env-var names follow real vendor SDK conventions, not a naive
  `${NAME}_API_KEY` derivation.** `provider.ts`'s `PROVIDER_ENV_PREFIX`
  table maps `claude` -> `ANTHROPIC_API_KEY` (not `CLAUDE_API_KEY`) and
  `google-ai` -> `GOOGLE_API_KEY` (not a mangled `GOOGLE-AI_API_KEY`) — both
  explicit requirements, and both would have been silently wrong under a
  naive `provider.toUpperCase()` derivation.
- **The JSON validator is the real enforcement point for every "absolute
  rule."** The system prompt (`system-prompt.ts`) tells the model what not
  to do, but a model can't be trusted to police itself — `json-validator.ts`
  checks the actual data: every intent against `ALLOWED_LLM_INTENTS`
  (mirroring `v2/types/parser.ts`'s `IntentName` exactly), every item id
  against the real menu (`allMenuItems` from
  `v2/intent-parser/matching.ts` — a hallucinated id is rejected, not
  silently coerced), every quantity as a bounded positive integer, and
  every top-level/nested object against an explicit allowed-field set (an
  extra field like `"total"` or `"reply"` is rejected outright as
  `unknown_field`, since a model inventing a total or a reply is exactly
  the failure mode this phase forbids).
- **Fallback is unconditional and total, not partial.** Any validation
  failure (`invalid_json`, `hallucinated_item`, `low_confidence`, ...), a
  timeout, or any other thrown error all funnel through the same
  `completeWithFallback()` in `fallback.ts`, which then calls the
  already-shipped, fully-tested `parseMessage()` — there is no partial/
  degraded LLM path, only "validated LLM response" or "deterministic
  parser's ParseResult." `MIN_CONFIDENCE_TO_ACCEPT` (`json-schema.ts`)
  reuses the exact same `0.85` threshold `v2/intent-parser/confidence.ts`
  already uses to gate cart mutation, rather than inventing a second
  number.
- **Context injection only ever reads `AIContext`'s already-narrowed
  fields.** `context-injector.ts` never touches `AIContext.history` (full
  turn history) and never touches the full `menu.json` — only
  `AIContext.relevantMenu`, which `v2/context-builder/menu-context.ts`
  (session 9) already pruned down to the categories the customer's message
  is actually about. This phase adds no new pruning/relevance logic of its
  own; it reuses session 9's.
- **Prompt structure matches the spec's own section order exactly**
  (`prompt-builder.ts`): Restaurant Rules -> Current Conversation Summary
  -> Current Cart -> Current State -> Pending Clarification -> Relevant
  Menu -> Customer Message, appended to the fixed `SYSTEM_PROMPT`. A subtle
  test-writing trap surfaced here: the embedded conversation summary
  (`context-builder/context-summary.ts`) legitimately reuses some of the
  same header words ("Current State:", "Current Cart:", "Pending
  Clarification:") inside its own compact recap, so a naive
  first-`indexOf`-per-marker order check found the summary's *embedded*
  headers instead of the prompt's own top-level section headers. Fixed by
  checking `lastIndexOf` instead, which correctly lands on each section's
  real (later) occurrence.
- **Cache is opt-in and narrowly scoped.** `cache.ts`'s `LLMCache` only
  ever gets consulted/populated for a fixed allowlist of intents
  (`SHOW_MENU`, `SHOW_OPTIONS`, `PRICE_QUERY`, `HYPOTHETICAL_TOTAL`,
  `ASK_RESTAURANT_INFO`) — anything cart/checkout-related depends on
  state that a cached answer wouldn't reflect, so those are never cached
  regardless of how a caller invokes `completeWithFallback`.
- **Security**: API keys only ever come from `loadProviderConfigFromEnv`'s
  environment lookup — never hardcoded, never included in a thrown error's
  `.message` (`LLMProviderError`/`LLMTimeoutError` only ever carry the
  provider name, HTTP status, and duration). Gemini's API key does appear
  in its request URL's query string (that's how Gemini's REST API works),
  but it's still sourced only from config and never logged anywhere in
  this layer.
- **Test-data trap in the 50 production conversation simulations**: an
  early draft generated customer names as `"Customer1"`, `"Customer38"`,
  etc. `order-state-engine/customer-info.ts#extractCustomerName` only
  accepts a bare reply when every word is letters-only — a name containing
  digits is correctly rejected as not name-shaped (it's not general NLU;
  it's a narrow, deliberate check), which silently stalled every one of
  those 50 simulations at `AWAITING_NAME`. Fixed by using a rotating list
  of real, letters-only names instead — a reminder that this same
  letters-only rule applies to any future test data driving the name step.
- **Known limitation**: this phase stops at the provider abstraction, as
  instructed. No file outside `v2/llm/` imports from it, nothing here is
  called from `app/api/chat/route.ts`, and mapping a validated
  `LLMStructuredResponse` into a pipeline-ready `ParseResult` (so the
  safety layer/cart engine could act on an LLM's answer) is explicitly
  future work for the next phase — this session's 50 conversation
  simulations prove the *fallback* path end-to-end instead, since that's
  the part of the contract this phase actually owns.

### Update: Google AI Studio + graceful degradation (same session, follow-up)

- **`safeLoadProviderConfigFromEnv`** is a non-throwing sibling of
  `loadProviderConfigFromEnv` (returns `undefined` instead of throwing when
  `LLM_PROVIDER` or its API key is missing/unrecognized), and
  **`fallback.ts#completeWithFallbackFromEnv`** is the entry point built on
  top of it: if no provider is configured at all, it never attempts a
  network call — it goes straight to `parseMessage()` with reason
  `"missing_config"`, the same `ResolvedIntent` shape every other fallback
  reason already produces. This is what "if the key is missing, gracefully
  fall back to the deterministic V2 parser" means concretely — it's a
  fourth way to reach the fallback path (alongside timeout/invalid-JSON/
  hallucinated-item/low-confidence/provider-error), not a special case with
  different behavior.
- **Nothing existing was removed or renamed to make room for this.**
  `createProvider`, `loadProviderConfigFromEnv`, `completeWithFallback`,
  and every existing provider file keep their exact prior signatures and
  behavior — `google-ai.ts` and `completeWithFallbackFromEnv` are purely
  additive. The one behavioral rename is the top-level selector env var
  itself, from `PROVIDER` to `LLM_PROVIDER` (matching this update's own
  spec) — since nothing outside `v2/llm/` reads that variable yet (this
  layer isn't wired into the app), there was no compatibility surface to
  preserve for that specific name.

## LLM <-> orchestrator wiring design notes

This phase connects `v2/llm/` to `v2/core/process-message.ts` so the V2
engine can resolve a customer message's intent via EITHER the
deterministic parser or an LLM provider — with every module after that
point (safety, cart engine, order state engine, response builder, logger)
completely unaware of which one produced the `ParseResult` it's reading.

- **`v2/llm/parse-result-mapper.ts#mapLLMResponseToParseResult`** converts
  a validated `LLMStructuredResponse` into the *exact* `ParseResult` shape
  `parseMessage()` produces — and it does this by reusing the real
  business logic, not re-implementing it: `v2/intent-parser/parser.ts`'s
  own `toLegacyType()` bridge (now exported) builds the same internal
  lowercase `Intent` shape parseMessage() builds internally, which is then
  run through the exact same `evaluateSafety()` the deterministic path
  already uses. A `safetyDecision` produced this way is not "similar to"
  the deterministic parser's — it's the *same function*, called with
  equivalent input. The only genuinely new code is structural: shaping
  `IntentItemRef[]`/`ParsedAction[]` from the LLM's much simpler
  `{id, quantity}` item shape, since no existing code needed to go that
  direction before.
- **`v2/llm/router.ts#routeMessage`** is what the orchestrator actually
  calls now instead of the parser directly. It's lazy on purpose: it
  checks whether a provider is even configured *before* building any
  `AIContext`/prompt. A first draft built the prompt unconditionally, which
  meant a broken `restaurantConfig` could break parsing itself even when
  no LLM was ever going to be called — caught by an existing regression
  test (`F14` in `tests/v2/process-message.test.ts`) failing with the
  wrong stage tag (`PARSER` instead of the expected `RESPONSE`) once the
  orchestrator was wired up. Fixed by checking
  `safeLoadProviderConfigFromEnv()` first and returning the deterministic
  `parseMessage()` result immediately when nothing's configured — the
  overwhelmingly common path in this repo today.
- **`routeMessage` builds its own lightweight, single-turn `AIContext`**
  directly from what the orchestrator already has (cart, state, pending
  clarification), reusing `v2/context-builder`'s own
  `buildRelevantMenu`/`buildContextSummary`/`createInitialMemory` rather
  than duplicating that logic. It deliberately does NOT wire in
  `v2/context-builder`'s persisted `MemorySession`/turn history — doing
  that is out of this phase's scope (context-builder.ts wasn't one of this
  phase's files to change), so multi-turn conversation memory injected
  into the LLM prompt is a future phase's work; for now each turn's prompt
  is built fresh from the current `OrderContext` alone.
- **`processCustomerMessage` is now `async`.** Calling a real LLM provider
  is an actual network request, so there's no way around this — a function
  that *can* await something must be declared `async`, even on the (today,
  universal) path where nothing is actually awaited because no provider is
  configured. Every caller had to change from `const x = processCustomerMessage(...)`
  to `const x = await processCustomerMessage(...)`; `v2/core/executor.ts`'s
  `runParserStage` (synchronous, deterministic-only) is untouched and still
  exported for anything that only ever wants that — `runRouterStage`
  (async) is the new function the orchestrator actually calls, using the
  identical `PARSER` stage tag/timing/validation contract.
- **Everything is opt-in via `ProcessMessageInput`'s new optional fields**
  (`env`, `fetchImpl`, `llmCache`) — omitted entirely, they default to
  "read `process.env`, use the real global `fetch`, no cache," which today
  always resolves to `LLM_PROVIDER` being unset and therefore 100%
  deterministic behavior. This is why every pre-existing test in
  `tests/v2/process-message.test.ts` needed only the `await` conversion
  (mechanical, applied uniformly) and zero behavioral changes to keep
  passing unmodified.
- **`ProcessMessageResult.parserSource`** (`"llm" | "deterministic"`) is
  the one new, purely observational field — nothing in the pipeline
  branches on it; it exists only so a test (or a future debugging/logging
  need) can see which path actually resolved a given turn.
- **Proven, not just asserted, that downstream is unaffected**:
  `tests/v2/llm-pipeline.test.ts` cross-checks that feeding the same
  mapped `ParseResult` directly into `processMessage`/`buildResponse`
  produces byte-identical output to going through the full orchestrator
  with a fake LLM configured, drives a complete checkout conversation
  (add -> checkout -> confirm -> delivery/pickup -> name -> submit) end to
  end via a fake LLM provider all the way to `PENDING_VERIFICATION`, and
  confirms a hallucinated item, a low-confidence response, and a provider
  timeout all fall back silently through the *entire* orchestrator with no
  different customer experience.
- **Known limitation**: multi-turn `v2/context-builder` memory (conversation
  summary/history across turns) isn't yet threaded into the LLM prompt
  built by the router — explicitly out of this phase's scope. (The
  "nothing calls `processCustomerMessage` from `app/api/chat/route.ts`"
  limitation noted in phase 12 is resolved as of phase 13 — see below.)

## Engine feature flag & router design notes (phase 13)

Phase 13's job was purely architectural: make it possible to switch the
*live* UI and API between V1 and V2 with a config change, without touching
either engine's business logic and without V1 ever being at risk.

- **One shared contract, `lib/engine/types.ts#AIEngine`** —
  `{ name, processMessage(request): Promise<EngineResponse> }` — is the
  only thing either engine exposes to the outside world.
  `EngineResponse` is always `{ reply, context, cart, state, isFinished, debug? }`;
  `context` is deliberately typed `unknown` on both sides of the boundary —
  callers (the route, the UI) just persist whatever they were handed back
  and pass it back verbatim next turn. Only each engine's own adapter
  understands its own context shape, and the two shapes are *not*
  interchangeable (switching engines mid-conversation starts that engine
  fresh rather than attempting to translate state — see the router below).
- **`config/ai-engine.ts`** is the single reader of the `AI_ENGINE`
  environment variable, and the only place that decides what happens when
  it's missing or invalid: both cases silently resolve to `"v1"`. V1 is the
  deliberate default — a missing or typoed env var can never accidentally
  activate the newer, less battle-tested engine.
- **`lib/engine/v1.ts`** wraps `lib/think-food-ai.ts`'s `ai()` /
  `applyCartAction()` completely unmodified — zero changes to V1's actual
  business logic, only an adapter around it satisfying `AIEngine`.
  **`lib/engine/v2.ts`** wraps `v2/core/process-message.ts#processCustomerMessage`
  the same way, with zero changes to V2's pipeline.
- **`lib/engine/index.ts`** is the Engine Router: reads the configured
  engine name, calls that engine, and — if `AI_ENGINE=v2` and V2 throws —
  automatically retries the same message on V1 (starting a fresh V1
  conversation, since a V2 context can't be reinterpreted as a V1
  `{phase, draft}`), logs the failure via `console.error`, and reports
  `debug.fallbackUsed = true` when debug mode is on. The customer only ever
  sees a normal reply — never a raw error, never a visible glitch. If V1
  itself somehow also throws (in dependency-injected tests only; the real
  V1 never has), the router returns one last generic, non-leaking Urdu
  fallback reply rather than propagating anything.
- **Critical fix found via live browser testing, not unit tests**:
  `WhatsAppSimulator.tsx` is a `"use client"` component, so it cannot read
  `process.env.AI_ENGINE` (Next.js only exposes `NEXT_PUBLIC_`-prefixed
  vars to client bundles — a plain server env var is always `undefined` in
  browser code) and must never bundle V2's server-only modules (JSON
  import assertions, `node:crypto`, the whole pipeline) into client
  JavaScript. Driving the real dev server with Playwright and setting
  `AI_ENGINE=v2` on the server showed the simulator's replies were still
  V1's exact wording — it was silently always running V1 regardless of the
  flag. Fixed with **`lib/engine/client.ts`**, a thin `fetch("/api/chat", ...)`
  wrapper implementing the same request/response shape; the simulator
  imports only that, never `lib/engine` (the real, server-only router)
  directly. `app/api/chat/route.ts` is the only file that imports
  `lib/engine/index.ts`. Re-verified afterward with a fresh Playwright run:
  `AI_ENGINE=v2` now produces V2's distinct reply text in the actual
  browser UI.
- **`debug: undefined` key-presence bug**: writing
  `{ ...rest, debug: someDebugOrUndefined }` leaves an *own property*
  named `debug` on the object even when its value is `undefined` — `"debug"
  in obj` is `true` either way, since JS key presence doesn't care about
  the value. This broke the "debug fields are absent when debug=false"
  tests. Fixed everywhere a debug object is conditionally attached
  (`v1.ts`, `v2.ts`, `index.ts`'s fallback-merge and generic-failure paths)
  with a conditional spread instead: `...(debug ? { debug } : {})`.
- **`WhatsAppSimulator.tsx` and `app/api/chat/route.ts` changes are wiring
  only** — no JSX, className, layout, or business-logic changes. The
  simulator's `phase`/`draft` local state and its `applyCartAction`/
  `applyDraftPatch` helpers (which used to call straight into
  `lib/think-food-ai.ts`) are gone, replaced by a single opaque
  `contextRef` plus an `isFinished` boolean threaded from
  `EngineResponse.isFinished` — the one visual conditional that changed is
  `phase === "done"` becoming `isFinished`, functionally identical.
- **Tests**: `tests/v2/ui-switch.test.ts` (105 tests) covers the engine
  interface, V1 routing, V2 routing, env var config/changes/missing/invalid,
  automatic rollback, response-contract compatibility, WhatsApp Simulator
  integration (via the real `POST` handler, not a mock), API integration,
  debug/no-debug mode, repeated/stress switching, and conversation/cart/
  checkout/feature-flag persistence. `tests/v2/api-chat.test.ts` (from
  phase 12) now pins `AI_ENGINE=v2` for its own duration via `before`/`after`
  hooks, since that file predates the flag and is specifically about
  testing V2 through the route. Full suite: **973 v2 tests**, plus V1's
  unchanged **1172 tests**, all passing; `tsc --noEmit` and `npm run build`
  both clean.

## Production QA Simulator design notes (phase 14A)

Phase 14A built an offline QA system (`qa/`) whose job is to BREAK the V2
engine — 20,000 generated customer conversations driven through the real
`processCustomerMessage` pipeline (never a mock, no LLM, no API keys),
every turn judged automatically, every failure classified, replayable, and
auto-converted into a permanent regression test. No business logic, menu
data, or UI was changed in this phase — it only discovers and documents.

- **Architecture**: `seed.ts` (deterministic seeding — every conversation
  replayable from a number) → `randomizer.ts` (seeded RNG + realistic text
  corruption: typos/spacing/caps/short-forms/emoji/voice-typing; digits are
  NEVER corrupted so quantity assertions stay valid) → `customer-generator.ts`
  (21 personality archetypes × 4 languages) → `scenario-library.ts`
  (semantic scenarios: every menu item, alias, category, quantity style,
  checkout-interruption stage, replacement, removal, clarification chain,
  info topic, invalid input) → `conversation-generator.ts` (renders
  scenarios into each customer's actual message text) → `simulator.ts`
  (drives the real pipeline, never stops at failures) → `assertions.ts` +
  `failure-classifier.ts` + `statistics.ts` + `replay.ts` + `regression.ts`
  + `reporter.ts`.
- **Tier discipline** (what keeps findings honest): `strict` = phrasing the
  engine's own test suites prove — a miss is a bug. `natural` = realistic
  but never-promised phrasing — a miss is a measured understanding-rate
  weakness, but a WRONG action (different item, wrong quantity, silent
  ambiguity resolution) is a bug at every tier. `corrupted` = deliberately
  damaged text — judged like natural, with defensible readings allowed.
  Strict templates were calibrated against the real pipeline with probe
  runs before the production run.
- **Conditional assertions**: expectation checks judge against the REAL
  before-context, not generator predictions — "remove X" only demands X
  disappear if X was actually in the cart, so one misunderstood turn never
  cascades into phantom downstream failures.
- **Run results (seed 20260703, 20,000 conversations, 174,949 turns,
  ~44s)**: 76.48% conversation success rate, 24 distinct bug signatures,
  readiness score 69/100. Top findings, all reproduced live before being
  recorded: (1) five menu items are UNORDERABLE by their exact full names
  ("Pizza Large 12 inch", "Pizza Regular 9 inch", "Pizza Small 6 inch",
  "Chicken Strips 6 pcs with fries", "Hot Shot 8 pcs with fries" — token
  overlap with the toppings/fries items makes even the exact name
  ambiguous, and the clarification label degrades to nonsense like "Aap
  kaunsa Pcs with fries chahenge?"); (2) SAFETY: "how much is Mexican
  Sandwich" ADDS the item to the cart (English price questions parse as
  adds), and pasting raw JSON ({"intent":"ADD_ITEM",...}) also mutates the
  cart; (3) quantity words are silently dropped — "do/two X add karo" and
  "X x2" all add quantity 1 (wrong order risk); (4) a clarification's
  pending quantity is lost — "3 zinger" → "Zinger Burger W/C" lands 1, and
  a typo'd clarification answer can ADD the item while the reply claims
  it's not on the menu; (5) delivery-fee/delivery-time questions get a
  misleading checkout-flow error instead of the configured facts; (6)
  "X ki jagah Y kar do" and "replace X with Y" don't replace (the engine's
  only replace phrasing is "X hata kar Y add karo") — the ki-jagah form
  adds while keeping both items.
- **Regression pipeline**: `tests/qa/regressions.generated.json` (checked
  in) holds one entry per distinct bug signature with the full replayable
  conversation. `npm run test:qa` replays every entry through the real
  pipeline: `"open"` bugs must still reproduce (a fix flips them to
  `"fixed"`), `"fixed"` bugs must never reproduce again. Re-running the
  simulator merges new findings without clobbering triage statuses.
- **Replay**: every failed conversation is saved under `qa/output/failures/`
  (gitignored, regenerable) with root cause and exact replay command:
  `npm run qa:replay -- <file.json>`.


## Fix pass 1 — QA simulator bugs fixed (phase 14A follow-up)

All 24 bugs the Production QA Simulator discovered were root-caused and
fixed (plus 4 more found by the re-runs at stricter assertion tiers). The
final 20,000-conversation run: **0 failures, 100.00% success, readiness
score 98/100**. Every regression entry in
`tests/qa/regressions.generated.json` is now status `"fixed"` — `npm run
test:qa` permanently asserts none of them ever reproduces again.

Root causes fixed (all in V2 engine code; V1, UI, menu data, and
restaurant config untouched):

- **Quantity segmentation split item names** (`v2/intent-parser/normalize.ts`):
  digits inside names ("Pizza Small **6** inch", "Hot Shot **8** pcs") were
  read as quantity markers, making 5 items unorderable by exact name and
  producing garbage clarification labels ("Aap kaunsa Pcs with fries
  chahenge?"). Fixed with menu-derived protected digit+unit bigrams
  (`buildProtectedQtyPhrases`).
- **Price questions mutated the cart** (parser + safety): "how much",
  "kitna/kitni/kitne", "cost" added to PRICE_WORDS; safety's no-cart-action
  guard also checks the space-stripped text; one-edit typo tolerance
  ("prce", "how mucch") with a menu-vocabulary guard so "rice" never
  fuzzy-matches "price".
- **Raw JSON/markup executed as an order** (parser step 0):
  structured-looking raw text ({...}, <tags>) is rejected before token
  matching can reach the cart.
- **Quantity words dropped** (`normalize.ts`): ek/aik/one/do/two/teen/
  three/char/chaar/four/panch/paanch/five, postfix "x2"/"2x", and "X 2 pcs"
  all parse now; "do" (=2) is context-guarded (verb particle "kar do" and
  English "do you..." never count).
- **Clarification quantity lost + add-while-denying contradiction**
  (`v2/order-state-engine/clarification.ts`): a bare variant answer inherits
  the pending quantity ("3 zinger" -> "Zinger Burger W/C" lands 3); a
  REJECT_UNAVAILABLE (typo-heavy) answer re-asks instead of being
  fuzzy-resolved; informational intents (price/info) asked mid-clarification
  are answered as themselves BEFORE any resolution attempt (a price
  question was being "resolved" into an add).
- **Info questions misrouted** (parser ordering): restaurant-info detection
  (now covering location/timings/fees/delivery-time vocabulary in both
  languages) runs before the show/price/delivery classifiers, so "delivery
  charges kitne hain" answers from restaurant-config.json instead of a
  checkout error, and "address batao" isn't hijacked by the show-word
  "batao".
- **Replace variants** (parser): "X hata kar Y add karo", "X ki jagah Y kar
  do", "X ke bajaye Y", "replace X with Y", "change X to Y" all extract a
  non-empty source+target (the empty-source parse was producing a malformed
  blank-name reply); "change ... quantity ..." still routes to
  CHANGE_QUANTITY.
- **Category-scoped resolver substring bug** (`matching.ts`): the same 3+
  char guard resolveItemQuery already had ("ok" inside "sm-OK-e") was
  missing from resolveItemQueryWithinCategory — a noise token "b" was
  matching "vegeta-B-le rice" via category anchoring.
- **Corrupted-verb hardening** (parser): remove/price verbs are detected on
  the space-stripped message ("r emo ve", "zah atado", "kipric eky ahai")
  and via one-edit typo matching ("removee", "rmeove", "remve", "haata
  kar"), so a damaged verb reads as its intent instead of falling through
  to the ADD fallback.
- **Reply consistency** (`response-builder/`): add confirmations state the
  quantity that actually landed (never contradicting the cart); rejection
  messages never print a blank item slot; conversational noise ("bhai",
  "i want") no longer poisons an add as unavailable.

Tests: `tests/v2/qa-fixes.test.ts` (30 targeted tests next to the fixed
modules, all driving the real pipeline). Full suite after the fixes:
**1003 v2 tests + 52 QA tests + 1172 V1 tests, all passing**; `tsc
--noEmit` and `npm run build` clean.

## Customer Conversation Layer design notes (phase 15)

14 first-class conversational intents, never mutating the cart unless a
state explicitly requires it. Key design points:

- **Two detection styles by hijack risk** (v2/intent-parser/parser.ts):
  WHOLE-MESSAGE sets for short/ambiguous words (YES's "haan", HELP's
  "help") — "hello, 2 zinger burger" fails the whole-message check and
  still orders; CONTAINS lists only for unmistakable phrases ("cancel",
  "shikayat", "kya acha hai"), checked before the show/price
  classifiers because these often carry a show/price word ("kuch acha sa
  BATAO", "bitcoin ka RATE batao").
- **All 14 map to legacy type "unknown"** -> safety is always
  NO_CART_ACTION; any state effect is the order-state-engine's decision.
- **State-aware YES/NO**: YES at ORDER_REVIEW confirms, YES at
  READY_TO_SUBMIT submits, YES at AWAITING_DELIVERY_PICKUP re-asks; NO
  declines without destroying anything, and NO to a "which one?"
  clarification drops it cleanly.
- **WAIT pauses safely**: handled globally before state dispatch — no
  transition, nothing forgotten, the next message resumes exactly where
  the customer left off.
- **CANCEL_ORDER finally wires the long-documented cancelOrder()**: any
  state with something to cancel -> CANCELLED (terminal); bare "cancel"
  with nothing in progress is a polite no-op, never a dead-end.
- **Recommendations come from the live menu** (conversation.ts's
  pickPopularItems): a preferred flagship-id list verified against the
  menu at runtime, topped up per category — names and prices always from
  the Menu object.
- **Bug found by this layer's own tests**: any multi-word conversational
  message sent at AWAITING_ADDRESS was being STORED as the delivery
  address ("manager se baat karni hai" became the address), and a bare
  "help"/"salam" at AWAITING_NAME became the customer name ("Help").
  Fixed with guards.ts#isConversationalIntent guards in both capture
  handlers.
- Tests: tests/v2/conversation-layer.test.ts (182 tests). Suite after:
  1194 v2 + 52 QA + 1172 V1, all passing; 20k QA simulation still 0
  failures, readiness 98/100.

## Action Planner + Clarification Queue refactor

Real customer messages routinely name several things at once ("ek hotshot
kardo ek pasta or 4 chowmein"), and any of those things can independently
be exact, ambiguous, or unavailable. The pre-refactor architecture
aggregated a whole message's items into ONE worst-case safety verdict
(`evaluateSafety`'s `worstOf()`) — so a single ambiguous item silently
blocked every OTHER item in the same message from being added, and
`pendingClarification` was a single slot, so a SECOND ambiguous item in the
same message was lost the moment the first one was asked about. Both are
now fixed by two new, general components (never phrase-patched to the
specific example above):

- **`v2/action-planner/`** — `buildActionPlan(parseResult, menu)` converts
  ANY `ParseResult` (from the deterministic parser OR, via
  `v2/llm/parse-result-mapper.ts`, a validated LLM response — both share
  the same contract, verified by a dedicated test) into an `ActionPlan`:
  every item is classified INDEPENDENTLY, mirroring
  `intent-parser/safety.ts#evaluateAddItem`'s own per-item rule (single
  high-confidence candidate → `ADD_ITEM`; 2+ candidates, or one candidate
  below the confidence threshold → `ASK_CLARIFICATION`; 0 candidates →
  `REJECT_UNAVAILABLE`) instead of re-aggregating to one verdict.
  `resolveCategoryLabel` preserves the parser's own narrower "family"
  labels (e.g. "zinger" — 3 items within Burgers, not the whole category)
  for the ref they were computed for, and derives a correct label for any
  OTHER ambiguous ref in the same message from the real menu category its
  candidates share.
- **`v2/cart-engine/action-plan.ts#executeActionPlan`** — applies only the
  plan's `ADD_ITEM` entries, in order (the ordered task queue for one
  message); `ASK_CLARIFICATION`/`REJECT_UNAVAILABLE` entries never touch
  the cart here.
- **Clarification Queue** — `OrderContext.clarificationQueue?:
  PendingClarificationContext[]` (optional, additive — every pre-existing
  fixture/consumer that only ever set `pendingClarification` keeps working
  unchanged via `getClarificationQueue()`'s fallback). Invariant
  `pendingClarification === queue[0]`, maintained everywhere through
  `withClarificationQueue()`. `applyCartEdit`'s `ADD_ITEM`/
  `ADD_MULTIPLE_ITEMS` branch now executes the plan immediately (exact
  items land even when another item in the same message is still
  ambiguous or unavailable — the core "never drop items" fix) and APPENDS
  new ambiguities onto the existing queue rather than overwriting it.
  `handleAwaitingClarification` was simplified to: NO declines just the
  current question and advances the queue; `REMOVE_ALL`/clearing the cart
  is the one explicit rule-8 exception that drops the WHOLE queue;
  `SHOW_MENU` still abandons it (2 pre-existing tests lock this — browsing
  away from an order is different from editing it); every other cart edit
  (a new unrelated add, `REMOVE_ITEM`/`REPLACE_ITEM`/`CHANGE_QUANTITY`) and
  every checkout-flow/informational/conversational message PRESERVES the
  entire queue untouched, letting the response builder decide the reply.
- **A real bug fixed in `resolveClarificationReply`**: it used to accept
  ANY `ParseResult` whose own shape happened to look "resolved"
  (`safetyDecision === SAFE_TO_EXECUTE` or a category-scoped single match)
  as an answer to the pending question — so `"gyro remove karo"` sent while
  `"which pasta?"` was pending could get silently rewritten into an
  `ADD_ITEM` of a gyro (since its already-resolved single candidate looked
  like a valid "answer") instead of removing one, dropping the pasta
  question in the process. Fixed with an explicit intent whitelist
  (`ADD_ITEM`/`ADD_MULTIPLE_ITEMS`/`ASK_CLARIFICATION`/`UNKNOWN` only) —
  every other intent is now handled as itself by the order state engine,
  never funneled through the clarification-answer resolver.
- **Bare category browse** (rule: "if customer asks category menu like
  'burger', show only that category"; "never show full menu unless...").
  `matching.ts#findCategoryByName` (whole-string, singular/plural-tolerant:
  "burger"/"burgers" both match "Burgers") lets the parser recognize a bare
  category name with no order verb and no quantity ("burger", "pizza") as
  browsing, not an ambiguous add attempt — showing the WHOLE category (all
  6 burger items) rather than asking "which burger?". The same matcher
  also fixes an existing gap in `SHOW_OPTIONS`'s leftover-text path
  ("burger dikhao"/"burger menu"): the literal substring matcher it
  previously used missed items whose name doesn't literally contain the
  category word (e.g. "Jumbo Zinger" has no "burger" in it), so it used to
  show only 5 of the 6 burger items — now shows all 6, for every category.
- **Response builder**: `buildResponse`'s `AWAITING_CLARIFICATION` branch
  was restructured so a turn that both adds something exact AND still has
  a question pending shows BOTH — a diff-based `buildAddedItemsSummary`
  (never trusts `parseResult.actions`, which still describes the full
  original request including the parts that didn't resolve) confirms what
  landed, then the clarification question follows (rule 7). Checkout-flow
  intents sent while a clarification is pending get a
  `CLARIFICATION_BLOCKS_CHECKOUT_NUDGE` + the repeated question instead of
  being silently ignored. `NO` mid-clarification always shows the
  (possibly now-advanced) question rather than a generic decline reply — a
  bug caught while writing this phase's own tests (NO was incorrectly
  matching the generic conversational-reply branch before the
  clarification-repeat branch).
- **Deliberate behavior change, one existing test updated**: checkout/
  confirm/select-delivery-pickup/provide-address/provide-name used to
  silently ABANDON a pending clarification and proceed. They now BLOCK
  until the clarification is resolved — an order is never finalized while
  it's still missing an item the customer asked for. The one test that
  locked the old "abandons" behavior was updated to assert the new
  "blocked and preserved" behavior instead.

Tests: `tests/v2/action-planner.test.ts` (37 tests) covering the Action
Planner unit-level (including LLM-path compatibility), the exact required
multi-clarification scenarios (`ek hotshot kardo ek pasta or 4 chowmin`,
`2 pasta 3 pizza 1 burger`, `5 pasta` then `2 small 2 large 1 alfredo`),
bare category browse (`small`/`chicken`/`burger`/`burger menu`), replace/
clear-cart/checkout while a clarification queue exists, WAIT-then-resume,
NO-declines-and-advances, and an invariant sweep proving an exact item is
never dropped regardless of message order. Full suite: **1231 v2 + 52 QA +
1172 V1**, all passing; `tsc --noEmit` and `npm run build` clean; 20,000-
conversation QA simulation: **0 failures, readiness 98/100** (one harness
assertion — `expectedStateAfterCartEdit` — updated to recognize that a
cart edit from `AWAITING_CLARIFICATION` can now legitimately stay there
when an earlier ambiguity is still unresolved, not a regression). V1
completely untouched (`git diff --stat` against every V1 path empty).

## V1-vs-V2 behavioral audit

Drove the same messages through V1 (`lib/engine/v1.ts` → `lib/think-food-ai.ts`,
unmodified) and V2 side by side, one intent category at a time: greetings,
menu/category requests, add/remove/replace, price questions, unavailable
items, checkout, yes/no, complaints, recommendations, help, restaurant
info, and the clarification flow. **V2 was at parity or clearly better in
every category** (small-talk, help, cancel, thanks, and recommendations in
particular are handled properly in V2 where V1 falls back to a generic
"I can help with menu/prices/orders" message) — the Conversation Layer and
Action Planner phases had already closed most of the historical gap. Two
concrete, general bugs were found and fixed; neither was a phrase patch:

- **"full menu"/"complete menu"/"sab menu"/"poora menu" were all broken** —
  each returned "Maaf kijiye, full/complete/sab/poora se related koi item
  nahi mila" instead of the whole menu. Root cause: `menu` is a SHOW_WORD,
  so it got stripped, but the intensifier word itself ("full", "sab", ...)
  was left as leftover text and treated as a (failed) category-name
  lookup. Fixed by adding `FULL_MENU_WORDS` (full/complete/sab/sub/poora/
  pura/puri/pori) to the same strip pass as `SHOW_WORDS` when computing
  the leftover — these words are now stripped as intensifiers just like
  "menu"/"dikhao" are, for ANY combination, not just the four literal
  phrases the task named. Verified bare `"menu"` (no intensifier) is
  unaffected — still shows the full menu, same as before.
- **"order" was never in the filler-word list**, so `"burger order karo"`
  had its whole query rejected as unavailable: `resolveItemQuery`'s
  vocabulary gate rejects a query outright if ANY token isn't real menu
  vocabulary, and "order" isn't a menu word. Added to `FILLER_WORDS`
  (`v2/intent-parser/normalize.ts`) alongside the other already-established
  ordering noise words ("bhai", "want", "please", ...) — general fix, not
  specific to "burger". `"2 Zinger Burger order karo"` now adds correctly;
  bare `"burger order karo"` now correctly asks "which burger?" (ambiguous)
  instead of erroring — the cart stays empty either way until the customer
  picks one, exactly matching the "show/price never adds" safety rule.

Every category request (`burger`/`burgers`/`burger menu`/`burgers dikhao`/
`pizza menu`/`pizza dikhao`/`sandwich menu`/`sandwich dikhao`/`fries menu`/
`pasta menu`/`chowmein menu`) was verified to already correctly show ONLY
that category (a prior session's `findCategoryByName` work) — the reported
"shows full menu" symptom did not reproduce for these; only the four
full-menu-intensifier phrases and the "order" case were genuinely broken.

Tests: `tests/v2/v1-audit.test.ts` (21 tests) covering every category
request, all four full-menu-intensifier phrases plus a bare-"menu"
contrast case, the show-vs-add safety rule across every show-word variant
and every category, the "order" word fix with both its ambiguous and
exact-match contrast cases, and explicit-ordering-phrases-do-add as a
contrast to the show-words-never-add tests. Full suite: **1257 v2 + 52 QA
+ 1172 V1**, all passing; `tsc --noEmit` and `npm run build` clean; 20,000-
conversation QA simulation: **0 failures, readiness 98/100**. V1 completely
untouched (`git diff --stat` against every V1 path empty).

## V3 AI Conversation Agent

A genuine architectural shift from every prior phase: V2's own parser/
safety/cart-engine/order-state-engine/response-builder are no longer the
thing deciding what the customer wants or writing the reply. A new
top-level `v3/agent/` layer does that — V2 is used underneath purely as
**backend tools** (menu data, cart mutation, order-state guards/
transitions, the Clarification Queue, restaurant config) and, when the LLM
path isn't available, as the **whole-turn fallback** (V2's full pipeline,
including its response builder, answers the turn exactly as it always has
— never a patchwork of half-LLM, half-template).

**Architecture** (`v3/agent/`):
- `tool-schema.ts` — the fixed vocabulary of 20 tools the agent may call
  (show_full_menu, show_category, search_menu, add_item,
  add_multiple_items, remove_item, replace_item, change_quantity,
  clear_cart, get_cart_summary, queue_clarification, resolve_clarification,
  ask_clarification, start_checkout, confirm_order, select_delivery,
  select_pickup, save_address, save_customer_name, get_restaurant_info,
  escalate_to_human) + `validateAgentPlan()`, which never trusts the
  model's JSON blindly — same posture as `v2/llm/json-validator.ts`.
- `tool-runner.ts` — executes one tool against REAL V2 primitives. Every
  item mention is resolved via `v2/intent-parser/matching.ts` (the same
  deterministic, never-guessing resolution V2's own parser uses) — the
  agent only ever supplies the customer's own words, never an item id, so
  "never invent menu items" is a structural guarantee, not a prompt
  instruction. `add_item`/`add_multiple_items` reuse
  `v2/action-planner#buildActionPlan` + `executeActionPlan` and the
  Clarification Queue helpers verbatim (never re-implemented) — an exact
  item lands immediately even when another item in the same message is
  still ambiguous, and every ambiguity is appended to the queue, not
  overwritten. Every tool returns FACTS (real names/prices/totals/state)
  — the only data the reply-writing step may reference.
- `context.ts` — `AgentSession` wraps a real `v2/core/context-manager`
  `ConversationContext` (so cart/state/clarification-queue IS the same
  tested V2 shape) plus a short turn history; render helpers turn that
  into plain-language prompt sections (never JSON) for the two LLM calls.
- `system-prompt.ts` — two separate prompts: the PLANNER's (decide which
  tools to call, tool docs + rules) and the FINAL-REPLY writer's (turn
  already-executed tool facts into one natural Roman Urdu/Hinglish
  message) — kept separate so the reply-writing call never sees a tool
  name or JSON to accidentally leak.
- `planner.ts` — one LLM call, reusing V2's LLM provider plumbing
  (`v2/llm/provider.ts`'s timeout/retry/config loading) as pure transport;
  the prompt and the decision are entirely V3's own. Returns `null` on
  ANY failure (no provider, network error, invalid JSON, empty/malformed
  plan) — never throws.
- `final-reply.ts` — a second LLM call over the tool facts. Also returns
  `null` on failure. Deliberately has **no local template renderer** —
  that would make templates a second reply system instead of the
  fallback V2 already is.
- `index.ts` — the orchestrator: plan → run tools → write reply. If the
  final-reply call fails AFTER tools already ran, the tool-plan mutation
  is **discarded entirely** and the ORIGINAL (pre-mutation) conversation
  is re-processed through the full V2 pipeline instead — never a reply
  describing a cart the customer doesn't actually have.

**Two real bugs found via live testing against the actual Google AI
key** (not simulated — this is the same lesson every phase before it
learned: only a real model surfaces real model quirks):
1. An empty tool plan (`{"tools":[]}`) — the CORRECT response for pure
   small talk — was being rejected by `validateAgentPlan` as malformed.
   Fixed: only an implausibly large plan (>10 tools) is rejected now; zero
   tools is legitimate and expected.
2. The final-reply model sometimes reverts to JSON-wrapping habit
   (`{"reply": "..."}`) despite being told to respond with plain text only.
   Fixed: `final-reply.ts` now unwraps a single recognizable string field
   (reply/message/text/response/content) from a JSON-shaped answer before
   showing it to the customer, in addition to the existing code-fence and
   quote stripping.

**Rate-limit behavior confirmed, not just designed**: repeated live calls
against the free-tier Gemini key eventually hit HTTP 429 — and the
fallback caught it every time with zero customer-visible degradation
(a safe, correct, V2-consistent reply), proving the safety net works
under a genuine, organic failure, not only a simulated one.

**`AI_ENGINE=v3`**: `config/ai-engine.ts`'s `VALID_ENGINES` and
`lib/engine/types.ts`'s `AIEngineName` both extended to include `"v3"`;
`lib/engine/v3.ts` wraps the agent behind the same `AIEngine` interface
V1/V2 implement (context restored safely, falling back to a fresh session
on any foreign/corrupt shape, exactly like V1/V2's adapters);
`lib/engine/index.ts`'s safe-rollback-to-V1 rule now also covers V3 (V3's
own internal fallback to V2 already handles the overwhelmingly common
case; this outer rollback is the last-resort net for something truly
unexpected). One pre-existing test (`ui-switch.test.ts` D2) explicitly
locked `isAIEngineName` to reject `"v3"` — updated to reflect that V3 is
now a real, intentional engine.

**Verification**: `tests/v3/agent.test.ts` (29 tests, fake-fetch —
deterministic and offline, same established pattern as `v2/llm.test.ts`,
scripted from real verified model outputs) covers every required scenario
(`mujhe burgers dikhao`, `pizza menu dikhao`, `full menu dikhao`, the full
hotshot/pasta/chowmein multi-clarification chain, `5 pasta` then
`2 small 2 large 1 alfredo`, `hello`, `joke sunao`, `beef burger`,
`manager se baat karni hai`, a complaint, and the full checkout flow) plus
tool-schema/tool-runner unit tests and 6 fallback-path tests — logging,
per scenario, the customer message, the agent's tool plan, the tools
executed with their real facts, the cart after tools ran, and the final
reply. A live Playwright browser check against a real `AI_ENGINE=v3` dev
server (`mujhe burgers dikhao`) confirmed HTTP 200, zero page/request
errors, and the correct category-only response rendered in the UI.

Full suite: **1257 v2 + 29 v3 + 52 QA + 1172 V1**, all passing; `tsc
--noEmit` and `npm run build` clean (the `v3/` tree bundles correctly
through the API route, server-side only, same client/server discipline as
V2). 20,000-conversation QA simulation (which stresses the underlying V2
engine V3 depends on as both tool library and fallback): **0 failures,
readiness 98/100**, unchanged from before this phase since no V2 source
file was modified — only new `v3/` code was added and the engine selector
was extended. V1 completely untouched (`git diff --stat` against every V1
path empty).

## V3 reply normalizer design notes

Live testing against the real Google AI key (see above) surfaced
formatting bugs beyond the two already fixed by `final-reply.ts`'s
original minimal `stripWrapping()`: literal `\n`/`\n\n` reaching the
customer as escaped text instead of real line breaks, `Rs.`/`Rs` instead
of `PKR`, and emoji spam. `stripWrapping()` was replaced with a proper,
dedicated, comprehensively-tested pipeline: `v3/agent/reply-normalizer.ts`'s
`normalizeReply()`, the last step before an LLM-written reply reaches the
customer. Pure string transforms only — never touches the cart, order
state, or menu prices, only how the reply reads.

**Pipeline** (`normalizeReply`, in order):
1. `unwrapJsonOrFence` — strips a markdown code fence, then unwraps a
   single recognizable string field (reply/message/text/response/content)
   from a JSON-shaped answer, then strips a redundant wrapping quote pair
   (supersedes the old `stripWrapping`).
2. `unescapeNewlines` — a literal `\n`/`\r\n`/`\t` (two-character escape
   sequences, not real whitespace) becomes a real line break/space.
3. `collapseBlankLines` — trims trailing whitespace per line, collapses
   3+ consecutive newlines down to one blank line (called twice in the
   pipeline: once right after unescaping, once after bullet/currency/emoji
   normalization, since those steps can themselves introduce new blank
   runs).
4. `stripInternalLeakage` — strips, in order: any of the 20 real tool
   names (imported from `tool-schema.ts`'s `TOOL_NAMES`, so this list can
   never drift out of sync with the real tool vocabulary), known
   debug/pipeline field words (`toolPlan`, `toolsExecuted`,
   `activeEngine`, `parserSource`, `fallbackUsed`, `rawState`, `usedLLM` —
   the field names used by `lib/engine/v3.ts`'s debug object and V3's
   internal turn-result shape), quoted `"key":value` JSON fragments even
   when NOT wrapped as one clean top-level object (`unwrapJsonOrFence`
   only unwraps a whole object; this catches JSON embedded mid-sentence),
   raw hyphenated menu/session ids (lowercase, hyphen-joined, 3+ segments
   — real Roman Urdu/English reply text essentially never takes this
   shape), and any stray `{}[]` brace/bracket characters.
5. `normalizeCurrency` — `Rs.`/`Rs` (prefix or suffix, with or without a
   period) becomes `PKR <amount>`, always exactly one space, never
   altering the digits themselves.
6. `limitEmojis` — keeps at most the first 2 emojis (Unicode ranges
   covering Misc Symbols/Pictographs, Emoticons/Dingbats, arrows, Misc
   symbols, the variation selector), drops the rest, cleans up the
   resulting double-spacing.
7. `normalizeBullets` — `-`/`*`/`•` list markers all become the same `•`.
8. `splitLongParagraphs` — a paragraph over 220 characters with no
   existing line breaks is split at sentence boundaries (`. `/`!`/`?`
   followed by a capital letter) into shorter paragraphs, never mid-
   sentence.

`final-reply.ts` now calls `normalizeReply(result.raw)` in place of the
old local `stripWrapping()`, which was deleted.

**A real regex bug caught by its own test suite, not by inspection**: the
first version of `normalizeCurrency` captured only a single digit
(`(\d)`) in a reorder step meant to handle the "`<number> Rs`" case,
which silently corrupted multi-digit amounts once that single digit was
swapped with "PKR" — `"Total: Rs 500"` came out as `"Total: 50PKR 0"`.
Caught immediately by the `["Rs.500", "Rs. 500", "Rs500", "Rs 500",
"500Rs", "500 Rs."]` sweep test (a single hardcoded example would have
missed it), fixed by capturing the full digit run (`(\d+)`) in every
step instead of reordering a partial match. A second, subtler bug in the
same function: `/(\d+)\s*Rs\.?\b/` failed to consume a trailing period
before end-of-string, because `\b` requires a word char on one side and
`.` at the very end of the string has non-word characters on both
sides — fixed by replacing the trailing `\b` with a `(?!\w)` lookahead,
which doesn't have that same-side-blindness problem.

**Verification**: `tests/v3/reply-normalizer.test.ts` (28 tests, wired
into `test:v3`) covers all 8 required categories (escaped newlines, real
newlines preserved, Rs->PKR, emoji limit, long-paragraph split, bullets
preserved, no JSON leakage, no debug/internal-id leakage) plus a
currency-numeric-correctness check, driving the real pipeline functions
against realistic broken output produced during live model testing.
`tests/v3/agent.test.ts`'s existing 29 tests re-run clean with zero
regressions — the fuller normalizer produces a superset-correct output
(also fixing currency/emoji formatting the old `stripWrapping` left
alone) without breaking any scripted expectation.

Full suite: **1257 v2 + 57 v3 (29 agent + 28 normalizer) + 52 QA + 1172
V1**, all passing; `tsc --noEmit` and `npm run build` clean. 20,000-
conversation QA simulation: **0 failures** (unchanged — no V2 source file
touched, only `v3/agent/reply-normalizer.ts` added and `final-reply.ts`'s
one call site updated). V1 completely untouched (`git diff --stat`
against every V1 path empty).

## V3 call-reduction refactor (2026-07-06, phase 18 follow-up 2)

The original architecture spent 2 Gemini calls per LLM-handled turn
(planner, then final-reply) — with the free-tier key, this meant hitting
HTTP 429 roughly twice as often as necessary. Refactored to at most 1 call
per turn in the common case, using three independent levers: a
deterministic no-LLM bypass for simple cases, a single combined call for
everything else, and a rare, explicitly-flagged second pass only when the
first call's blind reply draft can't be trusted.

**1. Deterministic bypass (0 LLM calls).** Before touching the LLM at all,
`v3/agent/index.ts` classifies the message with V2's own
`v2/intent-parser/parser.ts#parseMessage` — already deterministic,
already fully tested by 1172+ V1 cases and 1257 v2 cases, and exactly the
kind of classifier this task needed rather than a new keyword list.
`DETERMINISTIC_BYPASS_INTENTS` = GREETING, THANKS, GOODBYE, SHOW_MENU
(full menu), SHOW_OPTIONS (category browse), SHOW_CART (current cart/
total), ASK_RESTAURANT_INFO — exactly the 7 cases this phase's own rules
named. A bypass intent routes the WHOLE turn straight through the real V2
pipeline (`processCustomerMessage`, the same call the LLM-failure fallback
already used) — zero Gemini calls, and the reply is exactly as correct as
V2 already is. ADD_ITEM/ADD_MULTIPLE_ITEMS were deliberately NOT added to
this list even though V2 could resolve many of them deterministically too
— the task's own rules scope "use LLM only for complex natural language"
to include multi-item orders and reserve the bypass list to the 7 named
cases, so simple-item-order turns still cost their one combined call
rather than silently changing the agent's reply style for that case.

**2. Single combined call (max 1 Gemini call) for everything else.**
`v3/agent/turn-planner.ts#planAndDraftTurn` replaces the old separate
`planner.ts` (deleted) + `final-reply.ts` two-call sequence with ONE call
that returns `{"toolPlan":[...], "replyDraft":"..."}}`
(`tool-schema.ts#validateCombinedTurnPlan`). The model necessarily drafts
`replyDraft` BEFORE its own `toolPlan` has run — it has no real tool
facts yet — so the system prompt (`system-prompt.ts#buildCombinedSystemPrompt`)
explicitly tells it not to trust its own total/subtotal number and to use
the customer's own wording for item names (the tools resolve the real
item independently of what it writes either way).

**3. Deterministic correction, not a second call, for the common
mismatch.** `v3/agent/reply-correction.ts#correctReplyTotals` replaces any
"total"/"subtotal"/"grand total" figure in the draft with the REAL
subtotal from the last executed tool's cart facts — a plain regex
substitution, satisfying rule 3/4 ("if replyDraft contains wrong total,
replace it with tool result total") without ever spending a second call
on it.

**4. The rare, explicit second pass.** Some mismatches are worse than a
wrong number — a whole wrong SENTENCE ("Beef Burger add kar diya hai!"
when Beef Burger doesn't exist) that a substitution can't fix.
`reply-correction.ts#requiresSecondPass` flags a turn when tool execution
diverged from the "clean, expected" outcome the blind draft assumed: a new
ambiguous item got queued instead of added, an item came back genuinely
unavailable (`search_menu`'s `candidates` empty), or any tool reported an
explicit rejection flag (`removed`/`replaced`/`changed`/`resolved`/
`saved`/`selected`/`started`/`confirmed`/`cleared`/`found`/`pending` ===
`false`) — plus the trivial case where the draft normalizes to empty text.
Only then does index.ts spend a genuine second Gemini call, reusing
`final-reply.ts` UNCHANGED (it already writes a reply from real,
already-executed tool facts — exactly what a second pass needs). This is
"do not call LLM again unless absolutely required" in code: the second
call is the exception path, not the default.

**5. Caching (rules 6/7).** `v3/agent/cache.ts` is a simple in-memory map
keyed by resolved category/`"full_menu"`/`"restaurant_info"` — full menu,
a specific category, and restaurant info are all static for the life of
the process (the menu/config JSON never changes mid-run), so a repeat
request is answered straight from cache without even re-running the V2
pipeline, let alone an LLM call. Deliberately excludes SHOW_CART (current
cart), since that legitimately changes turn to turn.

**6. API usage tracker.** `v3/agent/usage-tracker.ts#UsageTracker` records,
per turn: whether a message was seen (`messages`), every LLM call actually
attempted (`llmCalls`, with `latencyMs`), HTTP errors (`providerErrors`,
with the `429` subset broken out as `rateLimited429`), and whole-turn
fallbacks to V2 (`fallbackCount`). `snapshot()` derives `callsPerMessage`
and `averageLatencyMs`. `processAgentMessage` accepts an optional
`options.tracker`, defaulting to a shared `globalUsageTracker`; tests pass
their own fresh instance so runs never cross-contaminate. `lib/engine/v3.ts`'s
debug object gained `llmCalls`/`bypass`/`requiresSecondPass` for
per-request observability.

**Old calls per turn vs new**: previously every LLM-handled turn cost 2
Gemini calls (planner + final-reply) unconditionally. Now: 0 calls for
greetings/thanks/goodbye/menu/category/restaurant-info/cart (bypass or
cache), 1 call for everything else in the common case (simple item
orders, multi-item orders, complaints, recommendations, unclear intent),
and 2 calls only for the rare, explicitly-flagged second-pass case (an
item turned out unavailable/ambiguous in a way a number substitution
can't fix). **429 reduction strategy**: fewer calls per turn directly
means fewer opportunities to hit the free-tier rate limit; the existing
fallback-to-V2 safety net (unchanged) still catches any 429 that does
occur, now additionally recorded by the usage tracker instead of silently
absorbed.

**Verification**: `tests/v3/agent.test.ts` grew to 41 tests (from 29) —
kept every required scenario (updated to the new single-combined-call
script format) plus new coverage: 0-LLM-call bypass for each of the 7
deterministic intents, cache-hit reuse (proven via a `fetchImpl` that
throws if ever called), the rare second-pass trigger (an ambiguous queue
and a genuinely-unavailable item), 429 handling recorded by a fresh
`UsageTracker`, an explicit "no turn exceeds 1 call unless
requiresSecondPass" invariant sweep, and `reply-correction.ts`'s unit
behavior. `tests/v3/reply-normalizer.test.ts`'s 28 tests are unaffected
(that layer wasn't touched). `planner.ts` was deleted (superseded by
`turn-planner.ts`); `final-reply.ts`'s logic is unchanged, only its role
narrowed to the second-pass path (header comment updated to reflect
that).

Full suite: **1257 v2 + 69 v3 (41 agent + 28 normalizer) + 52 QA + 1172
V1**, all passing; `tsc --noEmit` and `npm run build` clean. 20,000-
conversation QA simulation: **0 failures** (unchanged — no V2 source file
touched; this phase only edited/added files inside `v3/agent/`,
`lib/engine/v3.ts`, and `tests/v3/`). V1 completely untouched (`git diff
--stat` against every V1 path empty); `lib/engine/index.ts`'s V1/V2
safe-rollback logic and `config/ai-engine.ts` also untouched.

## V3 API Gateway (2026-07-06, phase 18 follow-up 3)

Runtime HTTP 429s were still occurring too often even after the
call-reduction refactor above. Two fixes: a much wider local-first bypass
list, and — the actual headline root cause — closing a leak where V2's
own independent LLM router was silently making a SEPARATE, untracked
Google call underneath every "0-call" bypass turn.

**Root cause of the repeated 429s.** `v3/agent/index.ts`'s `runV2Pipeline`
(called by every bypass turn, and by the true-fallback path) called
`processCustomerMessage()` without ever passing `env`/`fetchImpl`. V2's
OWN pipeline (`v2/core/executor.ts#runRouterStage`) has its own,
independent LLM integration (`v2/llm/router.ts`, built in an earlier
phase, wired into `processCustomerMessage` since phase 11) whose config
resolution is `safeLoadProviderConfigFromEnv(params.env ?? process.env)`
— so with no `env` passed, it silently fell back to the REAL
`process.env`. In any environment with a real `LLM_PROVIDER`/
`GOOGLE_API_KEY` configured (exactly what `.env.local` has), this meant
**every single "0-call" bypass turn was ALSO making its own separate,
completely untracked Google API call** via V2's router — invisible to the
V3 gateway's own `apiCallsThisTurn`/`UsageTracker` bookkeeping, and
silently doubling load on the same shared, rate-limited key. Confirmed
live: before the fix, a fresh dev server showed `reason: provider_error`
(a real, failed Google call) logged for `hello`/`mujhe burgers dikhao`/
`pizza menu dikhao`/`delivery charges kitne hain`/`kitna total hua` —
five calls that should never have happened. **Fix**: `runV2Pipeline` now
always passes `env: {}` to `processCustomerMessage`, forcing V2's router
to see "not configured" and go straight to its deterministic parser, no
network attempt, ever — V3's own gateway is the sole authority on whether
Google gets called. Re-verified live: the same 5 messages now log
`reason: missing_config` (no network attempt at all), and the one
genuinely complex message in the batch shows exactly one real
`network request attempted` line. This was a case where the automated
test suite couldn't have caught it — the TEST process's `process.env` has
no real credentials, so the leak only manifested against a real
`.env.local`; a dedicated regression test now simulates real-looking
credentials via `process.env` directly to guard against it recurring
(same "live-testing-finds-real-bugs" lesson this project has hit
repeatedly).

**Expanded local-first bypass** (`v3/agent/gateway.ts`, new file —
`classifyForBypass()` replaces the bypass logic that used to live inline
in `index.ts`): now covers greetings/thanks/goodbye/**help**, full menu,
category menu, restaurant info (already covers delivery charges/time,
address/location, phone, timing via `RESTAURANT_INFO_PHRASES`), current
cart (`SHOW_CART`) **and current total** (`HYPOTHETICAL_TOTAL` —
`"kitna total hua"` classifies here, not `SHOW_CART`, discovered by
actually running `parseMessage` rather than assuming), **checkout,
confirm order, delivery, pickup** (all four reuse V2's own state guards —
bypassing only skips the LLM, never any of V2's own correctness checks,
since `processCustomerMessage` still enforces them identically), and a
**simple exact item add** (`ADD_ITEM` with `safetyDecision ===
"SAFE_TO_EXECUTE"` and confidence ≥ 0.85 — deliberately excludes
`ADD_MULTIPLE_ITEMS` and any ambiguous/low-confidence add, since
multi-item orders and unclear item wording are explicitly reserved for
Google). Cacheable subset (`CACHEABLE_INTENTS`) grew to include
`GREETING`/`HELP` alongside menu/category/restaurant-info, since both
resolve to pure static strings (`GREETING_REPLY`, `buildHelpReply()`) —
verified by reading their V2 source before caching them.

**429 cooldown** (`gateway.ts`): `recordRateLimitHit()`/
`isCooldownActive()` are deliberately module-level (process-wide), not
per-session — one shared Google API key means one customer's rate-limit
hit should back off Google for every other customer's next request too,
not just that one session. 60 seconds. During cooldown, `index.ts` never
even attempts `planAndDraftTurn` for a non-bypass message — it returns
`COOLDOWN_BUSY_REPLY` ("System thora busy hai...") directly. Bypass
messages are completely unaffected by cooldown (checked first, always);
`cooldownActive` is still reported on their result for debug visibility,
but never blocks them.

**Per-turn observability** (`AgentTurnResult` gained 8 fields:
`apiCallsThisTurn`, `providerAttempted`, `bypassUsed`, `cacheHit`,
`cooldownActive`, `fallbackUsed`, `providerError`, `rateLimited429`) —
`lib/engine/v3.ts`'s debug object nests these under a `gateway` key
(kept separate from the object's own pre-existing top-level
`fallbackUsed`, which has a different, already-documented meaning: true
whenever the LLM path didn't answer at all, including bypass/cache/
cooldown — the gateway's `fallbackUsed` is narrower, true only when the
LLM was attempted and genuinely failed). `[v3-gateway]` console logs
(matching the existing `[llm-debug]` TEMPORARY-log convention in
`v2/llm/router.ts`) print `message`/`bypass`/`cacheHit`/`cooldownActive`/
`providerAttempted`/`apiCallsThisTurn` for every turn.

**Verification**: `tests/v3/agent.test.ts` grew to 49 tests (from 41) —
new bypass coverage for pizza/delivery-charges/current-total/help/
checkout/confirm/delivery/pickup/simple-exact-add (all proven via a
`fetchImpl` that throws if ever invoked), two dedicated cooldown tests
("next complex message doesn't attempt the provider" and "local-first
messages still work during cooldown"), and — most importantly — the
env-leak regression test that simulates real `process.env` credentials
and proves a bypass turn still makes 0 calls. Three pre-existing tests
that used `"2 zinger burger dedo"` to exercise the LLM path (429,
malformed-JSON, usage-tracker) had to switch to genuinely non-bypass
messages, since that exact phrase is now itself a 0-call bypass case.

Live browser/API validation (`AI_ENGINE=v3`, real dev server, real
`.env.local` key) drove all 6 required messages (`hello`, `mujhe burgers
dikhao`, `pizza menu dikhao`, `delivery charges kitne hain`, `kitna total
hua`, `ek hotshot kardo ek pasta or 4 chowmin`) end to end: all HTTP 200,
5 of 6 logged `apiCallsThisTurn=0` with zero network attempts, the 6th
logged exactly one real Google call.

Full suite: **1257 v2 + 77 v3 (49 agent + 28 normalizer) + 52 QA + 1172
V1**, all passing; `tsc --noEmit` and `npm run build` clean. 20,000-
conversation QA simulation: **0 failures** (unchanged — no V2 source file
touched; only `v3/agent/gateway.ts` added and `v3/agent/index.ts`/
`lib/engine/v3.ts`/`tests/v3/agent.test.ts` updated). V1 completely
untouched; `lib/engine/index.ts`'s V1/V2 safe-rollback logic and
`config/ai-engine.ts` also untouched.

## Critical clarification bypass fix (2026-07-06, phase 18 follow-up 4)

**Bug**: mid-clarification ("Aap kaunsa Pasta chahenge?"), a bare answer
like `"small"` was reaching the API Gateway's normal classification
(`classifyForBypass`), which has no idea a question is pending — bare
"small" isn't GREETING/SHOW_MENU/a high-confidence exact add/etc, so it
fell through to the combined-call path, and (worse) if a cooldown was
active from an earlier 429, the customer got "System thora busy hai..."
instead of their pasta being added. **Fix**: `v3/agent/index.ts` now
checks `getClarificationQueue(session.conversation.order).length > 0`
as step 0, BEFORE the gateway and BEFORE the cooldown check — any
pending-clarification reply is routed straight to `runV2Pipeline()`
unconditionally, ignoring cooldown entirely, exactly matching what
"resolve using V2's Clarification Queue, never call Google, ignore
cooldown" requires. `AgentTurnResult.bypass` gained a third value,
`"clarification"`, distinguishing this path from the gateway's own
`"deterministic"`/`"cache"` bypasses in tests/debug output.

**A second, deeper bug surfaced while writing the required tests** ("pasta
-> small" passed immediately; "chowmein -> chicken" and "sandwich ->
club" did not): `v3/agent/tool-runner.ts#runAdd` stored the pending
clarification's `category` field as the customer's RAW QUERY TEXT (e.g.
`"chowmein"`, `"sandwich"`) instead of the real `menu.categories[].key`
(`"noodles"`, `"sandwiches"`). This was invisible before this phase
because clarification answers used to be resolved via V3's OWN
`resolve_clarification` tool (fuzzy name-matching against
`pending.options`, never touching `category` at all) — but routing
answers through V2's OWN pipeline exposed it: `v2/order-state-engine/clarification.ts#resolveClarificationReply`
does `menu.categories.find((c) => c.key === pending.category)` to scope-
resolve a bare reply, and returns `null` (re-asks the same question)
when that lookup fails. `"pasta"` only ever worked because the query
text happens to equal the real key by coincidence; `"chowmein"`/
`"sandwich"` do not. Fixed by adding `categoryKeyForCandidates()` (mirrors
`queue_clarification`'s own existing category-key derivation) and using
it in `runAdd`, falling back to the raw query only when candidates
genuinely span more than one category. This is clarification bookkeeping
metadata, not cart mutation logic — cart/price behavior is unchanged.

**Tests**: `tests/v3/agent.test.ts` grew to 54 (from 49) — the exact bug
repro (`"ek pasta ek chowmin or do sandwich"` then `"small"`), standalone
`"chowmein"->"chicken"` and `"sandwich"->"club"` resolutions, a
clarification answered mid-cooldown, and a clarification answered
immediately after the triggering message itself hit a real HTTP 429 — all
asserting `llmCalls === 0` / `providerAttempted === false` / `bypass ===
"clarification"`, proven via a `fetchImpl` that throws if ever invoked.
One pre-existing test ("2 small 2 large 1 alfredo" following "5 pasta")
had its expectation corrected: that message IS a clarification reply, so
it now resolves via the new 0-call path instead of the old combined-call
script.

Live browser/API validation (real `.env.local` key, `AI_ENGINE=v3`)
reproduced the exact bug report end to end: turn 1 (the multi-item order)
hit a genuine HTTP 429 from the real, quota-exhausted key and correctly
armed the cooldown; turn 2 (`"small"`) still resolved Pasta Small into
the cart with `apiCallsThisTurn=0`, `providerAttempted=false`,
`cooldownActive=true` — the fix holds under real, not simulated,
rate-limit pressure.

Full suite: **1257 v2 + 82 v3 (54 agent + 28 normalizer) + 52 QA + 1172
V1**, all passing; `tsc --noEmit` and `npm run build` clean. 20,000-
conversation QA simulation: **0 failures** (only `v3/agent/index.ts` and
`v3/agent/tool-runner.ts` changed, plus `tests/v3/agent.test.ts` — no V2
source file's own logic touched, cart/price behavior unchanged). V1
completely untouched.
