// Timing utilities and aggregate performance stats. Purely observational —
// wraps calls to measure elapsed time, never changes what's returned.
//
// Architectural note: in the current pipeline, safety evaluation happens
// INSIDE parseMessage() and cart execution happens INSIDE processMessage()
// (see v2/intent-parser/parser.ts and v2/order-state-engine/index.ts) —
// they aren't separately callable from outside without re-running work or
// modifying already-shipped modules. So `parserMs` honestly includes safety
// time, and `stateMs` honestly includes cart-engine time, in the standard
// instrumented pipeline (see v2/logger/index.ts#processMessageWithLogging).
// `safetyMs`/`cartMs` are 0 there and are only meaningfully populated if a
// caller times `evaluateSafety`/cart-engine calls directly with `time()`.

export interface PerformanceMetrics {
  parserMs: number;
  safetyMs: number;
  cartMs: number;
  stateMs: number;
  responseMs: number;
  totalMs: number;
}

export function now(): number {
  return performance.now();
}

export function elapsed(start: number): number {
  return performance.now() - start;
}

// Generic single-call timer — times ANY synchronous function.
export function time<T>(fn: () => T): { result: T; ms: number } {
  const start = now();
  const result = fn();
  return { result, ms: elapsed(start) };
}

export interface PerformanceStats {
  count: number;
  average: number;
  max: number;
  min: number;
}

const EMPTY_STATS: PerformanceStats = { count: 0, average: 0, max: 0, min: 0 };

// Aggregate stats over many recorded totalMs samples — "average/max/min
// response time" across a session or the whole log.
export function computePerformanceStats(samples: number[]): PerformanceStats {
  if (samples.length === 0) return { ...EMPTY_STATS };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    average: sum / samples.length,
    max: Math.max(...samples),
    min: Math.min(...samples),
  };
}
