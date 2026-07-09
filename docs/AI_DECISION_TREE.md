# AI Decision Tree

Status: **Production Stabilization Mode** — this document describes the actual decision flow implemented by the V3 engine (`v3/agent/`). It is a reference, not a spec for new behaviour; if the code changes, this document should be updated to match it.

## General Shape

Every customer turn follows the same shape, regardless of intent:

```
Customer message
    │
    ▼
Model drafts ONE structured plan:
  { reply, cartActions[], checkoutAction, recommendationRequest }
  (v3/agent/index.ts → the single Gemini/Groq/OpenRouter call via ai-gateway/)
    │
    ▼
Backend applies the plan against REAL state (never trusts the draft):
  - cartActions  → v3/agent/actions.ts (validates against real menu/cart,
                    resolves ambiguity, applies the checkout mutation lock)
  - checkoutAction → v3/agent/actions.ts + checkout-guard.ts (state-machine
                    guarded — a wrong-state action is rejected, never
                    silently "succeeds")
  - recommendationRequest → v3/agent/multi-intent.ts + recommendation-engine.ts
    │
    ▼
Backend produces FACTS (TurnFacts): what was actually added/removed/
replaced, the real cart before/after, the real clarification queue,
whether checkout was actually applied/rejected/blocked
    │
    ▼
correct-reply.ts: narrow, bounded corrections to the model's draft text
  (wrong totals, false "added"/"confirmed" claims, ungrounded item
  guesses, incomplete order claims, blocked-mutation wording)
    │
    ▼
reply-orchestrator.ts: exactly ONE deterministic override wins, in a
fixed priority order (see below) — every candidate is computed
independently; the first non-null one is used, falling back to the
corrected model draft only if nothing else applies
    │
    ▼
reply-normalizer.ts: final formatting pass (currency, bullets, emoji
limit, blocked/internal-term stripping) — always runs, on every reply
    │
    ▼
Reply sent to customer
```

## Reply Priority Order (highest first)

This is the actual tier order `reply-orchestrator.ts` uses — every tier below is a candidate computed independently; the first one with a non-null value wins the whole turn's reply.

1. **Post-order acknowledgement** — a plain "ok"/"thanks" once the order is already pending verification.
2. **Checkout** — final submit → name/address capture → delivery/pickup selection → order review (start_checkout) → checkout rejection, in that sub-order.
3. **Order review / current cart request** (+ "no more items, what's next?").
4. **Total / bill request.**
5. **Clarification** — a newly-queued ADD ambiguity → a newly-queued REMOVE ambiguity → a still-ambiguous clarification answer.
6. **Recommendation** the model itself classified (a confident, structured signal — outranks a plain cart-mutation confirmation so a compound "remove X and suggest Y" turn shows both).
7. **Real cart mutation** that happened this turn (add/remove/replace/quantity change).
8. **Menu / category / full menu request** (+ intro-only-draft backstop).
9. **Recommendation raw-text fallback** (only when the model failed to classify a themed request at all — a much weaker signal, so it never outranks a real cart mutation).
10. **Restaurant info** (address/phone/timing/delivery fee/time).
11. **General reply** — the corrected model draft, unconditionally, when nothing above applies.

---

## Per-Intent Decision Trees

### Greeting

```
"hi" / "hello" / "hey" / "salam" / ...  (exact, whole-message match)
    │
    ▼
No cart action executes. No checkout action executes.
    │
    ▼
Model's greeting draft is used as-is — EXCEPT the menu-intro-only
backstop is explicitly disabled for a bare greeting, so a draft that
politely offers "would you like to see the menu?" is never expanded
into the actual full menu.
    │
    ▼
Reply: short greeting + offer to help. No menu, no prices, no cart change.
```

### Menu Request

```
"menu" / "menu please" / "full menu" / "show menu" / "view menu" /
"kya kya hai" / "kia kia available hai" / other listing-intent wording
    │
    ▼
No specific category mentioned?
    │
    ├── Yes → renderCategoryBrowseIfApplicable: full menu, every category,
    │         every item with its real price
    │
    └── No, a category IS named ("pizza", "burgers", ...)
              → that category ONLY, every item with its real price
    │
    ▼
Backstop: if the model's own draft mentions "menu" but lists zero priced
items (and the message isn't a bare greeting or a restaurant-info ask),
the draft is discarded and replaced with the real, priced list.
```

