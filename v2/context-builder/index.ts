// V2 phase 9 — context builder & conversation memory engine public API.
//
// The intelligence layer that gives the AI memory between messages. Never
// calls an LLM, never parses customer language, never mutates cart/order
// state — see context-builder.ts's header for the full pipeline this sits
// in. This barrel is what a future LLM-integration phase (and this
// session's tests) import from.

export {
  type ConversationMemory,
  type TopicUpdate,
  type RecordTurnInput,
  MAX_MEMORY_LIST_LENGTH,
  createInitialMemory,
  syncMemoryFromOrderContext,
  recordTurn,
  applyTopicUpdate,
  resetTopic,
} from "./memory";

export {
  type ConversationTurn,
  type BuildTurnInput,
  buildTurn,
  isGreetingOrThanksTurn,
  isLowSignalTurn,
  isCompletedCheckoutTurn,
} from "./conversation";

export { MAX_HISTORY_LENGTH, appendTurn, getRecentTurns, getTurnsByCategory, clearHistory } from "./history";

export { DEFAULT_RECENCY_WINDOW, type PruneOptions, pruneHistory } from "./pruning";

export {
  type MenuContextResult,
  type MenuContextOptions,
  buildRelevantMenu,
  isRestaurantInfoQuery,
} from "./menu-context";

export { buildContextSummary } from "./context-summary";

export {
  isValidConversationMemory,
  isValidConversationTurn,
  isValidMenuContextResult,
  isValidAIContext,
} from "./context-validator";

export {
  type MemorySession,
  createMemorySession,
  saveMemorySession,
  restoreMemorySession,
  resetMemorySession,
  cloneMemorySession,
} from "./session";

export {
  type AIContext,
  type UpdateMemoryAfterTurnInput,
  updateMemoryAfterTurn,
  buildAIContext,
} from "./context-builder";
