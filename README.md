# Think Food AI (foodhub-saas)

A WhatsApp-style AI ordering assistant demo for restaurants, built on Next.js.
Three ordering engines (V1/V2/V3) live side by side behind one feature flag,
each provably rolled back to if the next one fails.

## Architecture at a glance

- **V1** (`lib/think-food-ai.ts`) — the original rule-based NLU. No LLM, no
  network calls. Always available, always the final safety net.
- **V2** (`v2/`) — a layered deterministic pipeline (intent parser → safety →
  cart engine → order-state engine → response builder), with an optional
  LLM-assisted parse step that's unconfigured in this app.
- **V3** (`v3/agent/`) — the current live engine. One LLM call per customer
  message (via the AI Gateway below) drafts a reply + tool plan; the plan is
  applied against V2's real cart/order-state engine, then the reply is fact-
  checked against what actually happened before it ever reaches the customer.
- **AI Gateway** (`ai-gateway/`) — the single chokepoint every AI-driven call
  goes through. Nothing outside this folder ever calls a provider's HTTP API
  directly.
- Every layer falls back to the one below it if it fails: **V3 → V2 → V1**,
  and within V3, **Gemini → Groq → OpenRouter → deterministic V2 fallback**.
  Nothing customer-facing ever crashes or shows an internal error.

## Environment variables

### Required (validated on server start, never crash if missing)

| Variable | Purpose | If missing/invalid |
|---|---|---|
| `AI_ENGINE` | Selects the active engine: `v1`, `v2`, or `v3` | Defaults to `v1` (the safest, LLM-free engine); an unrecognized value logs a warning and also defaults to `v1` |
| `AI_PROVIDER_ORDER` | Comma-separated AI Gateway failover order, e.g. `gemini,groq,openrouter` | Defaults to `gemini,groq,openrouter`; unknown/malformed entries are dropped silently |

### Optional provider keys (AI Gateway, used by V3)

| Variable | Provider |
|---|---|
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini (either name works) |
| `GROQ_API_KEY` | Groq |
| `OPENROUTER_API_KEY` | OpenRouter |

None of these are required. If a key is missing, that provider is skipped
(reported as `DISABLED`, never attempted, never a crash). If **all** provider
keys are missing, the AI Gateway returns `ok:false` and V3 transparently
falls back to the deterministic V2 pipeline for every message — the customer
never sees a difference beyond slightly more templated wording.

Optional tuning: `GEMINI_MODEL` / `GROQ_MODEL` / `OPENROUTER_MODEL`,
`*_BASE_URL` overrides, `AI_GATEWAY_TIMEOUT_MS` (default 8000ms).

### Logging

| Variable | Values | Default |
|---|---|---|
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` | `info` |

- `debug` — includes full per-provider-attempt tracing and the AI Gateway's
  detailed `[ai-gateway:diagnostic]` failure record (redacted, never
  contains a key value). Noisy; use for local troubleshooting only.
- `info` (default) — safe production logging: engine/provider config
  summary at startup, a one-line result per AI Gateway call, provider
  failures as short warnings. No customer message text is ever logged at
  this level.
- `warn` / `error` / `silent` — progressively quieter.

Never logged at any level: raw API key values, or customer message content
(customer text is only ever logged at `debug`, via V2's own logger module).

## How failover works

1. V3 receives a customer message and calls the AI Gateway once.
2. The Gateway tries providers in `AI_PROVIDER_ORDER`, skipping any that are
   unconfigured (no key) or in cooldown (429 → 60s, timeout/5xx → 30s,
   process-wide per provider — one shared key means one rate-limit hit backs
   off that provider for every session, not just the one that hit it).
3. First provider to succeed wins. If every provider fails or none are
   configured, the Gateway returns `ok:false`.
4. V3 then runs the customer's ORIGINAL message through the full V2
   deterministic pipeline instead — never a half-mutated, half-templated
   hybrid.
5. If V3 itself throws an unexpected error outside that internal recovery,
   `lib/engine/index.ts`'s Engine Router catches it and retries the same
   message on a fresh V1 conversation, so the customer always gets a real
   reply.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in whichever keys you have; none are required
npm run dev
```

Open `http://localhost:3000`. The engine that responds is whichever
`AI_ENGINE` resolves to (see above) — check the terminal at startup for the
`[env-check]` summary confirming what was actually picked up.

## Building

```bash
npm run build   # next build — type-checks and produces the production build
npm run start   # serve the production build
```

## Testing

```bash
npm run test            # everything: ai-gateway + v2 + v3 + qa + V1 (think-food-ai)
npm run test:ai-gateway # AI Gateway failover/cooldown/diagnostics
npm run test:v2         # V2 pipeline (parser, cart engine, order-state, response builder, ...)
npm run test:v3         # V3 agent (tool execution, reply correction, checkout hardening, ...)
npm run test:qa         # QA harness unit tests
npm run test:think-food-ai  # V1 regression suite (1172 cases)
npm run qa:simulate     # 20,000 generated conversations through the real V2 pipeline, offline, no LLM — writes qa/output/qa-report.md
npm run qa:replay -- <failure-file.json>  # replay a single saved qa:simulate failure
tsc --noEmit            # type-check without emitting
```

## Switching `AI_ENGINE`

Set the env var and restart the server — no code change required:

```bash
AI_ENGINE=v1   # deterministic rule-based engine, no network calls at all
AI_ENGINE=v2   # deterministic layered pipeline
AI_ENGINE=v3   # LLM agent via the AI Gateway (recommended / current default)
```

## Rolling back

If V3 (or V2) is misbehaving in production, rolling back is a config change,
not a deploy:

1. Set `AI_ENGINE=v2` (or `v1` for the fully LLM-free engine) and restart.
2. No data migration is needed — V1/V2/V3 don't share conversation state, so
   the next customer message simply starts a fresh conversation under the
   rolled-back engine.
3. Automatic safety net: even while `AI_ENGINE=v3` (or `v2`), an unexpected
   engine crash on a single request already falls back to V1 automatically
   for that request (see "How failover works" above) — a manual rollback is
   only needed for a *sustained* problem, not a one-off error.

## Free-tier provider limits

This project is commonly run against free-tier API keys. Free tiers rate-
limit aggressively (Gemini's free tier in particular). This is expected and
handled: a 429 cools that provider down for 60 seconds and the Gateway moves
to the next configured provider, or to the deterministic V2 fallback if none
are configured/available. If you see frequent `[ai-gateway] failed=... 429`
lines, that's the free-tier quota, not a bug — consider configuring a second
or third provider key so the Gateway has somewhere to fail over to.
