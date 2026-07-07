// Export helpers: JSON, CSV, and a joined human-readable debug report.
// Internal-only — nothing here is wired to an API route or the UI; these
// are plain functions a future admin/QA tool can call directly.

import type { MessageLogEntry } from "./events";
import { buildDebugReport } from "./debug";

export function exportAsJSON(entries: readonly MessageLogEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

const CSV_COLUMNS: (keyof MessageLogEntry)[] = [
  "sessionId",
  "conversationId",
  "timestamp",
  "rawMessage",
  "normalizedMessage",
  "detectedLanguage",
  "detectedIntent",
  "confidence",
  "safetyDecision",
  "clarificationTriggered",
  "previousState",
  "currentState",
  "nextState",
  "cartAction",
  "totalBefore",
  "totalAfter",
  "executionTimeMs",
  "reasoningSummary",
];

function escapeCsvValue(value: unknown): string {
  const str = Array.isArray(value) ? value.join("|") : String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportAsCSV(entries: readonly MessageLogEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((entry) => CSV_COLUMNS.map((col) => escapeCsvValue(entry[col])).join(","));
  return [header, ...rows].join("\n");
}

export function exportDebugReport(entries: readonly MessageLogEntry[]): string {
  return entries
    .map((entry, i) => `--- Message ${i + 1} ---\n${buildDebugReport(entry)}`)
    .join("\n\n");
}