### Category Request

```
"<category word> dikhao/batao/menu" (e.g. "pizza menu dikhao")
    │
    ▼
Category keyword matched against the real menu categories
    │
    ▼
Only that category's real items are shown, each as:
  • Item Name — PKR Price
(A specific category always wins over a bare "menu" mention in the
same message.)
```

### Recommendation

```
Customer asks for a suggestion (theme words: spicy, mild, popular,
kids, vegetarian, or a category-exclusion phrase like "burger ke ilawa")
    │
    ▼
Model classified a recommendationRequest?
    │
    ├── Yes → recommendation-engine.ts resolves real, theme-matching
    │         items from the live menu, scoped to conversation context
    │         when relevant, EXCLUDING any category the customer just
    │         explicitly ruled out (even if it means falling back to a
    │         broader pool)
    │
    └── No  → raw-text theme fallback (weaker signal, tier 9) catches
              a themed request the model failed to classify at all
    │
    ▼
Any cartAction attached to THIS turn is dropped — a recommendation
never adds to the cart on its own.
    │
    ▼
Reply: real, priced items only (never an unpriced or invented item).
```

### Ambiguous Item

```
Customer names an item that matches 2+ real menu items
(e.g. bare "chowmein" → Chicken Chowmein / Vegetable Chowmein)
    │
    ▼
Does the model's OWN query resolve to exactly ONE candidate?
    │
    ├── Yes → is the word that distinguishes it from its siblings
    │         (e.g. "chicken") actually present in what the customer
    │         said?
    │           ├── Yes → trusted, added directly
    │           └── No  → treated as ambiguous anyway (the model's own
    │                     guess is never trusted over the customer's
    │                     actual words) — falls through to "ask"
    │
    └── No, genuinely 2+ candidates → ask
    │
    ▼
"Ask": a clarification is queued with the real, priced option set —
NEVER silently resolved to one variant. Nothing is added to the cart
this turn.
    │
    ▼
Next customer reply is checked ONLY against the pending option set
(never the whole menu) → resolves to the matching item, or stays
pending if it still doesn't clearly answer the question.
```

### Add Item

```
Customer message clearly names an item + (implicit or explicit) quantity
    │
    ▼
Is a cart mutation currently locked? (checkout state — see "Checkout"
tree below)
    │
    ├── Yes → nothing executes; customer is told they're in the
    │         checkout stage and must cancel/edit first
    │
    └── No  → resolve item against real menu (see "Ambiguous Item" tree)
              │
              ├── Exactly 1 real candidate → added to the real cart
              ├── 0 candidates → "not available" (never invented)
              └── 2+ candidates → clarification queued (see above)
    │
    ▼
Reply reflects the REAL cart diff — only items that actually landed in
the cart are ever described as "added."
```

### Remove Item

```
Customer asks to remove an item
    │
    ▼
Is a pending removal question already open (2+ matching items were
found in the cart on an earlier turn)?
    │
    ├── Yes → this reply is checked strictly against those exact
    │         options — resolves the removal or stays pending
    │
    └── No  → resolve the query against what's ACTUALLY in the cart
              │
              ├── Exactly 1 match → removed
              ├── 0 matches → no-op, nothing removed
              └── 2+ matches (ambiguous within cart) → a NEW removal
                  question is asked, scoped to the cart's own matches
    │
    ▼
Reply reflects the real cart diff — only genuinely removed items are
ever described as "removed."
```

### Replace Item

```
Customer asks to swap one item for another (or "large kar do"/
"medium kar do" style size-change, normalized to a replace first)
    │
    ▼
Source resolves to exactly 1 item ALREADY in the cart, AND
target resolves to exactly 1 real menu item?
    │
    ├── Yes → replaced in place (cart order/position preserved)
    └── No  → nothing changes; reply never claims a replace happened
```

### Order Review

```
Customer asks "order dikhao" / "current order" / "mera order" / etc.,
OR checkout review/no-more-items is triggered
    │
    ▼
Real cart is empty?
    │
    ├── Yes → friendly "cart is empty, want to order something?" reply
    └── No  → itemized list straight from the real cart + real menu
              prices, ALWAYS as:
                • Item × Quantity — PKR LineTotal
                Total: PKR <real total>
    │
    ▼
A model draft that CLAIMS to show the order/review but lists no priced
items is replaced with this real content — a claim without content is
never delivered.
```

