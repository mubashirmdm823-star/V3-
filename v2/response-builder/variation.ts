// Deterministic reply variation. The same structured input must always
// produce the same reply (required for reliable automated tests), so this
// is a seeded pick, never Math.random().

const ENDING_VARIATIONS = [
  "Agar aur kuch add ya change karna ho to bata dein.",
  "Aur kuch order karna ho to zaroor batayein.",
  "Agar order mein koi tabdeeli karni ho to bata dein.",
  "Agar sab theek hai to order review ke liye aage barhte hain.",
  "Agar aur kuch chahiye ho to main madad ke liye hazir hoon.",
] as const;

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Picks a deterministic entry from `pool` based on `seed` — same seed
// always yields the same variation; different seeds spread across the
// pool so a real conversation doesn't see the same ending every turn.
export function pickVariation(pool: readonly string[], seed: string): string {
  if (pool.length === 0) return "";
  return pool[hashString(seed) % pool.length];
}

export function pickEndingVariation(seed: string): string {
  return pickVariation(ENDING_VARIATIONS, seed);
}

export { ENDING_VARIATIONS };
