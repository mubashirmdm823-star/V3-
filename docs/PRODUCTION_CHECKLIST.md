# Production Checklist

Status: **Production Stabilization Mode** — run this checklist before any release/deploy. It reflects the scripts and files that actually exist in this repo today; if a script name changes, update this list to match it.

## 1. Automated Tests

```
npm run test
```
Runs, in order: `test:ai-gateway` → `test:v2` → `test:v3` → `test:vercel` → `test:qa` → `test:think-food-ai`. All must report `0 fail`. This covers the AI Gateway failover logic, the full V2 deterministic pipeline, the V3 one-call agent (all `tests/v3/phase*.test.ts` files), the Vercel API-route runtime tests, the QA production-conversation simulator, and the 1172-case V1 fuzz suite.

- [ ] `npm run test` — every suite passes, 0 failures.

## 2. Build

```
npm run build
```
Must complete with `✓ Compiled successfully` and no TypeScript errors during the build's own type pass.

- [ ] `npm run build` — clean build.

## 3. Type Check

```
npx tsc --noEmit
```
Must produce no output (no type errors) across the whole repo, independent of the build.

- [ ] `tsc --noEmit` — clean, no errors.

## 4. Golden Conversations

- [ ] `npm run test:think-food-ai` reports `Failed: 0` (all ~1172 V1 scripted conversations, including the golden clarification/show-intent regression cases, full checkout flows, and negative/safety cases).
- [ ] `npm run test:qa` reports 0 failures, including the regression suite (`tests/qa/regressions.generated.json`) — every previously-fixed bug must stay fixed, and no previously-open bug should have silently regressed further.
- [ ] If a new bug was fixed this cycle, its regression test exists in the relevant `tests/v3/phase*.test.ts` file (or `tests/v2/`/`tests/think-food-ai/` as appropriate) and is included in the `test` script chain in `package.json`.

## 5. Browser Smoke Test

Start the dev server (`npm run dev`) and manually drive these flows end-to-end against the real running app (not just scripted unit tests):

- [ ] **Greeting**: "hi" / "hello" → short greeting only, no menu dump.
- [ ] **Menu**: "menu" / "menu please" → full menu, every item priced.
- [ ] **Category**: "pizza menu dikhao" → only Pizza items, priced.
- [ ] **Recommendation**: "kuch spicy suggest karo" → priced suggestions, cart unchanged.
- [ ] **Ambiguous item**: "ek chowmein add karo" → asks Chicken/Vegetable, cart unchanged until answered.
- [ ] **Add / order review**: add an item → "order dikhao" shows the real itemized cart + total.
- [ ] **Checkout**: "checkout" → full order review → delivery/pickup → address/name → final review → "confirm" → sent for verification (never "confirmed" before that point).
- [ ] **Checkout mutation lock**: mid-checkout (past order review), attempt to add an item → blocked with the checkout-stage message, cart unchanged; checkout continues normally afterward.
- [ ] **Restaurant info**: "kahan hai" → real address; "kahan hai current order" → the order, not just the address.

## 6. Secrets / Environment

- [ ] `.env.local` is **not** committed (check `git status` / `.gitignore` before pushing).
- [ ] No API key value appears in any committed file, log, or test fixture.
- [ ] `GET /api/health` returns `ok: true` with `engine`, `providerOrder`, and boolean provider-presence flags only — **never** a real key value, even with `debug: true` on the chat route.
- [ ] Required env vars (`AI_ENGINE`, `AI_PROVIDER_ORDER`) are set in the deploy target; provider keys (`GOOGLE_API_KEY`/`GROQ_API_KEY`/`OPENROUTER_API_KEY` etc.) are present for at least one provider in the configured order. Missing keys must degrade gracefully (fallback chain / V2 fallback), never crash the app.

## 7. No Debug Spam

- [ ] No `console.log`/temporary debug output left in `v3/agent/`, `v2/`, `app/api/`, or `lib/` beyond the intentional `logger.ts`-gated logging (respects `LOG_LEVEL`).
- [ ] No scratch/repro scripts (e.g. `_smoke_*.mjs`, `_repro_*.mjs`) left in the repo root from local debugging.

## 8. No Internal Terms in Replies

- [ ] `tests/v3/reply-normalizer.test.ts` passes — confirms every one of the 11 banned terms (`backend`, `tool`, `json`, `provider`, `gateway`, `internal`, `system`, `debug`, `V2`, `V3`, `engine`) plus `front-end`/`frontend` are stripped from any customer-facing reply.
- [ ] No raw menu item ID (e.g. `chicken-chowmein`), tool/function name, or JSON-fragment-shaped text can reach a reply (`stripInternalLeakage`/`stripInternalTerms` in `reply-normalizer.ts`).

## 9. Cart and Reply Stay Synchronized

- [ ] A reply never claims an item was added/removed/replaced unless the real backend cart diff (`TurnFacts.addedLines`/`removedNames`/`replacedNames`) confirms it.
- [ ] A reply that says "current order"/"order review" always includes the real itemized cart + total — never an empty or missing listing.
- [ ] An ambiguous item is never silently resolved to one variant, in the model's draft or the final reply.

## 10. Checkout Flow Verified

- [ ] Checkout cannot be started on an empty cart.
- [ ] Checkout always shows the full review before asking delivery/pickup.
- [ ] `confirm`/"order confirmed" language never appears before the backend has actually reached the matching state (`AWAITING_DELIVERY_PICKUP` after the first confirm, `PENDING_VERIFICATION` after the final one).
- [ ] Cart mutations are blocked from `AWAITING_DELIVERY_PICKUP` onward until checkout is cancelled/edited.
- [ ] V1/V2 rollback path (`AI_ENGINE=v2` or `v1`) still starts and completes a full checkout flow, independent of any V3-specific change.

## 11. Provider Failover Verified (if provider config changed)

Only required when `AI_PROVIDER_ORDER`, a provider's model/endpoint, or `ai-gateway/` itself changed this cycle:

- [ ] `npm run test:ai-gateway` passes (cooldown, retry, and failover-order tests).
- [ ] A forced single-provider failure (e.g. temporarily invalid key for the primary provider) still produces a successful reply via the next provider in `AI_PROVIDER_ORDER`, without the customer ever seeing an error.
- [ ] Total failure of every configured provider still falls back to the deterministic V2 pipeline rather than crashing or hanging.

---

**Sign-off**: all applicable boxes above are checked before merging to `main` / deploying.
