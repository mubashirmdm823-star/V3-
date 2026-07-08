// Production logging level control.
//
// LOG_LEVEL=debug|info|warn|error|silent (default: "info"). This is the
// ONLY place that reads LOG_LEVEL. Every production log call (ai-gateway,
// engine router, env validation) should go through `logger` here instead
// of calling console.* directly, so verbosity is controlled centrally and
// consistently — debug-only noise never reaches a production terminal
// unless explicitly opted into.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error", "silent"]);

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function getLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  return VALID_LEVELS.has(raw) ? (raw as LogLevel) : DEFAULT_LOG_LEVEL;
}

function shouldLog(level: Exclude<LogLevel, "silent">, env?: Record<string, string | undefined>): boolean {
  return LEVEL_RANK[getLogLevel(env)] >= LEVEL_RANK[level];
}

// Every method is a no-op below its configured level — callers never need
// their own `if (debug)` guards. Never pass secrets/API keys to these;
// nothing here redacts arguments (ai-gateway/diagnostics.ts already does
// that at the call site for provider errors).
export const logger = {
  debug(...args: unknown[]): void {
    if (shouldLog("debug")) console.log(...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog("info")) console.log(...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog("warn")) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (shouldLog("error")) console.error(...args);
  },
};
