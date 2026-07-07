// QA phase 14A — realistic customer personality generation.
//
// A CustomerProfile decides HOW a customer types (language, typos, emoji,
// verbosity, short forms, voice-typing) and how they BEHAVE mid-order
// (asking questions between items, changing their mind, interrupting
// checkout). The conversation generator (qa/conversation-generator.ts)
// reads these traits to render each semantic scenario step into that
// customer's actual message text — the same scenario produces a completely
// different-looking conversation for a polite English first-timer vs an
// angry typo-heavy Roman Urdu regular.

import type { Rng } from "./randomizer";
import type { CorruptionStyle } from "./randomizer";

export type Language = "roman-urdu" | "english" | "hinglish" | "mixed";

export type Verbosity = "very-short" | "short" | "normal" | "long" | "very-long";

export interface CustomerProfile {
  personality: string;
  language: Language;
  // Message-shape traits.
  corruption: CorruptionStyle;
  corruptionRate: number; // chance a given turn is corrupted at all
  verbosity: Verbosity;
  politeness: "polite" | "neutral" | "rude";
  typingSpeed: "fast" | "slow";
  // Behavior traits.
  isReturning: boolean;
  asksQuestionsMidOrder: boolean;
  changesMind: boolean;
  interruptsCheckout: boolean;
  greets: boolean;
}

export interface PersonalityArchetype {
  name: string;
  build: (rng: Rng) => CustomerProfile;
}

const LANGUAGES: readonly Language[] = ["roman-urdu", "english", "hinglish", "mixed"];

function base(rng: Rng, overrides: Partial<CustomerProfile> & { personality: string }): CustomerProfile {
  return {
    language: rng.pick(LANGUAGES),
    corruption: "none",
    corruptionRate: 0,
    verbosity: "normal",
    politeness: "neutral",
    typingSpeed: "fast",
    isReturning: rng.chance(0.5),
    asksQuestionsMidOrder: false,
    changesMind: false,
    interruptsCheckout: false,
    greets: rng.chance(0.5),
    ...overrides,
  };
}

// Every personality the task calls for, each mapped to concrete traits.
export const PERSONALITY_ARCHETYPES: readonly PersonalityArchetype[] = [
  { name: "fast-typer", build: (rng) => base(rng, { personality: "fast-typer", typingSpeed: "fast", corruption: "typos", corruptionRate: 0.5, verbosity: "short" }) },
  { name: "slow-typer", build: (rng) => base(rng, { personality: "slow-typer", typingSpeed: "slow", verbosity: "normal", corruptionRate: 0 }) },
  { name: "roman-urdu", build: (rng) => base(rng, { personality: "roman-urdu", language: "roman-urdu" }) },
  { name: "english", build: (rng) => base(rng, { personality: "english", language: "english" }) },
  { name: "hinglish", build: (rng) => base(rng, { personality: "hinglish", language: "hinglish" }) },
  { name: "mixed-language", build: (rng) => base(rng, { personality: "mixed-language", language: "mixed" }) },
  { name: "old-customer", build: (rng) => base(rng, { personality: "old-customer", isReturning: true, greets: false, verbosity: "very-short" }) },
  { name: "first-time-customer", build: (rng) => base(rng, { personality: "first-time-customer", isReturning: false, greets: true, asksQuestionsMidOrder: true, verbosity: "long" }) },
  { name: "confused-customer", build: (rng) => base(rng, { personality: "confused-customer", asksQuestionsMidOrder: true, changesMind: true, verbosity: "long" }) },
  { name: "angry-customer", build: (rng) => base(rng, { personality: "angry-customer", politeness: "rude", verbosity: "short", corruption: "caps", corruptionRate: 0.4 }) },
  { name: "polite-customer", build: (rng) => base(rng, { personality: "polite-customer", politeness: "polite", greets: true, verbosity: "long" }) },
  { name: "emoji-heavy", build: (rng) => base(rng, { personality: "emoji-heavy", corruption: "emoji", corruptionRate: 0.9 }) },
  { name: "voice-typing", build: (rng) => base(rng, { personality: "voice-typing", corruption: "voice", corruptionRate: 0.9, verbosity: "long" }) },
  { name: "bad-spelling", build: (rng) => base(rng, { personality: "bad-spelling", corruption: "typos", corruptionRate: 0.8 }) },
  { name: "very-short-messages", build: (rng) => base(rng, { personality: "very-short-messages", verbosity: "very-short", greets: false, corruption: "shortforms", corruptionRate: 0.7 }) },
  { name: "very-long-messages", build: (rng) => base(rng, { personality: "very-long-messages", verbosity: "very-long", greets: true }) },
  { name: "mind-changer", build: (rng) => base(rng, { personality: "mind-changer", changesMind: true }) },
  { name: "checkout-interrupter", build: (rng) => base(rng, { personality: "checkout-interrupter", interruptsCheckout: true }) },
  { name: "question-asker", build: (rng) => base(rng, { personality: "question-asker", asksQuestionsMidOrder: true }) },
  { name: "spacing-mistakes", build: (rng) => base(rng, { personality: "spacing-mistakes", corruption: "spacing", corruptionRate: 0.7 }) },
  { name: "shortform-heavy", build: (rng) => base(rng, { personality: "shortform-heavy", corruption: "heavy", corruptionRate: 0.8, verbosity: "short" }) },
];

const ARCHETYPES_BY_NAME = new Map(PERSONALITY_ARCHETYPES.map((a) => [a.name, a]));

export function customerForArchetype(name: string, rng: Rng): CustomerProfile {
  const archetype = ARCHETYPES_BY_NAME.get(name);
  if (!archetype) throw new Error(`Unknown personality archetype: ${name}`);
  return archetype.build(rng);
}

// Force a specific language onto a profile — used by the simulation plan to
// meet exact per-language quotas regardless of which archetype was drawn.
export function withLanguage(profile: CustomerProfile, language: Language): CustomerProfile {
  return { ...profile, language };
}

export function generateCustomer(rng: Rng): CustomerProfile {
  return rng.pick(PERSONALITY_ARCHETYPES).build(rng);
}

// Realistic letters-only customer names (order-state-engine's
// extractCustomerName rejects digits/fillers — that's an intentional
// validation rule, so QA names must be plausible).
export const CUSTOMER_NAMES: readonly string[] = [
  "Ahmed", "Ali", "Bilal", "Usman", "Hamza", "Fatima", "Ayesha", "Zain",
  "Sara", "Hassan", "Maryam", "Omar", "Danish", "Kiran", "Imran", "Nida",
  "Taha", "Rabia", "Faisal", "Hira",
];

// Realistic Karachi-style addresses (must pass isValidAddressReply's
// substance check: 2+ words or 8+ chars).
export const CUSTOMER_ADDRESSES: readonly string[] = [
  "House 12 Street 5 Nazimabad",
  "Flat 3B Gulshan Block 13",
  "House 45 North Karachi Sector 11",
  "Plot 78 PECHS Block 6",
  "House 9 Street 2 Paposh Nagar",
  "Apartment 401 Clifton Block 8",
  "House 23 Buffer Zone Sector 15",
  "Shop 4 Hyderi Market North Nazimabad",
];
