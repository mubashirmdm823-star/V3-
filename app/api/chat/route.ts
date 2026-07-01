// V2 phase 7 — chat API route.
//
// Intended to orchestrate: intent-parser -> cart-engine -> order-state-engine
// -> response-builder for a single customer message. Deliberately NOT wired
// up yet: nothing in the app calls this route, and WhatsAppSimulator.tsx
// still runs entirely on the V1 lib/think-food-ai.ts engine. Left as a
// placeholder so the folder structure for the full V2 pipeline exists ahead
// of the pipeline itself.

export async function POST() {
  return Response.json(
    { error: "not_implemented", message: "V2 chat pipeline is not wired up yet." },
    { status: 501 }
  );
}