### Checkout

```
Customer says "checkout"/"place order"/"proceed" (start_checkout), OR
"confirm"/"bas"/"yahi order hai" once order review has been shown
    │
    ▼
start_checkout:
  Cart empty or wrong state? → rejected, honest reason given
  Otherwise → state moves to ORDER_REVIEW; full itemized review +
              total is shown BEFORE ever asking delivery/pickup
    │
    ▼
confirm_order (from ORDER_REVIEW):
  → moves to AWAITING_DELIVERY_PICKUP
    │
    ▼
FROM HERE ON (AWAITING_DELIVERY_PICKUP / AWAITING_ADDRESS /
AWAITING_NAME / READY_TO_SUBMIT / PENDING_VERIFICATION):
  Cart mutations are LOCKED — an add/remove/replace attempt in this
  window does not execute; the customer is told to cancel/edit first.
  Checkout-relevant actions (delivery/pickup/address/name/final
  confirm) are UNAFFECTED by that lock and continue normally.
    │
    ▼
confirm_order (from READY_TO_SUBMIT):
  → moves to PENDING_VERIFICATION
  → ONLY here is "sent for verification" language used — never
    "confirmed," since staff still verifies by phone.
```

### Delivery/Pickup

```
State is AWAITING_DELIVERY_PICKUP
    │
    ▼
"delivery" → AWAITING_ADDRESS
"pickup"   → AWAITING_NAME (no address needed)
Anything else → re-asked; never silently guessed
```

### Address/Name Capture

```
State is AWAITING_ADDRESS or AWAITING_NAME
    │
    ▼
The CUSTOMER'S RAW TEXT — not the model's chosen action — decides
what happens (checkout-guard.ts is fully deterministic here):
    │
    ├── Looks like a real address/name (passes shape + rejects
    │   browse/menu/order words and disallowed tokens like "help",
    │   "confirm", "cancel")
    │       → saved; state advances (AWAITING_ADDRESS → AWAITING_NAME
    │         → READY_TO_SUBMIT)
    │
    ├── A recognized "wait" phrase → acknowledged, nothing changes,
    │   never treated as a failed answer
    │
    └── Anything else (implausible name/address, a menu/order request,
        "confirm", "yes/no") → re-asked for the real name/address;
        never silently accepted, never falsely claimed as saved
    │
    ▼
Once name is saved: a FULL final review (items, delivery/pickup +
address, name) is shown before the final "confirm" submits.
```

### Post-Order Acknowledgement

```
State is PENDING_VERIFICATION, customer sends a plain acknowledgement
("ok"/"thanks"/"theek hai"/...)
    │
    ▼
Already thanked once this conversation?
    │
    ├── No  → one polite "your order is in verification, staff will
    │         confirm shortly" reply; marked as thanked
    └── Yes → short "already in verification" reply, no repeat of the
              full finalization message
    │
    ▼
Cart is NEVER mutated by this reply, even if the model drafts a
cartAction for it.
```

### Restaurant Info

```
Customer asks about address / phone / timing / delivery time / delivery
fee ("kahan hai", "location", "timing", ...)
    │
    ▼
Does the message ALSO carry order/cart/checkout/menu intent?
    │
    ├── Yes → that higher-priority tier wins (order review, checkout,
    │         menu, etc. — restaurant info is deliberately the lowest
    │         "replacing" tier, so "kahan hai current order" shows the
    │         ORDER, not just the address)
    │
    └── No  → the real restaurant-config value(s) are stated —
              additively appended if the model's draft is otherwise
              fine, or the draft is replaced outright if it drifted
              into unrelated content (e.g. hallucinating "menu" for a
              pure location question)
```

### Irrelevant Message

```
Message doesn't match any of the above (small talk, off-topic,
complaint, confused customer, etc.)
    │
    ▼
No cart action executes. No checkout action executes.
No override tier fires.
    │
    ▼
Reply falls through to the corrected model draft (tier 11, "general
reply") — still passed through reply-normalizer.ts, so it can never
leak internal terms, raw IDs, or malformed formatting, and correct-reply.ts
has already stripped any false added/removed/confirmed claim.
```
