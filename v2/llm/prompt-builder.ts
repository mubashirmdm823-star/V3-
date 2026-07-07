// V2 phase 10 — dynamic prompt assembly.
//
// Builds a fresh, minimal prompt per message — never one giant static
// prompt. Section order matches this phase's required pipeline exactly:
// System Rules -> Restaurant Rules -> Current Conversation Summary ->
// Current Cart -> Current State -> Pending Clarification -> Relevant Menu
// Only -> Customer Message. Every dynamic section comes from
// context-injector.ts, which already excludes full history/full menu —
// this file only renders what it's given, it never widens the injection.

import type { AIContext } from "../context-builder";
import type { LLMCompletionRequest } from "./types";
import { buildSystemPrompt } from "./system-prompt";
import {
  buildContextInjection,
  renderCartAsText,
  renderMenuAsText,
  renderPendingClarificationAsText,
  renderRestaurantConfigAsText,
} from "./context-injector";

export function buildPrompt(aiContext: AIContext): LLMCompletionRequest {
  const injection = buildContextInjection(aiContext);

  const sections = [
    `Restaurant Rules:\n${renderRestaurantConfigAsText(injection.restaurantConfig)}`,
    `Current Conversation Summary:\n${injection.conversationSummary}`,
    `Current Cart:\n${renderCartAsText(injection.currentCart)}`,
    `Current State:\n${injection.currentState}`,
    `Pending Clarification:\n${renderPendingClarificationAsText(injection.pendingClarification)}`,
    `Relevant Menu:\n${renderMenuAsText(injection.relevantMenu)}`,
    `Customer Message:\n${aiContext.customerMessage}`,
  ];

  return {
    systemPrompt: buildSystemPrompt(),
    userPrompt: sections.join("\n\n"),
  };
}

export function estimatePromptLength(request: LLMCompletionRequest): number {
  return request.systemPrompt.length + request.userPrompt.length;
}
