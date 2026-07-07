// QA phase 14A — deterministic seeding.
//
// Every simulated conversation must be exactly reproducible from a number:
// the run seed picks the whole simulation plan, and each conversation gets
// its own derived seed so a single failing conversation can be replayed in
// complete isolation (see qa/replay.ts) without re-running the other
// 19,999. No Math.random() anywhere in qa/ — all randomness flows from
// these functions through qa/randomizer.ts's Rng.

export const DEFAULT_RUN_SEED = 20260703;

// FNV-1a 32-bit — stable, dependency-free string hashing so string ids
// ("qa-20260703-00042") can also act as seeds.
export function hashStringToSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Derive a per-conversation seed from the run seed + conversation index.
// Uses a splitmix-style scramble so neighboring indices don't produce
// correlated random streams (a bare `runSeed + index` would).
export function deriveSeed(runSeed: number, index: number): number {
  let z = (runSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export function conversationId(runSeed: number, index: number): string {
  return `qa-${runSeed}-${String(index).padStart(5, "0")}`;
}
