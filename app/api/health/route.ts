// Production health/diagnostic endpoint — Vercel runtime hardening pass.
//
// Read-only, no cart/order/AI-engine calls at all — just reports what
// configuration the currently-running server instance actually resolved,
// straight from process.env. Never prints a key VALUE, only presence
// booleans (same rule as config/env-check.ts's startup log). Intended for
// a quick "is production actually configured?" check after deploying.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(
    {
      ok: true,
      engine: process.env.AI_ENGINE ?? null,
      providerOrder: process.env.AI_PROVIDER_ORDER ?? null,
      providers: {
        google: Boolean(process.env.GOOGLE_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      },
    },
    { status: 200 }
  );
}
