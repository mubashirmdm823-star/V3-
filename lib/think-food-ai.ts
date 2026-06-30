// Pure Think Food WhatsApp-AI ordering logic.
// Extracted from components/whatsapp/WhatsAppSimulator.tsx so it can be
// unit-tested headlessly (no React/DOM) by tests/think-food-ai/run-tests.ts.
// The UI component imports everything it needs from this module — behaviour
// is unchanged, only the code's location moved.

export const MENU = {
  burgers: {
    title: "Burgers",
    items: [
      { name: "Zinger Burger", price: 500 },
      { name: "Zinger Burger W/C", price: 550 },
      { name: "Jumbo Zinger", price: 750 },
      { name: "Think Food SP Burger", price: 550 },
      { name: "Smoke Burger", price: 550 },
      { name: "Spicy Stuff Burger", price: 700 },
    ],
  },
  sandwiches: {
    title: "Sandwiches",
    items: [
      { name: "Chicken Sandwich", price: 550 },
      { name: "Club Sandwich", price: 500 },
      { name: "BBQ Sandwich", price: 550 },
      { name: "Smoke Sandwich", price: 550 },
      { name: "Vegi Sandwich", price: 500 },
      { name: "Mexican Sandwich", price: 600 },
      { name: "Crispy Sandwich", price: 600 },
      { name: "Think Food Special Sandwich", price: 550 },
      { name: "Grill Sandwich", price: 650 },
    ],
  },
  pizza: {
    title: "Pizza",
    items: [
      { name: "Pizza Large 12 inch", price: 1200 },
      { name: "Pizza Regular 9 inch", price: 850 },
      { name: "Pizza Small 6 inch", price: 550 },
      { name: "Think Food Special Pizza", price: 1500 },
      { name: "Mexican Pizza", price: 1600 },
    ],
  },
  pizzaFries: {
    title: "Pizza Fries",
    items: [
      { name: "Pizza Fries Small Box", price: 500 },
      { name: "Pizza Fries Large Box", price: 600 },
    ],
  },
  rolls: {
    title: "Roll",
    items: [
      { name: "Wrap", price: 550 },
      { name: "Gyro", price: 550 },
    ],
  },
  pasta: {
    title: "Pasta",
    items: [
      { name: "Pasta Small", price: 500 },
      { name: "Pasta Large", price: 600 },
      { name: "Alfredo Pasta white sauce", price: 850 },
      { name: "Macaroni Pasta red sauce", price: 750 },
      { name: "Mexican Pasta white sauce", price: 850 },
    ],
  },
  noodles: {
    title: "Noodles",
    items: [
      { name: "Chicken Chowmein", price: 650 },
      { name: "Vegetable Chowmein", price: 600 },
    ],
  },
  rice: {
    title: "Rice",
    items: [
      { name: "Chicken Fried Rice", price: 450 },
      { name: "Vegetable Rice", price: 400 },
      { name: "Egg Rice", price: 450 },
      { name: "Singaporean Rice", price: 700 },
      { name: "White Singaporean", price: 750 },
    ],
  },
  starters: {
    title: "Starter",
    items: [
      { name: "Chicken Strips 6 pcs with fries", price: 750 },
      { name: "Hot Shot 8 pcs with fries", price: 800 },
    ],
  },
  steaks: {
    title: "Steaks",
    items: [{ name: "Chicken Steak", price: 950 }],
  },
  toppings: {
    title: "Extra Cheese & Chicken Topping",
    items: [
      { name: "Pizza Large Cheese Topping", price: 250 },
      { name: "Pizza Medium Cheese Topping", price: 200 },
      { name: "Pizza Small Cheese Topping", price: 150 },
      { name: "Extra Chicken Large", price: 200 },
      { name: "Extra Chicken Medium", price: 200 },
      { name: "Extra Chicken Small", price: 150 },
      { name: "Olive Mushroom Jalapeno", price: 150 },
    ],
  },
};

export type MenuKey = keyof typeof MENU;

export const INFO = {
  address: "Nazimabad No. 5, Paposh Nagar (Near Sarafa Bazar)",
  mapsUrl: "https://www.google.com/maps/place/Think+Foods+for/@24.9218431,67.0224398,17z/data=!4m6!3m5!1s0x3eb33f93f39564c7:0x8e0b673bb483c53e!8m2!3d24.9219961!4d67.0223894!16s%2Fg%2F11mg4bfmtm?entry=ttu&g_ep=EgoyMDI2MDYyMy4wIKXMDSoASAFQAw%3D%3D",
  timing: "6 PM to 3 AM",
  phone: "0312-2175855",
  deliveryFee: 150,
  deliveryTime: "35 to 45 minutes",
};

// ─── Menu vocabulary & strict-match constants ────────────────────────────────

// All words that appear in at least one menu item name (used to detect off-menu words)
export const ALL_MENU_WORDS = (() => {
  const s = new Set<string>();
  for (const cat of Object.values(MENU))
    for (const item of cat.items)
      for (const w of item.name.toLowerCase().split(/\s+/))
        if (w.length > 2) s.add(w);
  return s;
})();

// Words stripped when pulling food keywords from an order message.
// Includes Roman Urdu conversation fillers so they never pollute menu matching.
export const ORDER_STOP = new Set([
  // English order/filler words
  "chahiye","want","order","give","take","pack","lena","add","get","please","kindly",
  "mujhe","aur","and","bhi","ek","aik","ikh","dono","de","dena","dijiye","lagao","milna",
  "ka","ki","ke","hai","hain","mein","se","ko","the","a","an","i","me","my","with",
  "one","two","three","four","five","six","do","teen","chaar","paanch","main","hum","tum",
  // Roman Urdu conversation fillers — asking/requesting/confirming
  "batao","batana","batado","batayein","btao",
  "chaiye","chahta","chahti","hun","chahye","chahiy",
  "khana","peena",
  "karo","karein","karden","karna","karwana","kar","kara","karwa",
  "laga","bhej","daal","dal",
  "sirf","bas",
  "theek","thik","acha","achha","okay","yup","sahi","done","confirm",
  "haan","yar","bhai",
  "mere","liye","zara","mera","meri","taraf",
  "wala","wali",
  "mazeed","abhi","phir","jab",
  "agar","agr",
  "koi","kuch",
  "please","plz",
  // Ordering intent variants
  "mangwana","mangwane","mangwani","mangwa","mangwalo",
  // Info / inquiry words
  "dikhao","milega","rate","show","options","available","pooch",
  // Negative / pause words
  "nahi","ruk","ruko","jao","sochta","sochti","rehne","filhal","wait",
  // Quantity modification words (not food items)
  "dobara","barha","increase","quantity","kam",
  // Remove action words
  "nikal","hata","hatao",
  // Replacement / correction words
  "jagah","replace","change",
  // Checkout / progress words
  "aage","final","proceed","continue","checkout",
  // Price / total inquiry words
  "bill","estimate","kitna","total",
  // Polite fillers
  "thora","thori",
  // Multi-item separator words (also in split regex)
  "plus","sath","saath",
  // English contraction remnants ("I'll have" → "ill","have" after punctuation strip)
  "have","having","ill","im","would","could","can","gonna","wanna",
  // Polite/speed fillers real customers append after naming an item
  "dein","jaldi","jald","turant","fauran","fast",
  // Discourse fillers / pronoun references that aren't food words
  "waise","iski","uski","isi","sab","milake",
  // English politeness fillers ("thank you so much", "could you please").
  // NOTE: "you" is deliberately NOT included — stopping it lets "do you have
  // X" resolve as a real order (with "do" then misread as quantity 2 by
  // parseQty), silently adding 2x whatever X is to a simple availability
  // question. "your"/"thanks" etc carry no such risk.
  "thank","thanks","your","much","hello","hi",
]);

// Single keyword → exact menu item (only for truly unambiguous single-word identifiers)
// NOTE: "zinger" is deliberately NOT here. With "Zinger Burger", "Zinger
// Burger W/C", and "Jumbo Zinger" all on the menu, bare "zinger" is genuinely
// ambiguous — it must ask which one (see the family-ambiguity check in
// strictMatchSegment), not silently default to the plain burger.
export const SINGLE_DEFAULTS: Record<string, string> = {
  jumbo:    "Jumbo Zinger",
  steak:    "Chicken Steak",
  gyro:     "Gyro",
  wrap:     "Wrap",
  strips:   "Chicken Strips 6 pcs with fries",
  macaroni: "Macaroni Pasta red sauce",
  alfredo:  "Alfredo Pasta white sauce",
};

// Category words: show all options and ask which one — never auto-add
export const CATEGORY_ONLY = new Set([
  "rice","chawal","burger","noodles","sandwich","sandwiches",
  "pizza","roll","rolls","starter","starters",
  "pasta","chowmein","fries",
]);

// ─── Types ────────────────────────────────────────────────────────────────────


export type Phase =
  | "browsing"
  | "item_selected"
  | "checkout_review"
  | "checkout_type"
  | "checkout_address"
  | "checkout_name"
  | "checkout_summary"
  | "done";

export interface CartItem {
  name: string;
  price: number;
  qty: number;
}

export interface PendingClarification {
  category: string;  // "pasta", "burger", "chowmein", etc.
  qty: number;       // quantity the customer originally requested
  // When set, the clarification is scoped to just THIS subset of items
  // ("zinger" → Zinger Burger / Zinger Burger W/C / Jumbo Zinger) rather than
  // the entire category (which would also include Smoke Burger, Think Food SP
  // Burger, etc — items the customer never hinted at). `category` above still
  // holds the broader category (for lastCategory bookkeeping); `familyLabel`
  // holds the short customer-facing label ("Zinger") to redisplay if this
  // clarification is still pending after a partial reply.
  familyItems?: { name: string; price: number }[];
  familyLabel?: string;
}

export interface Draft {
  cart: CartItem[];
  type?: "delivery" | "pickup";
  address?: string;
  name?: string;
  lastItem?: string;
  pendingClarifications?: PendingClarification[];
  lastCategory?: string;
  pendingAdd?: { name: string; price: number; qty: number };
}

export type CartAction =
  | { op: "add"; item: CartItem }
  | { op: "remove"; name: string }
  | { op: "reduce"; name: string; by: number }
  | { op: "update_qty"; name: string; qty: number }
  | { op: "clear" };

export interface AIOut {
  content: string;
  nextPhase?: Phase;
  draftPatch?: Partial<Omit<Draft, "cart">>;
  cartAction?: CartAction;
  cartActions?: CartAction[];
  confirmed?: true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fmt(key: MenuKey) {
  const { title, items } = MENU[key];
  return `*${title}*\n${items.map((i) => `• ${i.name} — PKR ${i.price}`).join("\n")}`;
}




export const URDU_NUMS: Record<string, number> = {
  ek: 1, aik: 1, ikh: 1, one: 1,
  do: 2, two: 2, dono: 2,
  teen: 3, three: 3, tin: 3,
  chaar: 4, char: 4, four: 4,
  paanch: 5, panch: 5, five: 5,
  chhe: 6, chay: 6, six: 6,
};

// Number words that are also safe to use as a generic "carries order intent" signal.
// "do" is excluded — it collides too often with the English auxiliary verb "do"
// ("do you have...", "what time do you close"), so it's kept for parseQty's own
// numeral parsing below but not used to decide whether a message is an order at all.
export const ORDER_SIGNAL_NUM_WORDS = Object.keys(URDU_NUMS).filter((w) => w !== "do");

// A digit that's part of a size/count DESCRIPTION ("12 inch", "6 pcs", "8 pc")
// is not a customer-stated quantity. Several menu items embed such numbers in
// their own name (Pizza "12 inch", Hot Shot "8 pcs with fries"), so any digit
// extraction — quantity parsing, order-signal detection, or quantity updates —
// must exclude them consistently, or a pure price question like "pizza large 12
// inch kitna hai" silently gets treated as an order, or a quantity update on
// such an item picks up its own size number instead of the customer's new qty.
const QTY_DIGIT = /\b([1-9]\d*)\b(?!\s*(?:inch(?:es)?|pcs?|cm|mm|in\b))/;

export function firstRealQtyDigit(text: string): number | null {
  const m = text.match(QTY_DIGIT);
  return m ? parseInt(m[1]) : null;
}

export function hasRealQtyDigit(text: string): boolean {
  return QTY_DIGIT.test(text);
}

export function realQtyDigits(text: string): number[] {
  const re = new RegExp(QTY_DIGIT.source, "g");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(parseInt(m[1]));
  return out;
}

// Shared quantity-word source ("ek", "do", "teen", ...) used everywhere a
// message gets scanned for quantity-word boundaries (parseQty, sub-splitting
// "ek zinger ek pasta", trimming leading noise before the last quantity word).
// Same digit pattern as QTY_DIGIT (excludes size/count descriptors like
// "12 inch"/"8 pcs") so a digit embedded in an ITEM's own name never gets
// mistaken for a second customer-stated quantity — e.g. "2 hot shot 8 pcs
// with fries" must split at "2" only, not also at the "8" that's part of
// "Hot Shot 8 pcs with fries"'s own name. (Written out directly rather than
// derived from QTY_DIGIT.source so it stays a single non-capturing
// alternative — embedding QTY_DIGIT's own capture group here would shift
// findQtyWordHits' m[1] index.)
const QTY_WORD_SOURCE =
  "ek|aik|ikh|one|do|two|dono|teen|three|tin|chaar|char|four|paanch|panch|five|chhe|chay|six|" +
  "[1-9]\\d*(?!\\s*(?:inch(?:es)?|pcs?|cm|mm|in\\b))";

// "do" in "kar do / de do / dila do / bana do / hata do / mangwa do" is the
// Roman-Urdu verb "do" (an imperative ending), not the numeral 2. Every
// quantity-word scanner below needs this masked first, or it mistakes the
// verb's "do" for a trailing quantity marker — e.g. "ek smoke burger de do"
// would otherwise look like its LAST quantity word is "do", not "ek", and a
// naive trim would throw away "smoke burger" entirely.
function maskVerbDo(text: string): string {
  return text.replace(/\b(kar|kr|de|dila|bana|hata|laga|bhej|mangwa)\s+do\b/gi, "$1 ___");
}

export function parseQty(text: string): number {
  // Skip numbers that are part of size descriptions ("12 inch", "6 pcs", "8 pc")
  const digit = text.match(QTY_DIGIT);
  if (digit) return parseInt(digit[1]);
  // Mask only verb-attached "do" occurrences so an earlier, standalone "do"
  // elsewhere in the same message (e.g. "do zinger burger de do" = 2 zinger
  // burgers) still counts.
  const numScanText = maskVerbDo(text);
  for (const [word, num] of Object.entries(URDU_NUMS)) {
    if (new RegExp(`\\b${word}\\b`).test(numScanText)) return num;
  }
  return 1;
}

// Finds the position of every quantity word in `text` (used by both
// subSplitAtQtyBoundaries and trimToLastQtyBoundary). Skips a "do" that's part
// of a verb phrase ("kar do", "de do", ...) — it's an imperative ending, not
// the numeral 2 — by checking what immediately precedes each "do" match,
// rather than textually masking it first (which would shift every index after
// it and corrupt the position-based slicing both callers rely on).
function findQtyWordHits(text: string): number[] {
  const qtyPat = new RegExp(`\\b(${QTY_WORD_SOURCE})\\b`, "gi");
  const verbStemAtEnd = /\b(?:kar|kr|de|dila|bana|hata|laga|bhej|mangwa)\s*$/i;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = qtyPat.exec(text)) !== null) {
    if (m[1].toLowerCase() === "do" && verbStemAtEnd.test(text.slice(0, m.index))) continue;
    hits.push(m.index);
  }
  return hits;
}

// Splits "ek zinger ek pasta" → ["ek zinger", "ek pasta"] by finding a second
// quantity word inside the segment, which signals a new item request.
// Only splits when 2+ quantity words are present; single-qty segments are returned as-is.
export function subSplitAtQtyBoundaries(seg: string): string[] {
  const hits = findQtyWordHits(seg);
  if (hits.length < 2) return [seg];
  const parts: string[] = [];
  let prev = 0;
  for (const pos of hits.slice(1)) {
    let end = pos;
    while (end > prev && seg[end - 1] === " ") end--;
    parts.push(seg.slice(prev, end).trim());
    prev = pos;
  }
  parts.push(seg.slice(prev).trim());
  return parts.filter(Boolean);
}

export function cartSummary(cart: CartItem[]): string {
  if (cart.length === 0) return "Aapka cart khali hai.";
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const lines = cart.map((i) => `${i.qty} x ${i.name} — PKR ${i.price * i.qty}`).join("\n");
  return `*Current Order:*\n${lines}\n\n*Total: PKR ${total}*`;
}

export function reviewSummary(cart: CartItem[]): string {
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const lines = cart.map((i) => `  ${i.qty} x ${i.name} — PKR ${i.price * i.qty}`).join("\n");
  return `📋 *Order Review:*\n\n${lines}\n\n*Total: PKR ${total}*\n\nAgar aap apne order mein koi item add, remove ya change karna chahte hain to abhi bata dein.\n\nAgar sab kuch theek hai to sirf *Confirm Order* likh dein.\nUske baad order mein koi changes nahi kiye ja sakenge.`;
}

export function findMenuItem(text: string, minScore = 1): { name: string; price: number } | null {
  const t = text.toLowerCase();

  // Category-locked search: when a known category word is present, only search that category.
  // This prevents "chicken noodles" from matching "Chicken Sandwich", etc.
  const tWords = t.split(/\s+/).map((w) => w.replace(/[^a-z]/g, ""));
  const catWord = tWords.find((w) => w.length > 2 && CATEGORY_ONLY.has(w));
  if (catWord) {
    const catKey = getCategoryKey(catWord);
    if (catKey) {
      let best: { name: string; price: number } | null = null;
      let bestScore = 0;
      for (const item of MENU[catKey].items) {
        const words = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const score = words.filter((w) => t.includes(w)).length;
        if (score > bestScore) { bestScore = score; best = item; }
      }
      return bestScore >= minScore ? best : null;
    }
  }

  let best: { name: string; price: number } | null = null;
  let bestScore = 0;
  for (const cat of Object.values(MENU)) {
    for (const item of cat.items) {
      const words = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const score = words.filter((w) => t.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
  }
  return bestScore >= minScore ? best : null;
}

export function findInCart(cart: CartItem[], text: string): CartItem | null {
  const t = text.toLowerCase();
  for (const item of cart) {
    const words = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.some((w) => t.includes(w))) return item;
  }
  return null;
}

// Category-aware cart item finder for remove operations.
// Prefers category-locked search so "fries hata do" finds Pizza Fries, not Hot Shot (which contains "fries").
export function findCartItemForRemoval(cart: CartItem[], text: string): CartItem | null {
  const tWords = text.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length > 2);
  const tWordSet = new Set(tWords);

  // Score every cart item by how many of its OWN significant words appear in
  // the message, and prefer the highest score — "zinger burger hata do" must
  // resolve to "Zinger Burger" (2 matching words) even when the cart ALSO has
  // "Spicy Stuff Burger" (which only shares the generic word "burger", score
  // 1). A plain category-only grab (just "first item in that category") used
  // to win here regardless of which specific item was actually named, picking
  // the wrong one whenever the cart held 2+ items from the same category.
  let best: CartItem | null = null;
  let bestScore = 0;
  for (const item of cart) {
    const itemWords = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const score = itemWords.filter((w) => tWordSet.has(w)).length;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  if (best) return best;

  // No direct word overlap — fall back to a bare category mention
  // ("burger hata do" with exactly one burger-category item in the cart).
  const catWord = tWords.find((w) => CATEGORY_ONLY.has(w));
  if (catWord) {
    const catKey = getCategoryKey(catWord);
    if (catKey) {
      const catItemNames = new Set(MENU[catKey].items.map((i) => i.name));
      const found = cart.find((i) => catItemNames.has(i.name));
      if (found) return found;
    }
  }

  // Unambiguous single-keyword defaults
  for (const [kw, name] of Object.entries(SINGLE_DEFAULTS)) {
    if (new RegExp(`\\b${kw}\\b`).test(text.toLowerCase())) {
      const found = cart.find((i) => i.name === name);
      if (found) return found;
    }
  }

  return null;
}

// Returns a capitalised label string when the message contains a named food target
// (a word that appears in menu data, categories, or single-keyword defaults).
// Returns null when the message is "vague" (no identifiable item/category named).
// Used to gate whether cart-mutation fallbacks (lastItem, single-item-cart) are allowed.
export function namedTargetLabel(text: string): string | null {
  const kws = getFoodKeywords(text);
  const foodKws = kws.filter(
    (w) => ALL_MENU_WORDS.has(w) || CATEGORY_ONLY.has(w) || w in SINGLE_DEFAULTS
  );
  if (foodKws.length === 0) return null;
  return foodKws
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Returns true when a remove message carries a quantity (reduce by N, not remove all)
export function hasReduceQty(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b[1-9]\d*\b/.test(t)) return true;
  for (const w of ["ek", "aik", "ikh", "teen", "tin", "chaar", "char", "paanch", "panch", "chhe", "chay"]) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return true;
  }
  return false;
}

export interface ExtractedItem { item: { name: string; price: number }; qty: number; }

// Splits a message by commas / "aur" / "and" and extracts every menu item mentioned
export function extractItems(text: string): ExtractedItem[] {
  const segments = text.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  const results: ExtractedItem[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const item = findMenuItem(seg, 1);
    if (item && !seen.has(item.name)) {
      seen.add(item.name);
      results.push({ item, qty: parseQty(seg) });
    }
  }
  return results;
}

// Variant keywords ordered longest-first so "white sauce" is matched before "white"
export const VARIANT_KWS = [
  "white sauce", "red sauce", "with cheese",
  "12 inch", "9 inch", "6 inch",
  "jumbo", "large", "medium", "regular", "small",
  "vegetable", "chicken", "veg", "egg",   // flavor words for "X nahi Y" corrections
];

// Maps clarification category names to MENU keys
export function getCategoryKey(category: string): keyof typeof MENU | null {
  const map: Record<string, keyof typeof MENU> = {
    burger: "burgers", pizza: "pizza", pasta: "pasta",
    chowmein: "noodles", noodles: "noodles", rice: "rice", chawal: "rice",
    sandwich: "sandwiches", sandwiches: "sandwiches",
    roll: "rolls", rolls: "rolls",
    starter: "starters", starters: "starters",
    fries: "pizzaFries",
  };
  return map[category] ?? null;
}

// Search within a specific category for the item best matching the customer's text
// Lenient "which of these items does this text most resemble" scorer, used
// for resolving clarification replies. Takes the candidate item LIST directly
// so it can be scoped to either a whole category (findItemForCategory) or a
// narrower item family (findItemAmongFamily) without duplicating the scoring
// logic.
function findItemAmongList(
  text: string,
  items: { name: string; price: number }[]
): { name: string; price: number } | null {
  const t = text.toLowerCase();
  let best: { name: string; price: number } | null = null;
  let bestScore = 0;
  for (const item of items) {
    const words = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const score = words.filter((w) => t.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 1 ? best : null;
}

export function findItemForCategory(text: string, category: string): { name: string; price: number } | null {
  const key = getCategoryKey(category);
  if (!key) return null;
  return findItemAmongList(text, MENU[key].items);
}

// Same as findItemForCategory, but scoped to a narrower item FAMILY (e.g. just
// the 3 zinger items) instead of the whole category — used when resolving a
// reply to a family-ambiguity clarification ("which zinger?"), so an
// unrelated same-category item ("smoke burger") can't be silently accepted as
// if it answered the zinger question.
export function findItemAmongFamily(
  text: string,
  family: { name: string; price: number }[]
): { name: string; price: number } | null {
  return findItemAmongList(text, family);
}

// Resolves a multi-variant BREAKDOWN reply to a category clarification —
// "2 small 2 large 1 alfredo" answering "which pasta?" — into distinct
// (item, qty) pairs, each carrying its OWN stated quantity. Without this, the
// clarification resolver used to find just ONE variant (via a crude, often-tied
// lenient scorer) and dump the entire ORIGINAL total ("5 pasta") onto it,
// producing "5 x Pasta Small" instead of the customer's actual 2+2+1 split.
// Returns null when the reply doesn't actually contain a breakdown (fewer than
// 2 chunks resolve) — callers should fall back to the single-variant,
// original-total-quantity behavior in that case.
function resolveBreakdownAmongList(
  text: string,
  items: { name: string; price: number }[]
): Array<{ item: { name: string; price: number }; qty: number }> | null {
  const segments = text.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const seg of segments) {
    const sub = subSplitAtQtyBoundaries(seg);
    if (sub.length > 1) chunks.push(...sub);
    else chunks.push(seg);
  }

  const order: string[] = [];
  const resolved = new Map<string, { item: { name: string; price: number }; qty: number }>();
  let resolvedChunkCount = 0;
  for (const chunk of chunks) {
    const item = findItemAmongList(chunk, items);
    if (!item) continue;
    resolvedChunkCount++;
    const qty = parseQty(chunk);
    const existing = resolved.get(item.name);
    if (existing) {
      existing.qty += qty;
    } else {
      resolved.set(item.name, { item, qty });
      order.push(item.name);
    }
  }

  if (resolvedChunkCount < 2) return null;
  return order.map((name) => resolved.get(name)!);
}

export function resolveCategoryBreakdown(
  text: string,
  category: string
): Array<{ item: { name: string; price: number }; qty: number }> | null {
  const key = getCategoryKey(category);
  if (!key) return null;
  return resolveBreakdownAmongList(text, MENU[key].items);
}

// Same as resolveCategoryBreakdown, but scoped to a narrower item FAMILY —
// used for a breakdown reply to a family-ambiguity clarification ("which
// zinger?"). Most family breakdown replies already name fully-specific items
// that resolve correctly even unscoped, but scoping keeps it consistent with
// findItemAmongFamily and rules out an unrelated same-category item being
// swept into the family's clarification by mistake.
export function resolveFamilyBreakdown(
  text: string,
  family: { name: string; price: number }[]
): Array<{ item: { name: string; price: number }; qty: number }> | null {
  return resolveBreakdownAmongList(text, family);
}

// Returns the category label ("burger", "pizza", etc.) for a given menu item name
export function getItemCategory(itemName: string): string | null {
  const lower = itemName.toLowerCase();
  const reverseMap: Record<string, string> = {
    burgers: "burger", pizza: "pizza", pasta: "pasta",
    noodles: "chowmein", rice: "rice", sandwiches: "sandwich",
    rolls: "roll", starters: "starter", steaks: "steak",
    pizzaFries: "fries",
  };
  for (const [key, section] of Object.entries(MENU) as [string, { items: { name: string; price: number }[] }][]) {
    if (section.items.some((i) => i.name.toLowerCase() === lower)) return reverseMap[key] ?? null;
  }
  return null;
}

// Extracts a PKR amount from price-selection phrases like "500 wala", "PKR 600", "700 ka"
// Returns null when no qualifying price pattern is found
export function extractPriceRequest(text: string): number | null {
  const m = text.match(/\bpkr\s*(\d{3,4})\b/i)
         ?? text.match(/\brs\.?\s*(\d{3,4})\b/i)
         ?? text.match(/\b(\d{3,4})\s+(?:wala|wali|ka\b|ki\b|da\b)/i);
  if (!m) return null;
  const price = parseInt(m[1]);
  return price >= 300 && price <= 2000 ? price : null;
}

// Words excluded when computing the "base identity" of an item for cross-variant matching
export const VARIANT_EXCLUDE = new Set([
  "small","large","medium","regular","jumbo","with",
  "white","red","sauce","inch","cheese","w/c",
]);

export function isVariantSwapMessage(text: string): boolean {
  const t = text.toLowerCase();
  if (/(nahi chahiye|mat chahiye)/.test(t)) return false;
  // "X nahi Y" where something meaningful follows nahi
  if (/\bnahi\s+\w/.test(t)) {
    const after = t.match(/\bnahi\s+(\S+)/)?.[1] ?? "";
    if (VARIANT_KWS.some((k) => after.startsWith(k.split(" ")[0])) || /pickup|delivery/.test(after)) return true;
  }
  // "large kar do", "jumbo karo" etc.
  if (/\b(large|small|regular|medium|jumbo)\s*(kar do|karo|kar dena|kar)\b/.test(t)) return true;
  // sauce-type swap: "white sauce" / "red sauce"
  if (/\b(white sauce|red sauce)\b/.test(t)) return true;
  return false;
}

export function findVariantSwap(
  text: string,
  lastItemName: string | undefined,
  cart: CartItem[]
): { fromName: string; qty: number; to: { name: string; price: number } } | null {
  if (!lastItemName) return null;
  const t = text.toLowerCase();

  let targetKw: string | null = null;
  for (const kw of VARIANT_KWS) {
    if (t.includes(kw)) { targetKw = kw; break; }
  }
  if (!targetKw) return null;

  let lastCatKey: string | null = null;
  for (const [key, cat] of Object.entries(MENU)) {
    if (cat.items.some((i) => i.name === lastItemName)) { lastCatKey = key; break; }
  }
  if (!lastCatKey) return null;

  const catItems = MENU[lastCatKey as keyof typeof MENU].items;

  // Identity words of the last item (strip size/variant words)
  const baseWords = lastItemName.toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !VARIANT_EXCLUDE.has(w));

  let best: { name: string; price: number } | null = null;
  let bestScore = -1;
  for (const item of catItems) {
    if (item.name === lastItemName) continue;
    const n = item.name.toLowerCase();
    if (!n.includes(targetKw)) continue;
    // Two signals, combined: how much the candidate resembles the OLD item
    // (baseScore — a reasonable fallback when the customer named nothing
    // specific, e.g. "red sauce nahi white sauce kar do"), and — decisively,
    // when present — how many of the candidate's OWN distinguishing words the
    // customer actually said (mentionScore). Without mentionScore dominating,
    // "mexican pasta white sauce kar do" with Macaroni Pasta in the cart ties
    // Alfredo and Mexican Pasta (both merely share "pasta" with Macaroni) and
    // picks whichever is listed first — wrong even though the customer
    // explicitly said "mexican".
    const baseScore = baseWords.filter((w) => n.includes(w)).length;
    const ownWords = n.split(/\s+/).filter((w) => w.length > 2 && !VARIANT_EXCLUDE.has(w) && !baseWords.includes(w));
    const mentionScore = ownWords.filter((w) => t.includes(w)).length;
    const score = mentionScore * 10 + baseScore;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  if (!best) return null;

  // Guard against false swaps: "5 alfredo pasta white sauce kar do" (a quantity
  // update on the EXISTING Alfredo Pasta) shares "pasta" + "white sauce" with
  // "Mexican Pasta white sauce" and would otherwise look like a valid swap target
  // even though the customer never said "mexican" — they just restated their OWN
  // item's full name while asking to change its quantity. Only reject the swap
  // when the message (a) fully restates the CURRENT item's own identity words
  // AND (b) never names anything distinguishing the candidate from it — i.e. the
  // customer is clearly still talking about their existing item, not a new one.
  // A genuine ambiguous swap ("red sauce nahi white sauce kar do", no item named
  // at all) is untouched, since (a) won't hold there.
  const oldNameRestated = baseWords.length > 0 && baseWords.every((w) => t.includes(w));
  const candidateOwnWords = best.name.toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !VARIANT_EXCLUDE.has(w) && !baseWords.includes(w));
  const candidateNamed = candidateOwnWords.length === 0 || candidateOwnWords.some((w) => t.includes(w));
  if (oldNameRestated && !candidateNamed) return null;

  const qty = cart.find((i) => i.name === lastItemName)?.qty ?? 1;
  return { fromName: lastItemName, qty, to: best };
}

// Detects when customer wants to REPLACE the current category item with a different one
// ("Smoke Burger kar do", "Chicken chowmein kar do", "Alfredo kar do")
// Returns { from: CartItem, to: MenuItem } — caller does remove + add atomically
export function findCategoryReplacement(
  text: string,
  lastItemName: string | undefined,
  lastCategory: string | undefined,
  cart: CartItem[]
): { from: CartItem; to: { name: string; price: number } } | null {
  if (!/\b(kar do|karo|kar dena|change kar|badal do|replace kar|banana hai|rakhna hai)\b/.test(text)) return null;
  // "bhi" (also/too) is an explicit ADDITIVE signal — "is mein ek smoke burger
  // bhi add krdo" means add a smoke burger ALONGSIDE the zinger burger already
  // in the cart, not replace it. Without this guard, any "kar do" message
  // naming a same-category item would silently swap instead of add.
  if (/\bbhi\b/.test(text)) return null;

  // Determine active category from context (lastItem → lastCategory → single-item cart)
  const activeCat =
    (lastItemName ? getItemCategory(lastItemName) : null) ??
    lastCategory ??
    (cart.length === 1 ? getItemCategory(cart[0].name) : null);

  // "zinger nahi smoke burger kar do" — the OLD item's name ("zinger") is still
  // present in the message and would otherwise tie with the NEW item's score
  // (both contain "burger"), causing the search to silently keep the old item.
  // When the message negates with "nahi", only search the text AFTER it.
  const searchText = /\bnahi\b/.test(text) ? text.slice(text.lastIndexOf("nahi") + 4) : text;

  // Prefer searching within the active category for unambiguous resolution
  let newItem: { name: string; price: number } | null = activeCat
    ? findItemForCategory(searchText, activeCat)
    : null;
  if (!newItem) newItem = findMenuItem(searchText, 1);
  if (!newItem) return null;

  const newCat = getItemCategory(newItem.name);
  if (!newCat) return null;

  // Priority 1: lastItem is in same category and differs from new item
  if (lastItemName) {
    const fromItem = cart.find((i) => i.name === lastItemName);
    if (fromItem && getItemCategory(fromItem.name) === newCat && fromItem.name !== newItem.name) {
      return { from: fromItem, to: newItem };
    }
  }
  // Priority 2: lastCategory matches
  if (lastCategory === newCat) {
    const fromItem = cart.find((i) => getItemCategory(i.name) === newCat);
    if (fromItem && fromItem.name !== newItem.name) return { from: fromItem, to: newItem };
  }
  // Priority 3: exactly one cart item in that category
  const catItems = cart.filter((i) => getItemCategory(i.name) === newCat);
  if (catItems.length === 1 && catItems[0].name !== newItem.name) {
    return { from: catItems[0], to: newItem };
  }

  return null;
}

export function findMenuItemByName(name: string): { name: string; price: number } | null {
  for (const cat of Object.values(MENU))
    for (const item of cat.items)
      if (item.name === name) return item;
  return null;
}

// Real customers pluralise menu words ("burgers", "sandwiches", "fries" already
// plural by default). Map a plural back to its singular ONLY when the singular is
// a recognised menu word AND the word as typed isn't already one itself — so
// "fries"/"strips" (already correct as-is) are left untouched.
function singularizeFoodWord(w: string): string {
  if (ALL_MENU_WORDS.has(w)) return w;
  if (w.endsWith("ies") && ALL_MENU_WORDS.has(w.slice(0, -3) + "y")) return w.slice(0, -3) + "y";
  if (w.endsWith("es") && ALL_MENU_WORDS.has(w.slice(0, -2))) return w.slice(0, -2);
  if (w.endsWith("s") && ALL_MENU_WORDS.has(w.slice(0, -1))) return w.slice(0, -1);
  return w;
}

// CATEGORY_ONLY words that are pure synonyms with NO overlapping literal word in
// any item name ("noodles" vs the actual "Chowmein" items, "chawal" vs "Rice")
// would otherwise break multi-keyword matching ("vegetable noodles" → off-menu,
// since "noodles" never appears in ALL_MENU_WORDS). Map them to a literal word
// that genuinely appears in that category's item names.
const CATEGORY_WORD_SYNONYMS: Record<string, string> = {
  noodles: "chowmein",
  chawal: "rice",
};

// Conservative edit-distance-1 typo correction — only used as a last resort for
// words length >= 4 that don't match anything else, to keep the false-positive
// rate on short/common words near zero ("brger" → "burger", "sndwch" misses
// because it loses too many letters, but single-letter slips/swaps/drops land).
function isEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    edits++;
    if (edits > 1) return false;
    if (a.length === b.length) { i++; j++; }
    else if (a.length > b.length) { i++; }
    else { j++; }
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

function fuzzyMenuWord(w: string): string | null {
  if (w.length < 4) return null;
  for (const mw of ALL_MENU_WORDS) {
    if (mw.length >= 4 && isEditDistanceOne(w, mw)) return mw;
  }
  return null;
}

export function getFoodKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 2 && !ORDER_STOP.has(w) && !/^\d+$/.test(w))
    .map(singularizeFoodWord)
    .map((w) => CATEGORY_WORD_SYNONYMS[w] ?? w)
    .map((w) => (ALL_MENU_WORDS.has(w) || CATEGORY_ONLY.has(w) || w in SINGLE_DEFAULTS ? w : fuzzyMenuWord(w) ?? w));
}

export type MatchResult =
  | { ok: true; item: { name: string; price: number }; qty: number }
  | { ok: false; reason: "off_menu"; category?: string; term: string }
  | {
      ok: false;
      reason: "ambiguous";
      category?: string;
      term: string;
      // Set only for "family ambiguity" — a single bare keyword ("zinger")
      // that matches 2+ SPECIFIC items, narrower than a whole category.
      familyItems?: { name: string; price: number }[];
    };

// "Zinger Burger W/C" can never be reached through normal keyword matching:
// getFoodKeywords strips punctuation first, so "w/c" becomes "wc" (2 chars) and
// gets filtered by the length>2 rule everywhere — including when ALL_MENU_WORDS
// itself was built. "with cheese" doesn't fare better: "with" is a stop word and
// "cheese" only appears on TOPPING items, never on this item's own name, so the
// multi-keyword matcher can never find a candidate containing it. Both phrasings
// would otherwise silently fall back to the plain (cheaper) Zinger Burger — a
// real wrong-item match. Handle it as an explicit special case before anything else.
function matchZingerWithCheese(seg: string): { name: string; price: number } | null {
  if (!/\bzinger\b/.test(seg) || !/\bburger\b/.test(seg)) return null;
  if (!/\bw\/?c\b|\bwith\s+cheese\b/.test(seg)) return null;
  return findMenuItemByName("Zinger Burger W/C");
}

// Every ORDERABLE menu item (toppings excluded — they're not independently
// orderable via chat, see TOPPING_INTENT) whose name contains `kw` as a whole
// word. Used to detect "family ambiguity": a bare keyword like "zinger" that
// names a whole family of specific items rather than one unambiguous item.
function familyMatches(kw: string): { name: string; price: number }[] {
  const out: { name: string; price: number }[] = [];
  for (const [catKey, cat] of Object.entries(MENU)) {
    if (catKey === "toppings") continue;
    for (const item of cat.items) {
      const words = new Set(item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      if (words.has(kw)) out.push(item);
    }
  }
  return out;
}

// Finds every menu item whose name contains ALL of `kws` as whole words, then
// prefers whichever has the FEWEST extra words beyond what the customer typed
// — "zinger burger" should resolve to "Zinger Burger", not silently to
// "Zinger Burger W/C", and "special" alone should NOT silently pick whichever
// of "Think Food Special Pizza" / "...Special Sandwich" happens to be listed
// first. A true tie (same extra-word count) is genuinely ambiguous — every
// caller (single-keyword and multi-keyword) goes through this ONE function so
// "is this a unique match or a coin-flip guess" is answered consistently
// everywhere, not re-implemented per call site with different rigor.
function pickBestCandidate(
  kws: string[]
): { ok: true; item: { name: string; price: number } } | { ok: false; category?: string } {
  const candidates: { name: string; price: number }[] = [];
  for (const cat of Object.values(MENU))
    for (const item of cat.items) {
      // Whole-word membership, NOT substring inclusion — "red" must not match
      // merely because it's embedded inside "alfRED-o".
      const nWords = new Set(item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
      if (kws.every((w) => nWords.has(w))) candidates.push(item);
    }

  if (candidates.length === 0) return { ok: false };
  if (candidates.length === 1) return { ok: true, item: candidates[0] };

  const extraWordCount = (item: { name: string }) => {
    const nWords = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    return nWords.filter((w) => !kws.includes(w)).length;
  };
  const minExtra = Math.min(...candidates.map(extraWordCount));
  const best = candidates.filter((c) => extraWordCount(c) === minExtra);
  if (best.length === 1) return { ok: true, item: best[0] };

  // True tie — derive the clarification category from the tied candidates
  // themselves (not a naive scan of kws, which can pick the WRONG category
  // when 2+ CATEGORY_ONLY words are present, e.g. "pizza fries" tying on
  // "pizza" instead of the actually-ambiguous "fries").
  const category = getItemCategory(best[0].name) ?? kws.find((w) => CATEGORY_ONLY.has(w));
  return { ok: false, category: category ?? undefined };
}

export function strictMatchSegment(seg: string): MatchResult {
  const qty = parseQty(seg);
  const wcItem = matchZingerWithCheese(seg);
  if (wcItem) return { ok: true, item: wcItem, qty };
  const kws = getFoodKeywords(seg);
  if (kws.length === 0) return { ok: false, reason: "ambiguous", term: seg };

  if (kws.length === 1) {
    const kw = kws[0];
    const defaultName = SINGLE_DEFAULTS[kw];
    if (defaultName) {
      const item = findMenuItemByName(defaultName);
      if (item) return { ok: true, item, qty };
    }
    if (CATEGORY_ONLY.has(kw)) return { ok: false, reason: "ambiguous", category: kw, term: seg };
    if (!ALL_MENU_WORDS.has(kw)) return { ok: false, reason: "off_menu", term: seg };

    // A bare keyword can match 2+ SPECIFIC items without being a whole-category
    // word — "zinger" matches Zinger Burger / Zinger Burger W/C / Jumbo Zinger,
    // none of which the customer clearly named. Ask which one rather than
    // guessing (pickBestCandidate's extra-word tie-break is the wrong tool
    // here: it would only flag a tie between the two CLOSEST matches and
    // silently drop "Zinger Burger W/C" from consideration entirely, since it
    // has one more qualifying word than the other two).
    const family = familyMatches(kw);
    if (family.length > 1) return { ok: false, reason: "ambiguous", term: seg, familyItems: family };
    if (family.length === 1) return { ok: true, item: family[0], qty };

    const picked = pickBestCandidate(kws);
    if (picked.ok) return { ok: true, item: picked.item, qty };
    return { ok: false, reason: "ambiguous", category: picked.category, term: seg };
  }

  // Multi-keyword: any unknown word → off-menu
  const unknownKws = kws.filter((w) => !ALL_MENU_WORDS.has(w));
  if (unknownKws.length > 0) {
    const category = kws.find((w) => CATEGORY_ONLY.has(w));
    return { ok: false, reason: "off_menu", category, term: seg };
  }

  const picked = pickBestCandidate(kws);
  if (picked.ok) return { ok: true, item: picked.item, qty };
  if (picked.category) return { ok: false, reason: "ambiguous", category: picked.category, term: seg };

  // Valid menu words but no single item has all of them → off-menu combination
  const category = kws.find((w) => CATEGORY_ONLY.has(w));
  return { ok: false, reason: "off_menu", category, term: seg };
}

// When a segment fails to match because of NOISE BEFORE the item ("aaj guests aa
// rahe hain to mujhe ek jumbo zinger"), retry using only the text from the last
// quantity word onward — real customers almost always put qty+item at the end of
// a preamble, never interleaved with it.
export function trimToLastQtyBoundary(seg: string): string {
  const hits = findQtyWordHits(seg);
  if (hits.length === 0) return seg;
  const lastIdx = hits[hits.length - 1];
  if (lastIdx <= 0) return seg;
  return seg.slice(lastIdx);
}

// Returns just the item list for a category (no header, no question) — used inside compound responses
export function listCategoryItems(category?: string): string {
  const list = (key: keyof typeof MENU) =>
    MENU[key].items.map((i) => `• ${i.name} — PKR ${i.price}`).join("\n");
  switch (category) {
    case "burger":                return list("burgers");
    case "rice": case "chawal":   return list("rice");
    case "pizza":                 return list("pizza");
    case "pasta":                 return list("pasta");
    case "noodles": case "chowmein": return list("noodles");
    case "sandwich": case "sandwiches": return list("sandwiches");
    case "roll": case "rolls":    return list("rolls");
    case "starter": case "starters": return list("starters");
    case "fries": case "pizzafries": return list("pizzaFries");
    default:                      return "";
  }
}

export function categoryOptions(category?: string): string {
  const list = (key: keyof typeof MENU) =>
    MENU[key].items.map((i) => `• *${i.name}* — PKR ${i.price}`).join("\n");
  const ask = (label: string) => `\n\nAap in mein se kaunsa *${label}* order karna chahenge?`;
  switch (category) {
    case "burger":
      return `🍔 *Hamare paas yeh burger options hain:*\n\n${list("burgers")}${ask("burger")}`;
    case "rice":
    case "chawal":
      return `🍚 *Available Rice Options:*\n\n${list("rice")}${ask("rice")}`;
    case "pizza":
      return `🍕 *Available Pizza Options:*\n\n${list("pizza")}${ask("pizza")}`;
    case "pasta":
      return `🍝 *Available Pasta Options:*\n\n${list("pasta")}${ask("pasta")}`;
    case "noodles":
    case "chowmein":
      return `🍜 *Available Noodles Options:*\n\n${list("noodles")}${ask("noodles item")}`;
    case "sandwich":
    case "sandwiches":
      return `🥪 *Available Sandwich Options:*\n\n${list("sandwiches")}${ask("sandwich")}`;
    case "roll":
    case "rolls":
      return `🌯 *Available Roll Options:*\n\n${list("rolls")}${ask("roll")}`;
    case "starter":
    case "starters":
      return `🍗 *Available Starter Options:*\n\n${list("starters")}${ask("starter")}`;
    case "fries":
    case "pizzafries":
      return `🍟 *Pizza Fries:*\n\n${list("pizzaFries")}\n\nAap small box lena chahenge ya large box?`;
    default:
      return `Think Food menu se order karein:\n\n🍔 Burgers — from PKR 500\n🍕 Pizza — from PKR 550\n🥪 Sandwiches — from PKR 500\n🍜 Chinese — from PKR 400\n🍝 Pasta — from PKR 500\n🍚 Rice — from PKR 400`;
  }
}

// Shared item/clause separator — used everywhere a message is split into segments.
// Includes a literal newline so copy-pasted multi-line menu text ("Item A — PKR x\nItem B — PKR y")
// splits into separate items instead of being read as one run-on segment.
export const SEGMENT_SPLIT = /[,،\n]|\baur\b|\band\b|\bor\b|\bplus\b|\bsaath\b|\bsath\b/i;

// Budget/group recommendation queries ("1000 rs mein kya milega for 2 logon ke
// liye") naturally contain digits, which would otherwise satisfy the generic
// add-items order signal and get swallowed by strict item matching before ever
// reaching the dedicated budget-recommendation handler below.
export const BUDGET_QUERY =
  /(\d{3,5}\s*(?:rupees?|rs\.?|pkr)?\s*mein|\d{3,5}\s*ka budget|mein\s*kya\s*(best|achha|milta|milega)|best milega|kya milega|kitna milega|kitne mein|budget|\d+\s*(log|banda|bande|logon|people|persons?)\s*ke liye)/;

export const ORDER_INTENT =
  /\b(want|order|give|take|pack|chahiye|chaiye|chahye|chahiy|lena|aik|ek|1x|one|i'll have|ill have|get me|get|add|de do|dijiye|dena|lagao|milna|bhi|mangwana|mangwane|mangwani|mangwa|khana)\b/;

export const REMOVE_INTENT =
  /(remove|hata|hatao|delete|nikal|nahi chahiye|mat chahiye|wapas karo|cancel item)/;

export const UPDATE_QTY_INTENT =
  /(ki jagah|update kar|badal do|change kar|quantity|qty|bana do|wala kar do|kar do)/;

export const ORDER_SUMMARY_INTENT =
  /(mera order|mere order|order dikhao|order batao|cart dikhao|kya order|show order|order summary|current order|what.*order|kitna hua|kitna bana|total kitna hai|mera total|total kya hai)/;

export const CHECKOUT_TRIGGER =
  /(place order|order place|place kar do|kar do place|karo place|order karden|place karo|order kar do|order karo|karo order|bas yahi|bs yahi|bas yehi|bs yehi|bas itna|bs itna|yahi order|yahi chahiye|yehi chahiye|checkout|proceed|continue|isi order|isi ko place|order confirm|confirm order|confirm kar do|submit order|complete order|order submit|order complete|order send|order bhejo|aage chalo|order final|final kar do|\bplace\b[^.!?]{0,15}\border\b)/;

// Explicit order confirmation — moves from checkout_review to Delivery/Pickup
export const CONFIRM_ORDER =
  /\b(confirm order|order confirm|order confirm kar do|order confirm karo|sab theek|bilkul theek|all correct|all good|confirm kar do|bas confirm kar do|bas confirm|final kar do|order final|haan confirm|yes confirm|sab sahi hai)\b|^\s*(confirm|confirmed|proceed|continue|submit)\s*[!.]*\s*$/i;

export const HYPOTHETICAL_INTENT =
  /\b(agar|agr)\b.{0,60}\b(add karun|add karo|add karoon|add krun|lagao|dena|add hoga|add karun to|milao|milaun)\b|\b(total kitna hoga|total kya hoga|kia price hongy|price hongy|price hoga|abhi add nahi|sirf price batao|sirf price bata|sirf total|what.*total|price kya honga|total bata|kitna hoga|kitna banta|total preview)\b/i;

export const NEGATIVE_REPLY =
  /\b(nahi|nahin|no|nope|abhi nahi|not now|baad mein|later|rehne do|rehne|zaroorat nahi|chahiye nahi|mat|theek hai baad mein|ruko|ruk jao|wait|sochta hun|sochti hun|filhal nahi|abhi sirf)\b/;

export const CART_CLEAR =
  /(cancel order|cart clear|sab hata do|cart empty|sabhi items hata|order hatao|clear cart|order clear|poora order cancel|puri order cancel|sab remove|sab delete|sab nikal|remove all|delete all|empty cart|poori cart|puri cart|poora order hata|poora order remove|sab cancel|remove everything|clear everything|delete everything|cancel everything|clear all|cancel all|remove complete order|clear complete order|remove whole order|remove entire order|clear entire order|cancel complete order|cancel entire order|cancel whole order|\bcancel\b[^.!?]{0,25}\b(order|cart)\b|\bclear\b[^.!?]{0,25}\b(order|cart)\b|\bsab\b[^.!?]{0,20}\bhata\b|\bcancel\b[^.!?]{0,20}\bsab\b|\bsab\b[^.!?]{0,20}\bcancel\b|\b(order|cart)\b[^.!?]{0,15}\bcancel\b)/;

// Replacement connector phrases — split point between remove-target (left) and add-target (right)
export const CROSS_REPLACE_TRIGGER =
  /\b(hata\s+kar|hata\s+ke|remove\s+karke|remove\s+kar\s+ke|nikal\s+kar|nikal\s+ke|badal\s+kar|convert\s+kar|replace\s+karke|ki\s+jagah|iski\s+jagah|uski\s+jagah)\b/i;

// Extracts only the person's name from natural-language name phrases.
// "Mera naam Fahad hai" → "Fahad", "I am Ali" → "Ali", "Main Bilal hun" → "Bilal"
export function extractName(raw: string): string {
  const t = raw.trim();
  let m: RegExpMatchArray | null;
  // "Mera naam X hai" / "Mera name X hai" / "Apna naam X hai"
  m = t.match(/\b(?:mera|meri|hamara|apna|mira)\s+(?:naam|name)\s+(.+?)(?:\s+ha[ei]n?|\s+hy\s*$|$)/i);
  if (m) return m[1].trim();
  // "My name is X"
  m = t.match(/\bmy\s+name\s+is\s+(.+)/i);
  if (m) return m[1].replace(/\s+ha[ei]n?\s*$/i, "").trim();
  // "naam X hai" (without possessive)
  m = t.match(/\bnaam\s+(.+?)(?:\s+ha[ei]n?|$)/i);
  if (m) return m[1].trim();
  // "I am X" / "I'm X"
  m = t.match(/\b(?:i\s+am|i'm)\s+(.+)/i);
  if (m) return m[1].replace(/\s+hu[hn]?\s*$/i, "").replace(/\s+ha[ei]n?\s*$/i, "").trim();
  // "Main X hun" / "Mein X hun" / "Main X hoon"
  m = t.match(/\b(?:main|mein)\s+(.+?)\s+(?:hu[hn]?|hoon)\s*$/i);
  if (m) return m[1].trim();
  // "X hun" / "X hoon" at end
  m = t.match(/^(.+?)\s+(?:hu[hn]?|hoon)\s*$/i);
  if (m && m[1].split(/\s+/).length <= 3) return m[1].trim();
  // Plain name — return as-is
  return t;
}

// A question or command typed into the name prompt ("pickup chahiye", "aap log
// kab tak khule rehte hain") must not be silently accepted as the customer's
// literal name — that's a garbage name on a real order. Real names are short
// (1-4 words) and don't contain question marks, digits, or common Roman
// Urdu/English function words.
const NAME_REJECT_WORDS = /\b(chahiye|kab|kya|kahan|kyun|kyu|hai|hain|rehte|rehta|karte|karta|khule|khula|tak|kitna|kitne|milega|available|order|pickup|delivery|please|address|naam|batao|kaisa|kaisi|nahi|nahin|yaad|dobara)\b/i;

function isValidName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (/[?\d]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  if (NAME_REJECT_WORDS.test(trimmed)) return false;
  return true;
}

export function isValidAddress(addr: string): boolean {
  const trimmed = addr.trim();
  if (trimmed.length < 10) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 3) return false;
  const JUNK = new Set(["asdf", "abc", "ok", "yes", "no", "hello", "hi", "test", "xyz", "qwerty", "asd", "k", "okay", "fine", "lol"]);
  const real = words.filter((w) => !JUNK.has(w.toLowerCase()) && w.length >= 2);
  if (real.length < 2) return false;
  // A real address almost always has either a house/street number or a
  // recognisable address word — without either, this is far more likely to be
  // an unrelated sentence (e.g. an item-add attempt typed by mistake into the
  // address prompt) than an actual address, and accepting it would send the
  // order to a garbage location.
  const hasDigit = /\d/.test(trimmed);
  const ADDRESS_WORDS = /\b(house|ghar|street|gali|block|road|flat|sector|phase|near|society|town|colony|plot|floor|apartment|area|scheme|lane|nazimabad|gulshan|dha|clifton|karachi|lahore|islamabad)\b/i;
  return hasDigit || ADDRESS_WORDS.test(trimmed);
}

// ─── Unavailable item map with targeted alternatives ─────────────────────────

export const UNAVAIL_MAP: Array<{ pattern: RegExp; label: string; alts: string }> = [
  {
    pattern: /\b(biryani|pulao)\b/,
    label: "Biryani / Pulao",
    alts: "Biryani available nahi hai, lekin hamare rice dishes iska perfect substitute hain:\n\n🍚 *Singaporean Rice* — PKR 700 (best-seller, loaded with flavour)\n🍚 *Chicken Fried Rice* — PKR 450\n🍚 *Egg Rice* — PKR 450\n\nKoi try karein?",
  },
  {
    pattern: /\b(karahi|nihari|haleem|qorma)\b/,
    label: "Desi food",
    alts: "Desi curries hamare menu mein nahi hain. Lekin filling options:\n\n🥩 *Chicken Steak* — PKR 950 (grilled, juicy, satisfying)\n🍗 *Chicken Strips 6 pcs with fries* — PKR 750\n\nKoi try karein?",
  },
  {
    pattern: /\b(broast)\b/,
    label: "Broast",
    alts: "Broast available nahi hai, lekin hamare crispy chicken options hain:\n\n🍗 *Chicken Strips 6 pcs with fries* — PKR 750 (crispy, juicy)\n🍗 *Hot Shot 8 pcs with fries* — PKR 800\n\nIn mein se order karein?",
  },
  {
    pattern: /\b(shawarma)\b/,
    label: "Shawarma",
    alts: "Shawarma nahi hai, lekin bilkul usi style mein:\n\n🌯 *Wrap* — PKR 550\n🌯 *Gyro* — PKR 550\n\nDono same price par hain. Koi try karein?",
  },
  {
    pattern: /\b(tikka|kabab)\b/,
    label: "Tikka / Kabab",
    alts: "Tikka/Kabab available nahi hain. Grill-lovers ke liye:\n\n🥩 *Chicken Steak* — PKR 950\n🍗 *Chicken Strips 6 pcs with fries* — PKR 750",
  },
  {
    pattern: /\b(chai|tea|coffee|juice|lassi|drinks?|cold drink|coke|pepsi|sprite|7up|7\s*up|fanta|dew|mountain dew|water|soda|beverage|beverages?)\b/,
    label: "Drinks",
    alts: "Drinks / beverages current menu mein available nahi hain.\n\nFood order kar sakte hain — koi item try karein?",
  },
  {
    pattern: /\b(roti|naan|paratha)\b/,
    label: "Roti / Naan",
    alts: "Roti/Naan available nahi hai. Bread alternatives:\n\n🥪 *Sandwiches* — from PKR 500\n🌯 *Wrap* — PKR 550",
  },
  {
    pattern: /\b(daal|dal|sabzi)\b/,
    label: "Daal / Sabzi",
    alts: "Desi dishes nahi hain. Vegetable options:\n\n🍚 *Vegetable Rice* — PKR 400\n🍜 *Vegetable Chowmein* — PKR 600\n🥪 *Vegi Sandwich* — PKR 500",
  },
];

// ─── Spelling normalisation ───────────────────────────────────────────────────
// Handles Roman-Urdu abbreviations and common misspellings before intent matching

export function normalizeSpelling(text: string): string {
  return text
    // Real customers send double spaces, tabs, trailing spaces etc. — collapse
    // before anything else so every literal-phrase regex below still matches.
    // Newlines are preserved (collapsed to a single \n) since SEGMENT_SPLIT uses
    // them to split copy-pasted multi-line menu text into separate items.
    .replace(/\r\n?/g, "\n")
    // Strip emoji anywhere in the message — "✅ confirm" must match the same as
    // "confirm", "🍕" alone must not be mistaken for a menu word, etc. Done
    // before anything else so every downstream regex sees plain text.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n+/g, "\n")
    // ─── Strip menu copy-paste formatting (bullets, em-dashes, PKR prices) ─
    .replace(/\b(?:pkr|rs\.?|rupees?)\s*\d[\d,]*\b/gi, "")
    .replace(/[—–]\s*\d[\d,]*/g, " ")
    .replace(/[—–]/g, " ")
    .replace(/[•·→►▶]/g, " ")
    .replace(/×/g, " ")
    // ────────────────────────────────────────────────────────────────────────
    .replace(/\bzngr\b/gi,       "zinger")
    .replace(/\bznger\b/gi,      "zinger")
    .replace(/\bchowmin\b/gi,    "chowmein")
    .replace(/\bchowmain\b/gi,   "chowmein")
    .replace(/\bchowmien\b/gi,   "chowmein")
    .replace(/\bchowmine\b/gi,   "chowmein")
    .replace(/\bnoodels\b/gi,    "noodles")
    .replace(/\bnoodl\b/gi,      "noodles")
    .replace(/\bnoodel\b/gi,     "noodles")
    .replace(/\bchikn\b/gi,      "chicken")
    .replace(/\bchiken\b/gi,     "chicken")
    .replace(/\bchickn\b/gi,     "chicken")
    .replace(/\bpiza\b/gi,       "pizza")
    .replace(/\bpzza\b/gi,       "pizza")
    .replace(/\bbrgr\b/gi,       "burger")
    .replace(/\bpsta\b/gi,       "pasta")
    .replace(/\bsndwch\b/gi,     "sandwich")
    .replace(/\bsandwitch\b/gi,  "sandwich")
    .replace(/\bnhi\b/gi,      "nahi")
    .replace(/\bnhin\b/gi,     "nahin")
    .replace(/\bhan\b/gi,      "haan")
    .replace(/\bkrdo\b/gi,     "kar do")
    .replace(/\bkrna\b/gi,     "karna")
    .replace(/\bkrein\b/gi,    "karein")
    .replace(/\bkro\b/gi,      "karo")
    // Standalone "kr" (shorthand for "kar") — "small kr do" must be recognised
    // the same as "small kar do", or the size-correction/replacement detectors
    // miss it entirely and a bare "small"/"large" reply gets misread as a
    // request for an unrelated item that happens to share that word.
    .replace(/\bkr\b/gi,       "kar")
    // "x2" / "2x" multiplier shorthand — give the digit its own word boundary
    // so parseQty can find it ("zinger burger x2" / "2x zinger burger").
    .replace(/\bx(\d+)\b/gi,   " $1 ")
    .replace(/\b(\d+)x\b/gi,   "$1 ")
    .replace(/\bplz\b/gi,      "please")
    .replace(/\brmv\b/gi,      "remove")
    .replace(/\bcncl\b/gi,     "cancel")
    .replace(/\bsme\b/gi,      "same")
    .replace(/\bhat do\b/gi,   "hata do")
    .replace(/\bhatado\b/gi,   "hata do")
    // Contractions that would otherwise leave unknown keywords in menu matching
    .replace(/\bdedo\b/gi,     "de do")
    .replace(/\bkardo\b/gi,    "kar do")
    .replace(/\bbhejdo\b/gi,   "bhej do")
    .replace(/\bbtao\b/gi,     "batao")
    .replace(/\bthk\b/gi,      "theek")
    .replace(/\bthik\b/gi,     "theek")
    .replace(/\bmujhy\b/gi,    "mujhe")
    .replace(/\bmjy\b/gi,      "mujhe")
    .replace(/\bgive me\b/gi,  "dena")
    // Ordering intent variants → normalise to canonical forms so ORDER_INTENT catches them
    .replace(/\bchahye\b/gi,   "chahiye")
    .replace(/\bchahiy\b/gi,   "chahiye")
    .replace(/\bchaiyeh\b/gi,  "chahiye")
    .replace(/\bchaye\b/gi,    "chahiye")
    .replace(/\bmangwalo\b/gi, "mangwana")
    // Price query variants
    .replace(/\bkitny\b/gi,    "kitna")
    // Info/show request variants
    .replace(/\bdikhado\b/gi,  "dikhao")
    // Plural → singular for consistent menu matching
    .replace(/\bhot shots\b/gi, "hot shot")
    .replace(/\bsteaks\b/gi,    "steak")
    // Compound menu words run together without spaces — split into canonical form
    .replace(/\bhotshots?\b/gi,           "hot shot")
    .replace(/\bpizzafries\b/gi,          "pizza fries")
    .replace(/\bzingerburger\b/gi,        "zinger burger")
    .replace(/\bgrillsandwich\b/gi,       "grill sandwich")
    .replace(/\bclubsandwich\b/gi,        "club sandwich")
    .replace(/\bpizzalarge\b/gi,          "pizza large")
    .replace(/\bpizzasmall\b/gi,          "pizza small")
    .replace(/\bchickensandwich\b/gi,     "chicken sandwich")
    .replace(/\balfredopasta\b/gi,        "alfredo pasta")
    .replace(/\bchickensteak\b/gi,        "chicken steak")
    .replace(/\bchickenchowmein\b/gi,     "chicken chowmein")
    .replace(/\bvegetablechowmein\b/gi,   "vegetable chowmein")
    .replace(/\bchickenfriedrice\b/gi,    "chicken fried rice")
    .replace(/\bsingaporeanrice\b/gi,     "singaporean rice")
    .replace(/\bchickenstrips\b/gi,       "chicken strips")
    .replace(/\bsmokeburger\b/gi,         "smoke burger")
    .replace(/\bjumboZinger\b/gi,         "jumbo zinger")
    .replace(/\bmexicansandwich\b/gi,     "mexican sandwich")
    .replace(/\bmexicanpizza\b/gi,        "mexican pizza")
    .replace(/\bmexicanpasta\b/gi,        "mexican pasta")
    .replace(/\bwhitesauce\b/gi,          "white sauce")
    .replace(/\bredsauce\b/gi,            "red sauce")
    // Pause/wait shorthand
    .replace(/\brukja\b/gi,    "ruk jao")
    .replace(/\brukjao\b/gi,   "ruk jao");
}

// "ek aur" / "one more" — add 1 to the last touched item
// NOTE: "aur ek" is deliberately NOT included here — it collides with the very
// common "[remove/done] aur ek [new item]" pattern ("...aur ek pasta large"),
// which means "AND one pasta large" (a new item), not "one more" (increment).
export const EK_AUR_INTENT =
  /\b(ek aur|ek or|one more|aur wahi|same aur|wahi wala aur|same again|another one|add another|same item|ek aur do)\b/;

// Pizza topping requests — detected before generic order matching
export const TOPPING_INTENT =
  /\b(topping|toppings|cheese topping|extra cheese|extra chicken|olive mushroom|olive|mushroom|jalapeno|pizza add.?on|add.?on)\b/;

// Returns the size of the most recently added pizza in the cart
export function getPizzaSizeFromCart(cart: CartItem[]): "large" | "medium" | "small" | null {
  for (let i = cart.length - 1; i >= 0; i--) {
    if (getItemCategory(cart[i].name) === "pizza") {
      const n = cart[i].name.toLowerCase();
      if (n.includes("large") || n.includes("12 inch")) return "large";
      if (n.includes("regular") || n.includes("9 inch")) return "medium";
      if (n.includes("small") || n.includes("6 inch")) return "small";
      return "large"; // Think Food Special / Mexican Pizza → use large toppings
    }
  }
  return null;
}

// Matches a customer's topping request to the right menu item using pizza size context
export function matchTopping(text: string, pizzaSize: "large" | "medium" | "small" | null): { name: string; price: number } | null {
  const t = text.toLowerCase();
  const size = pizzaSize ?? "large";

  if (/\b(olive|mushroom|jalapeno)\b/.test(t))
    return MENU.toppings.items.find((i) => i.name === "Olive Mushroom Jalapeno") ?? null;

  if (/\b(extra cheese|cheese topping|cheese)\b/.test(t)) {
    const name = size === "large" ? "Pizza Large Cheese Topping"
      : size === "medium" ? "Pizza Medium Cheese Topping"
      : "Pizza Small Cheese Topping";
    return MENU.toppings.items.find((i) => i.name === name) ?? null;
  }

  if (/\b(extra chicken)\b/.test(t)) {
    const name = size === "large" ? "Extra Chicken Large"
      : size === "medium" ? "Extra Chicken Medium"
      : "Extra Chicken Small";
    return MENU.toppings.items.find((i) => i.name === name) ?? null;
  }

  return null;
}

// Returns topping suggestion text sized to the pizza that was just added
export function pizzaToppingSuggestion(pizzaName: string): string {
  const n = pizzaName.toLowerCase();
  let cheese: string, extraChicken: string;
  if (n.includes("large") || n.includes("12 inch")) {
    cheese = "Pizza Large Cheese Topping — PKR 250";
    extraChicken = "Extra Chicken Large — PKR 200";
  } else if (n.includes("regular") || n.includes("9 inch")) {
    cheese = "Pizza Medium Cheese Topping — PKR 200";
    extraChicken = "Extra Chicken Medium — PKR 200";
  } else if (n.includes("small") || n.includes("6 inch")) {
    cheese = "Pizza Small Cheese Topping — PKR 150";
    extraChicken = "Extra Chicken Small — PKR 150";
  } else {
    cheese = "Pizza Large/Medium/Small Cheese Topping";
    extraChicken = "Extra Chicken Large/Medium/Small";
  }
  return `\n\n🍕 *Pizza add-ons bhi available hain:*\n• ${cheese}\n• ${extraChicken}\n• Olive Mushroom Jalapeno — PKR 150\n\nKoi topping add karna chahein to bata dein!`;
}

// ─── AI Logic ─────────────────────────────────────────────────────────────────

const HUMAN_ESCALATION =
  /(manager|complaint|complain|supervisor|baat karni hai|baat chahiye|speak to human|staff se baat|human agent|real person|insaan se)/;

// A message carries "order intent" when it has an explicit trigger word/digit, OR —
// even with no verb at all — when it resolves *unambiguously* to one specific real
// menu item (full multi-word name match, or a known single-word identifier like
// "zinger"/"gyro"). The latter lets bare short messages like "zinger" or "pizza
// large" add directly, while genuinely vague mentions ("pizza", "burger" alone)
// still fall through to category browsing instead of guessing.
// Phrases that mark a message as a QUESTION about an item rather than a request
// for it — "smoke burger kitny ka hai" (how much is it) must never silently add
// to cart just because "smoke burger" happens to resolve unambiguously.
const INQUIRY_MARKERS = /\?|\bkitna\b|\bkitne\b|\bprice\b|\brate\b|\bcost\b|\bkya hai\b|\bhai kya\b|\bmilta\b|\bmilega\b|\bmilti\b|\bavailable\b|\bhow much\b/;

// "dikhao"/"show"/"batao"/"options"/"menu" mean the customer wants
// INFORMATION, not an action — "or zinger dikhao" (show me zinger [options])
// must not be read as "add another zinger" just because "zinger" alone would
// otherwise resolve unambiguously. Global, category-agnostic: applies to
// every item/category, not just zinger.
export const SHOW_INTENT =
  /\b(dikhao|dikhado|dikha do|show|batao|btao|options?|menu|konsay|konsa|konsi|kaunsa|kaunsi|which)\b/i;

// Words/phrases that unambiguously mean "add this", strong enough to override
// SHOW_INTENT when both appear in the same message. Most explicit add words
// ("add", "order", "chahiye", "de do", "dena", "dijiye") are already covered
// by ORDER_INTENT above (checked first); this only needs to catch the
// remaining gap — "kar do"/"krdo"/"kardo" (normalised to "kar do") and
// "laga do" — which aren't themselves in ORDER_INTENT's word list.
const EXPLICIT_ADD_OVERRIDE = /\bkar do\b|\blaga do\b/i;

export function detectsOrderSignal(text: string): boolean {
  if (ORDER_INTENT.test(text)) return true;
  if (hasRealQtyDigit(text)) return true;
  if (ORDER_SIGNAL_NUM_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(text))) return true;
  if (INQUIRY_MARKERS.test(text)) return false;
  if (SHOW_INTENT.test(text) && !EXPLICIT_ADD_OVERRIDE.test(text)) return false;
  return strictMatchSegment(text).ok;
}

// Single shared resolver for "what menu item(s), if any, does this segment of
// text refer to" — tries, in order: (1) a direct strict match, (2) splitting at
// repeated quantity-word boundaries ("ek zinger ek pasta" → two items), (3)
// trimming leading noise before the LAST quantity word ("aaj guests aa rahe
// hain to mujhe ek jumbo zinger" → "ek jumbo zinger"). Every caller that needs
// to know "does this segment refer to a real item" — the actual Add-items
// loop, and the hasResolvableItem() guard used by NEGATIVE_REPLY — goes through
// this ONE function so they can never silently disagree with each other again
// (that drift was a real bug: hasResolvableItem used to only try the direct
// match, so it missed orders the Add-items loop would have found via the
// trim/sub-split fallbacks, letting a stray "nahi" wrongly block a real order).
type SegmentFailure = Extract<MatchResult, { ok: false }>;
type AmbiguousFailure = Extract<SegmentFailure, { reason: "ambiguous" }>;

// Shared rendering for an ambiguous-segment error, whether it's a whole
// CATEGORY ambiguity ("pasta" → ask which pasta, full category listing) or a
// narrower FAMILY ambiguity (bare "zinger" → ask which of just the 3 zinger
// items, not the whole burger menu). Every place that turns an ambiguous
// error into a customer-facing prompt or a PendingClarification goes through
// these so the two ambiguity kinds are never handled with separate,
// drifting copies of the same rendering logic.

// Short label for headers/joins — "Zinger" for a family, "Pasta" for a category.
function ambigLabel(err: AmbiguousFailure): string {
  if (err.familyItems) {
    const kw = getFoodKeywords(err.term)[0] ?? err.term.trim();
    return kw.charAt(0).toUpperCase() + kw.slice(1);
  }
  const cat = err.category ?? "";
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

// The bullet-point item list for one ambiguous error.
function ambigOptionsBlock(err: AmbiguousFailure): string {
  if (err.familyItems) return err.familyItems.map((i) => `• *${i.name}* — PKR ${i.price}`).join("\n");
  return listCategoryItems(err.category);
}

// The full standalone clarification prompt, used when there's exactly ONE
// ambiguous error to ask about.
function ambigFullPrompt(err: AmbiguousFailure): string {
  if (err.familyItems) {
    const qty = parseQty(err.term);
    return `Aap kaunsa *${ambigLabel(err)}* option chahenge?\n\n${ambigOptionsBlock(err)}\n\nAap total ${qty} mein se quantity kaise split karna chahenge?`;
  }
  return categoryOptions(err.category);
}

// The PendingClarification this error should leave behind for the next
// customer message to resolve (single variant or multi-variant breakdown).
function ambigPendingClarification(err: AmbiguousFailure): PendingClarification {
  const category =
    err.category ?? (err.familyItems ? getItemCategory(err.familyItems[0].name) ?? ambigLabel(err).toLowerCase() : "");
  return {
    category,
    qty: parseQty(err.term),
    familyItems: err.familyItems,
    familyLabel: err.familyItems ? ambigLabel(err) : undefined,
  };
}

// Same rendering as ambigLabel/ambigOptionsBlock, but for an already-built
// PendingClarification (used when re-displaying a still-unresolved
// clarification after a partial reply).
function pendingLabel(p: PendingClarification): string {
  if (p.familyLabel) return p.familyLabel;
  return p.category.charAt(0).toUpperCase() + p.category.slice(1);
}

function pendingOptionsBlock(p: PendingClarification): string {
  if (p.familyItems) return p.familyItems.map((i) => `• *${i.name}* — PKR ${i.price}`).join("\n");
  return listCategoryItems(p.category);
}

function resolveSegmentItems(seg: string): {
  items: Array<{ item: { name: string; price: number }; qty: number }>;
  errors: SegmentFailure[];
} {
  // When the segment carries 2+ quantity markers, it's almost certainly a
  // multi-item mention ("2 jumbo zinger 2 zinger burger w/c") — split FIRST,
  // before attempting a whole-segment match. Trying the whole blob first is
  // unsafe: a lenient/special-case match (e.g. the "Zinger Burger W/C"
  // special case, which just checks for zinger+burger+w/c ANYWHERE in the
  // text) can spuriously succeed on the COMBINED text and silently swallow
  // every other item mentioned in the same segment. Collecting every chunk's
  // outcome — not just stopping at the first success — also fixes "2 zinger
  // 2 pasta" dropping the pasta clarification once the zinger half resolved.
  const subSegs = subSplitAtQtyBoundaries(seg);
  if (subSegs.length > 1) {
    const items: Array<{ item: { name: string; price: number }; qty: number }> = [];
    const errors: SegmentFailure[] = [];
    for (let i = 0; i < subSegs.length; i++) {
      const sub = subSegs[i];
      // A self-correction mid-sentence — "ek zinger burger... nahi nahi ek
      // smoke burger de do" — must NOT be read as "add both"; the customer
      // talked themselves out of the earlier choice. A chunk that isn't the
      // last one and trails off in a bare negation is the retracted choice.
      if (i < subSegs.length - 1 && /\b(nahi|nahin|mat)\b\s*[.…]*\s*$/i.test(sub)) continue;
      const r = strictMatchSegment(sub);
      if (r.ok) items.push({ item: r.item, qty: r.qty });
      else if (getFoodKeywords(sub).length > 0) errors.push(r);
    }
    if (items.length > 0 || errors.length > 0) return { items, errors };
    // Every chunk was pure noise (no food keywords at all) — fall through to
    // the whole-segment attempts below.
  }

  const direct = strictMatchSegment(seg);
  if (direct.ok) return { items: [{ item: direct.item, qty: direct.qty }], errors: [] };

  const trimmed = trimToLastQtyBoundary(seg);
  if (trimmed !== seg) {
    const trimmedResult = strictMatchSegment(trimmed);
    if (trimmedResult.ok) return { items: [{ item: trimmedResult.item, qty: trimmedResult.qty }], errors: [] };
  }

  if (!direct.ok && getFoodKeywords(seg).length > 0) return { items: [], errors: [direct] };
  return { items: [], errors: [] };
}

// Stricter than detectsOrderSignal: true only when at least one segment of the
// message actually RESOLVES to a real menu item, not just when a generic trigger
// word (like "add") is present. Used to gate NEGATIVE_REPLY — a stray "nahi" in
// a rant ("kuch nahi khaya, ek hot shot...") shouldn't block a real order that
// follows it, but "add nahi karna" (don't add) has no resolvable item at all and
// should still soft-decline.
function hasResolvableItem(text: string): boolean {
  return text
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((seg) => resolveSegmentItems(seg).items.length > 0);
}

export function ai(input: string, phase: Phase, draft: Draft): AIOut {
  const t = normalizeSpelling(input.toLowerCase().trim());

  // Escalation to a human always takes priority — even if the message also
  // happens to contain generic words ("order", "want") that would otherwise be
  // read as an item request.
  if (HUMAN_ESCALATION.test(t)) {
    return {
      content: `Hum aapki baat hamare team se karwayenge.\n\nPlease share karein:\n👤 *Aapka naam*\n📞 *Phone number*\n\nHamara team member aapko jald call karega.`,
    };
  }

  const cartTrail = phase === "checkout_review"
    ? "\n\nKoi aur change karna ho to batayein, ya *Confirm Order* likh dein."
    : "\n\nType any item to add more, or *Place Order* to checkout.";

  // ── Order summary ──────────────────────────────────────────────────────────
  // Only fire for pure summary requests — if numerics are also present, the active
  // cart block handles adding first (and already appends the cart summary in its response)
  const hasPureOrderSignal = hasRealQtyDigit(t) ||
    Object.keys(URDU_NUMS).some((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (ORDER_SUMMARY_INTENT.test(t) && !hasPureOrderSignal) {
    if (draft.cart.length === 0) {
      return { content: `Aapka cart abhi khali hai.\n\nKoi item ka naam type karein order karne ke liye.` };
    }
    return { content: cartSummary(draft.cart) };
  }

  // ── Pending clarification resolution ──────────────────────────────────────
  // When AI previously asked "which pasta/burger?" the next customer message tries to resolve it
  if (draft.pendingClarifications && draft.pendingClarifications.length > 0) {
    const pending = draft.pendingClarifications;
    const segments = t.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);

    const resolved: Array<{ item: { name: string; price: number }; qty: number }> = [];
    const stillPending: PendingClarification[] = [];

    for (const p of pending) {
      // Multi-variant breakdown reply — "2 small 2 large 1 alfredo" answering
      // "which pasta?" — each variant gets its OWN stated quantity instead of
      // the original total being dumped onto a single guessed variant. Only
      // attempted when there's exactly one pending category: with 2+ pending
      // categories at once, a breakdown reply naming generic size words
      // ("small"/"large") could ambiguously match items in EITHER category.
      // When this clarification is scoped to a narrower item FAMILY ("which
      // zinger?"), resolve against just those items — not the whole category
      // — so an unrelated same-category item can't be silently accepted as
      // if it answered this specific question.
      if (pending.length === 1) {
        const breakdown = p.familyItems
          ? resolveFamilyBreakdown(t, p.familyItems)
          : resolveCategoryBreakdown(t, p.category);
        if (breakdown) {
          resolved.push(...breakdown);
          continue;
        }
      }
      let found = false;
      for (const seg of segments) {
        const item = p.familyItems
          ? findItemAmongFamily(seg, p.familyItems)
          : findItemForCategory(seg, p.category);
        if (item) {
          resolved.push({ item, qty: p.qty });
          found = true;
          break;
        }
      }
      if (!found) stillPending.push(p);
    }

    if (resolved.length > 0) {
      const actions: CartAction[] = [];
      let newCart = [...draft.cart];
      const addedLines: string[] = [];
      let lastAddedName: string | undefined;

      for (const { item, qty } of resolved) {
        const existing = newCart.find((i) => i.name === item.name);
        if (existing) {
          newCart = newCart.map((i) => i.name === item.name ? { ...i, qty: i.qty + qty } : i);
        } else {
          newCart = [...newCart, { name: item.name, price: item.price, qty }];
        }
        addedLines.push(`${qty} x ${item.name}`);
        actions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
        lastAddedName = item.name;
      }

      if (stillPending.length > 0) {
        let content = `*Added:*\n${addedLines.join("\n")}`;
        for (const p of stillPending) {
          content += `\n\n*${pendingLabel(p)} ke liye options:*\n${pendingOptionsBlock(p)}`;
        }
        const labels = stillPending.map((p) => `*${pendingLabel(p)}*`).join(" aur ");
        content += `\n\nAap ${labels} mein se kaunsa option select karna chahenge?`;
        return {
          content,
          nextPhase: "item_selected",
          cartActions: actions,
          draftPatch: {
            lastItem: lastAddedName,
            pendingClarifications: stillPending,
            lastCategory: (lastAddedName ? getItemCategory(lastAddedName) : null) ??
              (stillPending.length > 0 ? stillPending[0].category : undefined) ??
              draft.lastCategory,
          },
        };
      }

      return {
        content: `*Added:*\n${addedLines.join("\n")}\n\n${cartSummary(newCart)}${cartTrail}`,
        nextPhase: "item_selected",
        cartActions: actions,
        draftPatch: {
          lastItem: lastAddedName,
          pendingClarifications: [],
          lastCategory: (lastAddedName ? getItemCategory(lastAddedName) : null) ?? draft.lastCategory,
        },
      };
    }
    // Nothing matched — fall through to normal handling (pending stays)
  }

  // ── Checkout phases ────────────────────────────────────────────────────────
  if (phase === "checkout_type") {
    if (NEGATIVE_REPLY.test(t) || /cancel/.test(t))
      return {
        content: `Koi baat nahi. Cart abhi bhi save hai.\n\nJab order place karna ho, *place order* type karein.`,
        nextPhase: "item_selected",
      };
    // "delivery mein kitna time lagega" is a QUESTION about delivery, not a
    // selection of it — answer it and stay put, rather than silently jumping
    // to the address step as if the customer had chosen delivery.
    if (/\bdelivery\b/.test(t) && /\?|kitna|kitne|kitni|time|der|kab/.test(t)) {
      return {
        content: `⏱️ *Estimated Delivery Time:* ${INFO.deliveryTime} after order confirmation.\n\n*Delivery* ya *Pickup* — kaunsa prefer karein ge?`,
      };
    }
    if (/delivery/.test(t))
      return {
        content: `📍 Aapka *delivery address* share karein.\n\nExample:\n• House 45 Street 12 Nazimabad Karachi\n• Block A DHA Karachi`,
        nextPhase: "checkout_address",
        draftPatch: { type: "delivery" },
      };
    if (/pickup|pick up/.test(t))
      return {
        content: `👤 Aapka *naam* share karein pickup ke liye.`,
        nextPhase: "checkout_name",
        draftPatch: { type: "pickup" },
      };
    return { content: `*Delivery* ya *Pickup* — kaunsa prefer karein ge?` };
  }

  if (phase === "checkout_address") {
    // Customer changed their mind — switch to pickup
    if (/pickup|pick up/.test(t)) {
      return {
        content: `✅ Pickup select ho gaya.\n\n👤 Aapka *naam* share karein.`,
        nextPhase: "checkout_name",
        draftPatch: { type: "pickup", address: undefined },
      };
    }
    const addr = input.trim();
    if (!isValidAddress(addr)) {
      return {
        content: `⚠️ Yeh address valid nahi hai. Apna *poora address* likhein:\n\n✅ House 45 Street 12 Nazimabad Karachi\n✅ Block A DHA Karachi\n✅ Flat 302 Gulshan Karachi\n\n❌ "ok", "hello", "asdf" accept nahi hongay.`,
      };
    }
    return {
      content: `✅ Address note kar liya.\n\n👤 Ab aapka *naam* share karein.`,
      nextPhase: "checkout_name",
      draftPatch: { address: addr },
    };
  }

  if (phase === "checkout_name") {
    const name = extractName(input.trim());
    if (!isValidName(name)) {
      return {
        content: `⚠️ Yeh naam valid nahi lagta. Please apna *poora naam* likhein:\n\n✅ Fahad\n✅ Ali Raza\n✅ Muhammad Hassan`,
      };
    }
    const isDelivery = draft.type === "delivery";
    const deliveryFee = isDelivery ? 150 : 0;
    const cartTotal = draft.cart.reduce((s, i) => s + i.price * i.qty, 0);
    const total = cartTotal + deliveryFee;
    const itemLines = draft.cart.map((i) => `  ${i.qty} x ${i.name} — PKR ${i.price * i.qty}`).join("\n");
    const lines = [
      `📋 *Order Summary*`,
      ``,
      itemLines,
      ``,
      isDelivery ? `🚚 Delivery Fee: PKR ${deliveryFee}` : null,
      `💰 *Total: PKR ${total}*`,
      ``,
      isDelivery ? `📍 Address: ${draft.address}` : `🏪 Pickup`,
      `👤 Name: ${name}`,
      ``,
      `Type *YES* to place your order.`,
    ];
    return {
      content: lines.filter(Boolean).join("\n"),
      nextPhase: "checkout_summary",
      draftPatch: { name },
    };
  }

  if (phase === "checkout_summary") {
    // This is the final, money-committing step — check for an explicit
    // cancel/negative FIRST. "haan... nahi wait cancel" starts with "haan" but
    // the customer is clearly backing out; a prefix-only check on the confirm
    // pattern would have placed an order they explicitly tried to stop. When
    // there's any contradiction at this step, never silently proceed.
    if (/cancel|no|nahi|nahin|wapas|back/.test(t))
      return {
        content: `Order cancel kar diya gaya.\n\nKoi item ka naam type karein nayi order shuru karne ke liye.`,
        nextPhase: "browsing",
        cartAction: { op: "clear" },
      };
    if (/^(yes|haan|han|ji\b|okay|ok\b|theek|bilkul|zaroor|confirm|done|place|karo|laga do|order karo)/.test(t))
      return { content: "", confirmed: true };
    return { content: `*YES* likhein order place karne ke liye, ya *Cancel* likhein wapas jaane ke liye.` };
  }

  // ── checkout_review — order review before delivery/pickup ─────────────────
  if (phase === "checkout_review") {
    // CONFIRM_ORDER and any re-confirmation of checkout intent both advance to delivery/pickup
    if (CONFIRM_ORDER.test(t) || CHECKOUT_TRIGGER.test(t)) {
      return {
        content: `*Delivery* ya *Pickup* — kaunsa prefer karein ge?`,
        nextPhase: "checkout_type",
      };
    }
    // Any modification (add/remove/change) falls through to active cart block below
  }

  // ── Active cart operations (browsing + item_selected + checkout_review) ────
  if (phase === "browsing" || phase === "item_selected" || phase === "checkout_review") {

    // ── Checkout intent — highest priority, before any item/quantity logic ──
    if (CHECKOUT_TRIGGER.test(t)) {
      // If the message also names a valid menu item, add it first then show review
      const _coSegs = t.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
      const _coItems: Array<{ item: { name: string; price: number }; qty: number }> = [];
      const _coSeen = new Set<string>();
      for (const seg of _coSegs) {
        for (const { item, qty } of resolveSegmentItems(seg).items) {
          if (!_coSeen.has(item.name)) {
            _coSeen.add(item.name);
            _coItems.push({ item, qty });
          }
        }
      }
      if (_coItems.length > 0) {
        let _coCart = [...draft.cart];
        const _coLines: string[] = [];
        const _coActions: CartAction[] = [];
        let _coLast: string | undefined;
        for (const { item, qty } of _coItems) {
          const ex = _coCart.find((i) => i.name === item.name);
          if (ex) {
            _coCart = _coCart.map((i) => i.name === item.name ? { ...i, qty: i.qty + qty } : i);
          } else {
            _coCart = [..._coCart, { name: item.name, price: item.price, qty }];
          }
          _coLines.push(`${qty} x ${item.name}`);
          _coActions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
          _coLast = item.name;
        }
        return {
          content: `*Added:*\n${_coLines.join("\n")}\n\n${reviewSummary(_coCart)}`,
          nextPhase: "checkout_review",
          cartActions: _coActions,
          draftPatch: {
            lastItem: _coLast,
            pendingClarifications: [],
            lastCategory: (_coLast ? getItemCategory(_coLast) : null) ?? draft.lastCategory,
          },
        };
      }
      // Pure checkout intent — no valid item in this message
      if (draft.cart.length === 0) {
        return { content: `🛒 Pehle koi item select karein.\n\nMenu browse karein ya item ka naam type karein.` };
      }
      return {
        content: reviewSummary(draft.cart),
        nextPhase: "checkout_review",
      };
    }

    // ── Topping inquiry — add-ons are not orderable via chat ──────────────────
    if (TOPPING_INTENT.test(t)) {
      return {
        content: `Filhal pizza toppings / add-ons order flow mein available nahi hain. Aap menu mein listed pizza items order kar sakte hain.`,
      };
    }

    // Pending "add this item?" confirmation from a hypothetical price query
    if (draft.pendingAdd) {
      const pa = draft.pendingAdd;
      if (/\b(yes|haan|han|ji\b|okay|ok\b|theek|bilkul|zaroor|add kar do|add karo|lagao|dena|chahiye|add it)\b/.test(t)) {
        const existing = draft.cart.find((ci) => ci.name === pa.name);
        const newCart = existing
          ? draft.cart.map((ci) => ci.name === pa.name ? { ...ci, qty: ci.qty + pa.qty } : ci)
          : [...draft.cart, pa];
        return {
          content: `*${pa.name}* (PKR ${pa.price}) added! ✅\n\n${cartSummary(newCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartAction: { op: "add", item: pa },
          draftPatch: { lastItem: pa.name, pendingAdd: undefined, lastCategory: getItemCategory(pa.name) ?? draft.lastCategory },
        };
      }
      if (NEGATIVE_REPLY.test(t)) {
        return {
          content: `Theek hai, add nahi kiya.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          draftPatch: { pendingAdd: undefined },
        };
      }
      // Unrelated message — fall through with pendingAdd cleared via draftPatch on whichever
      // handler fires next (all item-add returns already include pendingAdd: undefined below)
    }

    // Cancel / clear entire cart (may be combined with an add request)
    if (CART_CLEAR.test(t)) {
      // Check whether the same message also contains items to add after clearing
      const _ccSegs = t.split(SEGMENT_SPLIT)
        .map((s) => s.trim()).filter(Boolean);
      const _ccAddSegs = _ccSegs.filter((s) => !CART_CLEAR.test(s) && detectsOrderSignal(s));

      const _ccToAdd: Array<{ item: { name: string; price: number }; qty: number }> = [];
      for (const seg of _ccAddSegs) {
        _ccToAdd.push(...resolveSegmentItems(seg).items);
      }

      if (_ccToAdd.length > 0) {
        // Clear then add — build actions array: clear first, then every add
        const _ccActions: CartAction[] = [{ op: "clear" }];
        const _ccLines: string[] = [];
        let _ccLast: string | undefined;
        const _ccNewCart: CartItem[] = [];

        for (const { item, qty } of _ccToAdd) {
          _ccNewCart.push({ name: item.name, price: item.price, qty });
          _ccLines.push(`${qty} x ${item.name}`);
          _ccActions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
          _ccLast = item.name;
        }

        return {
          content: `Cart clear kar diya gaya. ✅\n\n*Added:*\n${_ccLines.join("\n")}\n\n${cartSummary(_ccNewCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartActions: _ccActions,
          draftPatch: {
            lastItem: _ccLast,
            pendingClarifications: [],
            lastCategory: (_ccLast ? getItemCategory(_ccLast) : null) ?? draft.lastCategory,
          },
        };
      }

      // Pure cart clear — no add items found
      return {
        content: `Aapka current order clear kar diya gaya hai.\n\nAap jab chahein nayi order shuru kar sakte hain. Menu dekhne ke liye item ka naam type karein.`,
        nextPhase: "browsing",
        cartAction: { op: "clear" },
        draftPatch: { lastItem: undefined },
      };
    }

    // "ek aur" / "one more" / "same again" — add 1 to the last touched item
    if (EK_AUR_INTENT.test(t)) {
      const target =
        (draft.lastItem ? draft.cart.find((i) => i.name === draft.lastItem) : undefined) ??
        (draft.cart.length === 1 ? draft.cart[0] : null);
      if (target) {
        const newQty = target.qty + 1;
        const updatedCart = draft.cart.map((i) =>
          i.name === target.name ? { ...i, qty: newQty } : i
        );
        return {
          content: `${target.name} — ${target.qty} se ${newQty} kar diya.\n\n${cartSummary(updatedCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartAction: { op: "update_qty", name: target.name, qty: newQty },
          draftPatch: { lastItem: target.name },
        };
      }
      if (draft.cart.length > 0) {
        const names = draft.cart.map((i) => `• ${i.name}`).join("\n");
        return { content: `Kaunsa item ka quantity badhana hai?\n\n${names}` };
      }
    }

    // ── Multi-action: message has both add and remove segments ──────────────────
    // e.g. "ek small fries add kardo or burger hatado"
    {
      const _maHasAdd = detectsOrderSignal(t);
      if (REMOVE_INTENT.test(t) && _maHasAdd) {
        const _maSegs = t.split(SEGMENT_SPLIT)
          .map((s) => s.trim()).filter(Boolean);
        const _maRemSegs = _maSegs.filter((s) => REMOVE_INTENT.test(s));
        const _maAddSegs = _maSegs.filter((s) => !REMOVE_INTENT.test(s) && detectsOrderSignal(s));

        if (_maRemSegs.length > 0 && _maAddSegs.length > 0) {
          const _maAdds: Array<{ item: { name: string; price: number }; qty: number }> = [];
          const _maRems: CartItem[] = [];
          const _maAddSeen = new Set<string>();
          const _maRemSeen = new Set<string>();

          for (const seg of _maAddSegs) {
            for (const { item, qty } of resolveSegmentItems(seg).items) {
              if (!_maAddSeen.has(item.name)) {
                _maAddSeen.add(item.name);
                _maAdds.push({ item, qty });
              }
            }
          }
          for (const seg of _maRemSegs) {
            const target = findCartItemForRemoval(draft.cart, seg) ??
              (draft.lastItem ? draft.cart.find((i) => i.name === draft.lastItem) : undefined) ??
              (draft.cart.length === 1 ? draft.cart[0] : null);
            if (target && !_maRemSeen.has(target.name)) {
              _maRemSeen.add(target.name);
              _maRems.push(target);
            }
          }

          if (_maAdds.length > 0 || _maRems.length > 0) {
            let _maCrt = [...draft.cart];
            const _maActions: CartAction[] = [];
            const _maLines: string[] = [];
            let _maLast: string | undefined;

            // Removes apply BEFORE adds: "zinger hata do, phir se ek zinger
            // burger de do" (remove zinger, then re-add it) must net to 1
            // zinger, not 0 — applying adds first would let a same-named
            // remove wipe out the item that was just re-added.
            for (const rem of _maRems) {
              _maCrt = _maCrt.filter((i) => i.name !== rem.name);
              _maLines.push(`❌ Removed: ${rem.name}`);
              _maActions.push({ op: "remove", name: rem.name });
            }
            for (const { item, qty } of _maAdds) {
              const ex = _maCrt.find((i) => i.name === item.name);
              if (ex) {
                _maCrt = _maCrt.map((i) => i.name === item.name ? { ...i, qty: i.qty + qty } : i);
              } else {
                _maCrt = [..._maCrt, { name: item.name, price: item.price, qty }];
              }
              _maLines.push(`✅ Added: ${qty} x ${item.name}`);
              _maActions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
              _maLast = item.name;
            }

            const _maPhase = _maCrt.length > 0 ? "item_selected" : "browsing";
            const _maCart = _maCrt.length > 0 ? cartSummary(_maCrt) : "Cart khali hai.";
            const _maTrail = _maCrt.length > 0 ? cartTrail : "";
            return {
              content: `${_maLines.join("\n")}\n\n${_maCart}${_maTrail}`,
              nextPhase: _maPhase,
              cartActions: _maActions,
              draftPatch: {
                lastItem: _maLast ?? (_maCrt.length > 0 ? _maCrt[_maCrt.length - 1].name : undefined),
                pendingClarifications: [],
                lastCategory: (_maLast ? getItemCategory(_maLast) : null) ?? draft.lastCategory,
              },
            };
          }
        }
      }
    }

    // ── Cross-category replacement: "X hata kar Y", "X ki jagah Y de do" ──────
    // Guards against variant-swap messages (those go to isVariantSwapMessage below)
    if (CROSS_REPLACE_TRIGGER.test(t) && !isVariantSwapMessage(t)) {
      const _crM = t.match(CROSS_REPLACE_TRIGGER)!;
      const _crRemovePart = t.slice(0, _crM.index!).trim();
      const _crAddPart    = t.slice(_crM.index! + _crM[0].length).trim();

      // Only proceed when the remove-side has a recognisable food target
      if (_crRemovePart && _crAddPart && namedTargetLabel(_crRemovePart) !== null) {
        const _crRemoveItem  = findCartItemForRemoval(draft.cart, _crRemovePart);
        const _crAddMenuItem = findMenuItem(_crAddPart, 1);
        const _crRemoveLabel = namedTargetLabel(_crRemovePart) ?? _crRemovePart;

        if (!_crRemoveItem) {
          return {
            content: `Maaf kijiye, aapki current cart mein *${_crRemoveLabel}* maujood nahi hai. Replacement karne ke liye pehle woh item cart mein hona chahiye.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          };
        }

        if (!_crAddMenuItem) {
          const _crAddLabel = getFoodKeywords(_crAddPart)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ") || _crAddPart;
          return {
            content: `Maaf kijiye, *${_crAddLabel}* hamare menu mein available nahi hai. Is liye replacement complete nahi ho sakti.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          };
        }

        // Both valid — execute the replacement
        const _crQty = parseQty(_crAddPart) || 1;
        const _crNewCart = draft.cart
          .filter((i) => i.name !== _crRemoveItem.name)
          .concat([{ name: _crAddMenuItem.name, price: _crAddMenuItem.price, qty: _crQty }]);
        return {
          content: `*${_crRemoveItem.name}* hataya aur *${_crAddMenuItem.name}* (PKR ${_crAddMenuItem.price}) add kar diya. ✅\n\n${cartSummary(_crNewCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartActions: [
            { op: "remove", name: _crRemoveItem.name },
            { op: "add", item: { name: _crAddMenuItem.name, price: _crAddMenuItem.price, qty: _crQty } },
          ],
          draftPatch: {
            lastItem: _crAddMenuItem.name,
            pendingClarifications: [],
            lastCategory: getItemCategory(_crAddMenuItem.name) ?? draft.lastCategory,
          },
        };
      }
    }

    // Multiple distinct items removed by name in one message —
    // "zinger hata do aur pasta bhi hata do". Only takes over when 2+ DIFFERENT
    // cart items are each independently named and resolved; a single shared
    // target (or a vague phrase) falls through to the single-item handler below
    // unchanged.
    if (REMOVE_INTENT.test(t)) {
      const _mrSegs = t.split(SEGMENT_SPLIT)
        .map((s) => s.trim()).filter(Boolean);
      if (_mrSegs.length > 1) {
        const _mrTargets: CartItem[] = [];
        const _mrSeen = new Set<string>();
        for (const seg of _mrSegs) {
          if (!REMOVE_INTENT.test(seg) && namedTargetLabel(seg) === null) continue;
          const found = findCartItemForRemoval(draft.cart, seg);
          if (found && !_mrSeen.has(found.name)) {
            _mrSeen.add(found.name);
            _mrTargets.push(found);
          }
        }
        if (_mrTargets.length > 1) {
          const remaining = draft.cart.filter((i) => !_mrSeen.has(i.name));
          const note = remaining.length > 0 ? cartTrail : "";
          return {
            content: `${_mrTargets.map((i) => i.name).join(", ")} remove kar diye gaye.\n\n${remaining.length > 0 ? cartSummary(remaining) : "Cart khali hai."}${note}`,
            nextPhase: remaining.length > 0 ? "item_selected" : "browsing",
            cartActions: _mrTargets.map((i) => ({ op: "remove" as const, name: i.name })),
            draftPatch: { lastItem: remaining[remaining.length - 1]?.name },
          };
        }
      }
    }

    // Remove intent — "ek hata do" reduces by 1, "pasta hata do" removes entirely
    if (REMOVE_INTENT.test(t)) {
      const byQty = hasReduceQty(t);
      const reduceAmt = byQty ? parseQty(t) : 0;

      const _remLabel = namedTargetLabel(t);
      let target: CartItem | null;
      if (_remLabel !== null) {
        // Customer named a specific item/category — only act if it is actually in the cart
        target = findCartItemForRemoval(draft.cart, t);
        if (!target) {
          return {
            content: `Maaf kijiye, aapki current cart mein *${_remLabel}* maujood nahi hai, is liye remove nahi kiya ja sakta.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          };
        }
      } else {
        // Vague phrase ("isko hata do", "ye hata do", "ek hata do") — allow context fallbacks
        target =
          findCartItemForRemoval(draft.cart, t) ??
          (draft.lastItem ? draft.cart.find((i) => i.name === draft.lastItem) : undefined) ??
          (draft.cart.length === 1 ? draft.cart[0] : null);
      }

      if (!target) {
        const names = draft.cart.map((i) => i.name).join(", ");
        return { content: `Kaunsa item remove ya kam karna hai?\nCart: ${names || "khali hai"}.` };
      }

      if (byQty) {
        const newQty = target.qty - reduceAmt;
        if (newQty <= 0) {
          const remaining = draft.cart.filter((i) => i.name !== target.name);
          const note = remaining.length > 0 ? cartTrail : "";
          return {
            content: `${target.name} remove ho gaya.\n\n${remaining.length > 0 ? cartSummary(remaining) : "Cart khali hai."}${note}`,
            nextPhase: remaining.length > 0 ? "item_selected" : "browsing",
            cartAction: { op: "remove", name: target.name },
            draftPatch: { lastItem: remaining[remaining.length - 1]?.name },
          };
        }
        const updatedCart = draft.cart.map((i) => i.name === target.name ? { ...i, qty: newQty } : i);
        return {
          content: `${target.name} — ${target.qty} se ${newQty} kar diya.\n\n${cartSummary(updatedCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartAction: { op: "reduce", name: target.name, by: reduceAmt },
          draftPatch: { lastItem: target.name },
        };
      }

      // Remove entire item
      const remaining = draft.cart.filter((i) => i.name !== target.name);
      const note = remaining.length > 0 ? cartTrail : "";
      return {
        content: `${target.name} remove kar diya gaya.\n\n${remaining.length > 0 ? cartSummary(remaining) : "Cart khali hai."}${note}`,
        nextPhase: remaining.length > 0 ? "item_selected" : "browsing",
        cartAction: { op: "remove", name: target.name },
        draftPatch: { lastItem: remaining[remaining.length - 1]?.name },
      };
    }

    // Variant/size correction — "small nahi large", "jumbo kar do", "large kar do", "red sauce"
    // Only meaningful when there's actually something to swap — an empty cart with
    // no lastItem means "ek pizza large kar do" is a fresh ORDER ("[give me] a
    // large one"), not a size correction, and should fall through to Add items.
    // Also skipped when the message carries enough of its OWN identifying words to
    // resolve to one complete, specific item on its own ("ek alfredo pasta white
    // sauce chahiye") — that's a fresh, fully-specified order that happens to
    // contain a variant word ("white sauce"), not a vague "change the sauce"
    // instruction. Without this, ordering Alfredo/Mexican/Macaroni Pasta while
    // anything else is already in the cart would get silently REJECTED ("Pasta
    // maujood nahi hai") instead of added, because the variant-swap logic only
    // looks for an existing pasta item to modify and finds none.
    // Whether the message ALSO fully self-resolves to one complete, specific
    // item on its own ("ek alfredo pasta white sauce chahiye" — unambiguous
    // even with zero cart context). Only consulted below at the rejection
    // point, NOT as a blanket precondition — a blanket precondition would
    // also wrongly suppress a GENUINE swap like "pasta large kar do" with
    // Pasta Small already in the cart, since "pasta large" itself resolves to
    // a complete real item too.
    const _vsSelfContained = getFoodKeywords(t).length > 1 && strictMatchSegment(t).ok;
    if (isVariantSwapMessage(t) && (draft.cart.length > 0 || draft.lastItem)) {
      // Determine the swap source: prefer the cart item the customer explicitly named
      const _vsKws = getFoodKeywords(t);
      const _vsCatWord = _vsKws.find((w) => CATEGORY_ONLY.has(w));
      const _vsSingle  = _vsKws.find((w) => w in SINGLE_DEFAULTS);
      let _vsSource = draft.lastItem;
      let _vsSkip = false;

      if (_vsCatWord) {
        const _vsCatKey = getCategoryKey(_vsCatWord);
        const _vsCatItem = _vsCatKey
          ? draft.cart.find((i) => MENU[_vsCatKey].items.some((m) => m.name === i.name))
          : null;
        if (_vsCatItem) {
          _vsSource = _vsCatItem.name;
        } else if (_vsSelfContained) {
          // Nothing in that category to swap FROM, but the message is a
          // complete fresh order on its own — fall through to Add items
          // instead of rejecting (don't set _vsSource; let the swap lookup
          // below find nothing and cascade naturally).
          _vsSkip = true;
        } else {
          // Customer named a category that's not in the cart — reject the action
          const _vsLabel = _vsCatWord.charAt(0).toUpperCase() + _vsCatWord.slice(1);
          return {
            content: `Maaf kijiye, aapki current cart mein *${_vsLabel}* maujood nahi hai, is liye update nahi kiya ja sakta.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          };
        }
      } else if (_vsSingle) {
        const _vsExact = draft.cart.find((i) => i.name === SINGLE_DEFAULTS[_vsSingle]);
        if (_vsExact) _vsSource = _vsExact.name;
      }

      const swap = _vsSkip ? null : findVariantSwap(t, _vsSource, draft.cart);
      if (swap) {
        const newCart = draft.cart
          .filter((i) => i.name !== swap.fromName)
          .concat([{ name: swap.to.name, price: swap.to.price, qty: swap.qty }]);
        return {
          content: `*${swap.fromName}* updated to *${swap.to.name}*.\n\n${cartSummary(newCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartActions: [
            { op: "remove", name: swap.fromName },
            { op: "add", item: { name: swap.to.name, price: swap.to.price, qty: swap.qty } },
          ],
          draftPatch: { lastItem: swap.to.name },
        };
      }
    }

    // Full item replacement within same category — "Smoke Burger kar do", "Chicken chowmein kar do"
    // Fires ONLY when isVariantSwapMessage didn't already handle it
    if (!isVariantSwapMessage(t)) {
      const replacement = findCategoryReplacement(t, draft.lastItem, draft.lastCategory, draft.cart);
      if (replacement) {
        const newCart = draft.cart
          .filter((i) => i.name !== replacement.from.name)
          .concat([{ name: replacement.to.name, price: replacement.to.price, qty: replacement.from.qty }]);
        return {
          content: `*${replacement.from.name}* ki jagah *${replacement.to.name}* (PKR ${replacement.to.price}) kar diya.\n\n${cartSummary(newCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartActions: [
            { op: "remove", name: replacement.from.name },
            { op: "add", item: { name: replacement.to.name, price: replacement.to.price, qty: replacement.from.qty } },
          ],
          draftPatch: {
            lastItem: replacement.to.name,
            lastCategory: getItemCategory(replacement.to.name) ?? draft.lastCategory,
          },
        };
      }
    }

    // Soft decline — isVariantSwapMessage guard prevents "small nahi large" triggering this.
    // Also skipped when the message clearly carries its own order signal elsewhere
    // ("...kuch nahi khaya, please ek hot shot...") — a stray "nahi" inside a
    // rant/backstory shouldn't swallow a perfectly normal order that follows it.
    if (NEGATIVE_REPLY.test(t) && !CHECKOUT_TRIGGER.test(t) && !isVariantSwapMessage(t) && !hasResolvableItem(t)) {
      if (draft.cart.length > 0) {
        return {
          content: `Theek hai!\n\n${cartSummary(draft.cart)}${cartTrail}`,
        };
      }
      return {
        content: `Koi baat nahi. Jab bhi order dena ho, main yahaan hoon!`,
      };
    }

    // Standalone affirmative with active cart — "haan", "ok", "ji", "theek hai"
    // Prevents these from falling through to confusing informational handlers
    if (/^\s*(haan|han|yes|okay|ok|ji|g|bilkul|theek|theek hai|thik hai|sure|done|acha|achha)\s*[!.]*\s*$/.test(t) && draft.cart.length > 0) {
      return {
        content: `${cartSummary(draft.cart)}${cartTrail}`,
      };
    }

    // Quantity update — "3 kar do", "Quantity 5 kar do", "2 ki jagah 4"
    // Skipped when add-intent is present (e.g. "add kar do"), except "ki jagah" always wins.
    // Also skipped on an empty cart with no lastItem — there's nothing TO
    // update, so a fresh multi-item order that merely ends in an imperative
    // "kar do" ("2 zinger 2 pasta 2 chowmein kardo") must not be misread as a
    // quantity-update instruction and rejected as "item not in cart".
    if (
      UPDATE_QTY_INTENT.test(t) &&
      (!ORDER_INTENT.test(t) || /ki jagah/.test(t)) &&
      (draft.cart.length > 0 || draft.lastItem)
    ) {
      const _uqLabel = namedTargetLabel(t);
      let target: CartItem | null;
      if (_uqLabel !== null) {
        // Customer named a specific item/category — only act if it is in the cart
        target = findCartItemForRemoval(draft.cart, t);
        if (!target) {
          return {
            content: `Maaf kijiye, aapki current cart mein *${_uqLabel}* maujood nahi hai, is liye update nahi kiya ja sakta.\n\n${cartSummary(draft.cart)}${cartTrail}`,
          };
        }
      } else {
        // Vague — allow context fallbacks
        target =
          findInCart(draft.cart, t) ??
          (draft.lastItem ? draft.cart.find((i) => i.name === draft.lastItem) : undefined) ??
          (draft.cart.length === 1 ? draft.cart[0] : null);
      }

      if (target) {
        // Use only REAL quantity digits (excludes size/count numbers baked into
        // the item's own name, like "12 inch" or "8 pcs") — otherwise updating
        // the quantity of e.g. "Hot Shot 8 pcs with fries" picks up its own "8"
        // instead of the customer's stated new quantity.
        const nums = realQtyDigits(t);
        let newQty: number;
        if (/ki jagah/.test(t)) {
          newQty = nums.length >= 2 ? nums[1] : nums.length === 1 ? nums[0] : parseQty(t);
        } else {
          newQty = nums.length > 0 ? nums[nums.length - 1] : parseQty(t);
        }
        if (newQty < 1) newQty = 1;
        const updatedCart = draft.cart.map((i) => i.name === target.name ? { ...i, qty: newQty } : i);
        return {
          content: `Quantity updated.\n\n${cartSummary(updatedCart)}${cartTrail}`,
          nextPhase: "item_selected",
          cartAction: { op: "update_qty", name: target.name, qty: newQty },
          draftPatch: { lastItem: target.name },
        };
      }
    }

    // Hypothetical price query — "Agar ek Zinger add karun to total kya hoga?"
    // Calculate preview WITHOUT touching the cart, then ask for confirmation
    if (HYPOTHETICAL_INTENT.test(t) && draft.cart.length > 0) {
      const cleaned = t
        .replace(/\b(agar|agr|if\b|add karun|add karo|add karoon|add krun|to\b|total|kia|kya|hoga|hongy|price|kitna)\b/gi, " ")
        .replace(/\s+/g, " ").trim();
      const hypoItem = findMenuItem(cleaned, 1);
      if (hypoItem) {
        const qty = parseQty(t) || 1;
        const currentTotal = draft.cart.reduce((s, i) => s + i.price * i.qty, 0);
        const newTotal = currentTotal + hypoItem.price * qty;
        return {
          content: `*Agar ${qty} x ${hypoItem.name} add karein:*\n\nAbhI ka total: PKR ${currentTotal}\n+ ${qty} x ${hypoItem.name}: PKR ${hypoItem.price * qty}\n*Estimated Total: PKR ${newTotal}*\n\nKya aap *${hypoItem.name}* add karna chahenge?`,
          draftPatch: { pendingAdd: { name: hypoItem.name, price: hypoItem.price, qty } },
        };
      }
    }

    // Context-aware price selection — "500 wala", "PKR 600", "700 ka item"
    // Only fires when lastCategory is set and no other food item name is present
    const priceReq = extractPriceRequest(t);
    if (priceReq !== null && draft.lastCategory) {
      const textWithoutPrice = t.replace(/\bpkr\s*\d+\b|\brs\.?\s*\d+\b|\b\d{3,4}\s*(?:wala|wali|ka\b|ki\b|da\b)?\b/gi, "").trim();
      if (getFoodKeywords(textWithoutPrice).length === 0) {
        const catKey = getCategoryKey(draft.lastCategory);
        if (catKey) {
          const matches = (MENU[catKey] as { items: { name: string; price: number }[] }).items.filter(
            (i) => i.price === priceReq
          );
          if (matches.length === 1) {
            const item = matches[0];
            const qty = parseQty(textWithoutPrice) || 1;
            const existing = draft.cart.find((ci) => ci.name === item.name);
            const newCart = existing
              ? draft.cart.map((ci) => ci.name === item.name ? { ...ci, qty: ci.qty + qty } : ci)
              : [...draft.cart, { name: item.name, price: item.price, qty }];
            return {
              content: `*${item.name}* (PKR ${item.price}) added! ✅\n\n${cartSummary(newCart)}${cartTrail}`,
              nextPhase: "item_selected",
              cartAction: { op: "add", item: { name: item.name, price: item.price, qty } },
              draftPatch: { lastItem: item.name, lastCategory: draft.lastCategory },
            };
          } else if (matches.length > 1) {
            return {
              content: `PKR ${priceReq} mein yeh options available hain:\n\n${matches.map((i) => `• *${i.name}* — PKR ${i.price}`).join("\n")}\n\nAap in mein se kaunsa order karna chahenge?`,
              draftPatch: { lastCategory: draft.lastCategory },
            };
          } else {
            return {
              content: `Is category mein PKR ${priceReq} ka koi item available nahi hai.\n\nAvailable options:\n\n${listCategoryItems(draft.lastCategory)}`,
              draftPatch: { lastCategory: draft.lastCategory },
            };
          }
        }
      }
    }

    // Add items — strict matching, single or multi-item in one message
    // Budget/group queries carry digits but are inquiries, not order attempts —
    // let them fall through to the dedicated handler near the bottom instead of
    // being swallowed here as "unavailable items".
    const hasOrderSignal = detectsOrderSignal(t) && !BUDGET_QUERY.test(t);

    if (hasOrderSignal) {
      const segments = t.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
      const toAdd: Array<{ item: { name: string; price: number }; qty: number }> = [];
      const errors: SegmentFailure[] = [];
      const seen = new Set<string>();

      for (const seg of segments) {
        const { items, errors: segErrors } = resolveSegmentItems(seg);
        for (const { item, qty } of items) {
          if (!seen.has(item.name)) {
            seen.add(item.name);
            toAdd.push({ item, qty });
          }
        }
        // Push every error from this segment, even when it ALSO produced
        // resolved items — "2 zinger 2 pasta" must add the zinger AND still
        // ask about pasta, not drop the pasta clarification just because the
        // zinger half of the same segment succeeded.
        errors.push(...segErrors);
      }

      // Helper: human-readable label from a term
      const itemLabel = (term: string) =>
        getFoodKeywords(term).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || term.trim();

      if (toAdd.length > 0) {
        let newCart = [...draft.cart];
        const addedLines: string[] = [];
        const actions: CartAction[] = [];
        let lastAddedName: string | undefined;

        for (const { item, qty } of toAdd) {
          const existing = newCart.find((i) => i.name === item.name);
          if (existing) {
            newCart = newCart.map((i) => i.name === item.name ? { ...i, qty: i.qty + qty } : i);
          } else {
            newCart = [...newCart, { name: item.name, price: item.price, qty }];
          }
          addedLines.push(`${qty} x ${item.name}`);
          actions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
          lastAddedName = item.name;
        }

        // Separate truly unavailable (off-menu) from clarifications (ambiguous
        // — either a whole category like "pasta" or a narrower item family
        // like "zinger")
        const unavailErrs = errors.filter((e) => e.reason === "off_menu");
        const ambigErrs   = errors.filter((e): e is AmbiguousFailure => e.reason === "ambiguous");

        let content = `*Added:*\n${addedLines.join("\n")}`;

        if (unavailErrs.length > 0) {
          content += `\n\n*Unavailable:*\n${unavailErrs.map((e) => `• ${itemLabel(e.term)}`).join("\n")}`;
        }

        if (ambigErrs.length > 0) {
          for (const err of ambigErrs) {
            content += `\n\n*${ambigLabel(err)} ke liye options:*\n${ambigOptionsBlock(err)}`;
          }
          const labels = ambigErrs.map((e) => `*${ambigLabel(e)}*`).join(" aur ");
          content += `\n\nAap ${labels} mein se kaunsa option select karna chahenge?`;
        } else {
          content += `\n\n${cartSummary(newCart)}${cartTrail}`;
        }

        const pendingFromAmbigsA = ambigErrs.map(ambigPendingClarification);

        return {
          content,
          nextPhase: "item_selected",
          cartActions: actions,
          draftPatch: {
            lastItem: lastAddedName,
            pendingClarifications: pendingFromAmbigsA.length > 0 ? pendingFromAmbigsA : [],
            lastCategory: (lastAddedName ? getItemCategory(lastAddedName) : null) ??
              (ambigErrs.length > 0 ? ambigErrs[0].category : undefined) ??
              draft.lastCategory,
          },
        };
      }

      // Nothing valid to add — all errors
      if (errors.length > 0) {
        const unavailErrs = errors.filter((e) => e.reason === "off_menu");
        const ambigErrs   = errors.filter((e): e is AmbiguousFailure => e.reason === "ambiguous");

        const pendingFromAmbigs = ambigErrs.map(ambigPendingClarification);

        // Pure clarifications — no unavailable items
        if (ambigErrs.length > 0 && unavailErrs.length === 0) {
          if (ambigErrs.length === 1) {
            return {
              content: ambigFullPrompt(ambigErrs[0]),
              draftPatch: { pendingClarifications: pendingFromAmbigs, lastCategory: ambigErrs[0].category },
            };
          }
          let content = "";
          for (const err of ambigErrs) {
            content += (content ? "\n\n" : "") + `*${ambigLabel(err)} ke liye options:*\n${ambigOptionsBlock(err)}`;
          }
          const labels = ambigErrs.map((e) => `*${ambigLabel(e)}*`).join(" aur ");
          content += `\n\nAap ${labels} mein se kaunsa option select karna chahenge?`;
          return { content, draftPatch: { pendingClarifications: pendingFromAmbigs, lastCategory: ambigErrs[0].category } };
        }

        // Single off-menu item: check UNAVAIL_MAP first for a targeted response
        if (errors.length === 1) {
          const err = errors[0];
          const label = itemLabel(err.term);
          for (const entry of UNAVAIL_MAP) {
            if (entry.pattern.test(err.term)) return { content: entry.alts };
          }
          if (err.reason === "ambiguous") {
            return {
              content: ambigFullPrompt(err),
              draftPatch: { pendingClarifications: pendingFromAmbigs, lastCategory: err.category },
            };
          }
          // Smart suggestion: if there's a close match inside the category, offer it via pendingAdd
          if (err.category) {
            const suggestion = findItemForCategory(err.term, err.category);
            if (suggestion) {
              const catLabel = err.category.charAt(0).toUpperCase() + err.category.slice(1);
              return {
                content: `*${label}* hamare menu mein exact name se listed nahi hai, lekin *${catLabel}* mein *${suggestion.name}* (PKR ${suggestion.price}) available hai.\n\nKya main 1 x *${suggestion.name}* add kar doon?`,
                draftPatch: { pendingAdd: { name: suggestion.name, price: suggestion.price, qty: 1 }, lastCategory: err.category },
              };
            }
          }
          return {
            content: err.category
              ? `*${label}* current menu mein available nahi hai.\nAap menu mein se available items order kar sakte hain.\n\n${categoryOptions(err.category)}`
              : `*${label}* current menu mein available nahi hai.\n\nPlease Think Food menu mein se order karein.`,
          };
        }

        // Multiple errors — mix of unavailable + possibly some ambiguous
        let content = "";
        if (unavailErrs.length > 0) {
          content += `*Unavailable:*\n${unavailErrs.map((e) => `• ${itemLabel(e.term)}`).join("\n")}`;
        }
        if (ambigErrs.length > 0) {
          for (const err of ambigErrs) {
            content += (content ? "\n\n" : "") + `*${ambigLabel(err)} ke liye options:*\n${ambigOptionsBlock(err)}`;
          }
          const labels = ambigErrs.map((e) => `*${ambigLabel(e)}*`).join(" aur ");
          content += `\n\nAap ${labels} mein se kaunsa option select karna chahenge?`;
          return { content, draftPatch: { pendingClarifications: pendingFromAmbigs, lastCategory: ambigErrs[0].category } };
        }
        content += `\n\nYeh items Think Food menu mein available nahi hain.\nPlease menu mein se available items order karein.`;
        return { content };
      }
    }

    // checkout_review fallback — nothing matched above, re-show review summary
    if (phase === "checkout_review") {
      return { content: reviewSummary(draft.cart) };
    }
  }

  // ── Browsing: informational ────────────────────────────────────────────────

  // Greeting
  if (/^(hi|hello|hey|salam|salaam|assalam|hola|yo)\b/.test(t)) {
    return {
      content: `👋 *Welcome to Think Food!*\n\nI'm your AI sales assistant. How can I help you today?\n\n📋 Browse our menu\n🛒 Place an order\n📍 Restaurant info`,
    };
  }

  // Unavailable items — targeted alternatives via UNAVAIL_MAP
  for (const entry of UNAVAIL_MAP) {
    if (entry.pattern.test(t)) {
      return { content: entry.alts };
    }
  }

  // Budget query — with group support
  if (BUDGET_QUERY.test(t)) {
    const peopleMatch = t.match(/(\d+)\s*(log|banda|bande|logon|people|person)/);
    const numPeople = peopleMatch ? parseInt(peopleMatch[1]) : 1;
    const budgetMatch = t.match(/\b(\d{3,5})\b/);
    const rawBudget = budgetMatch ? parseInt(budgetMatch[1]) : 0;

    // Group with no budget — suggest sharing options
    if (numPeople > 1 && rawBudget === 0) {
      return {
        content: `*${numPeople} logon ke liye* best options:\n\n🍕 *Pizza Large 12 inch* — PKR 1,200 (share karne ke liye perfect)\n🍔 *Zinger Burger* × ${numPeople} — PKR ${500 * numPeople}\n🍝 *Pasta Large* × ${numPeople} — PKR ${600 * numPeople}\n🍚 *Singaporean Rice* × ${numPeople} — PKR ${700 * numPeople}\n\nBudget bhi batayein — aur precise suggest kar sakta hoon!`,
      };
    }

    const budget = rawBudget;
    const perPerson = numPeople > 1 ? Math.floor(budget / numPeople) : budget;
    const groupNote = numPeople > 1 ? ` (${numPeople} log — PKR ${perPerson} per person)` : "";

    if (budget > 0 && perPerson < 400) {
      return {
        content: `PKR ${budget}${groupNote} mein unfortunately koi item nahi milega.\n\nHamare lowest:\n• Vegetable Rice — PKR 400\n• Chicken Fried Rice — PKR 450\n• Club Sandwich / Pasta Small / Zinger Burger — PKR 500`,
      };
    }
    if (perPerson <= 500) {
      return {
        content: `PKR ${budget}${groupNote} ke liye best picks:\n\n🍚 *Vegetable Rice* — PKR 400\n🍚 *Chicken Fried Rice* — PKR 450\n🥪 *Club Sandwich* — PKR 500\n🍝 *Pasta Small* — PKR 500\n🍔 *Zinger Burger* — PKR 500\n\nSabse value-for-money options!`,
      };
    }
    if (perPerson <= 750) {
      const pizzaNote = numPeople > 1 && budget >= 1200 ? `\n🍕 *Pizza Large 12 inch* — PKR 1,200 _(${numPeople} logon mein share karein — best value!)_` : "";
      return {
        content: `PKR ${budget}${groupNote} ke liye best picks:\n\n🍔 *Think Food SP Burger* — PKR 550 _(house special)_\n🥪 *Grill Sandwich* — PKR 650\n🍚 *Singaporean Rice* — PKR 700 _(best-seller)_\n🍕 *Pizza Small 6 inch* — PKR 550${pizzaNote}\n\nKoi bhi choose karein — sab zabardast hain!`,
      };
    }
    return {
      content: `PKR ${budget}${groupNote} mein premium options:\n\n🥩 *Chicken Steak* — PKR 950 _(menu ka crown jewel)_\n🍕 *Pizza Regular 9 inch* — PKR 850\n🍕 *Think Food Special Pizza* — PKR 1,500 _(must try!)_\n🍝 *Alfredo Pasta white sauce* — PKR 850\n🍗 *Hot Shot 8 pcs with fries* — PKR 800\n\n${numPeople > 1 ? `${numPeople} logon ke liye *Think Food Special Pizza* share karna best value hoga!` : "Koi bhi choose karein — hum recommend karte hain Chicken Steak!"}`,
    };
  }

  // Comparison — "Jumbo ya Zinger", "Rice ya Chowmein", "Pizza Regular ya Large"
  if (/\b(ya|or|versus|vs)\b/.test(t)) {
    const parts = t.split(/\s+(?:ya|or|versus|vs)\s+/);
    if (parts.length >= 2) {
      const itemA = findMenuItem(parts[0].trim(), 1);
      const itemB = findMenuItem(parts[parts.length - 1].trim(), 1);
      if (itemA && itemB && itemA.name !== itemB.name) {
        const diff = Math.abs(itemA.price - itemB.price);
        const cheaper = itemA.price <= itemB.price ? itemA : itemB;
        const pricier = itemA.price <= itemB.price ? itemB : itemA;
        const verdict =
          diff === 0
            ? `Dono same price par hain — taste ke hisaab se choose karein.`
            : `PKR ${diff} ka farq hai. *${cheaper.name}* budget-friendly hai, jabke *${pricier.name}* thoda bada/premium hai.`;
        return {
          content: `📊 *Comparison*\n\n🔹 *${itemA.name}* — PKR ${itemA.price}\n🔸 *${itemB.name}* — PKR ${itemB.price}\n\n${verdict}\n\nKaunsa order karein?`,
        };
      }
      // Category-level comparison
      const isRice = (s: string) => /(rice|chawal)/.test(s);
      const isNoodles = (s: string) => /(noodles?|chowmein|chow mein)/.test(s);
      if ((isRice(parts[0]) && isNoodles(parts[1])) || (isNoodles(parts[0]) && isRice(parts[1]))) {
        return {
          content: `📊 *Rice vs Noodles*\n\n🍚 *Rice* — from PKR 400\n• Vegetable Rice — PKR 400\n• Chicken Fried Rice — PKR 450\n• Singaporean Rice — PKR 700 _(best-seller)_\n\n🍜 *Noodles* — from PKR 600\n• Vegetable Chowmein — PKR 600\n• Chicken Chowmein — PKR 650\n\nRice mein zyada variety aur better value hai. *Singaporean Rice* sabse popular option hai!`,
        };
      }
    }
  }

  // Full menu — only when no specific category keyword is present, or customer explicitly asks for full/all menu
  const hasCategoryWord = /\b(burger|zinger|jumbo|pizza|pasta|rice|noodles|chowmein|sandwich|roll|steak|starter|starters|strips|hot shot|fries|macaroni|alfredo)\b/.test(t);
  if (
    /\b(full menu|complete menu|poora menu|all items|sabhi items)\b/.test(t) ||
    // NOTE: bare "kya hai" is deliberately NOT a trigger here — it's an
    // extremely common, generic Roman Urdu question particle ("aapka number
    // kya hai", "yeh kya hai") that would otherwise hijack unrelated
    // questions into showing the full menu. Only menu-specific phrasings count.
    /\b(what (do you have|you have|is available)|aap ke paas kya hai|paas kya hai|kya kya hai|kya milta hai|kya milta)\b/.test(t) ||
    (!hasCategoryWord && /\bmenu\b/.test(t))
  ) {
    return {
      content: `📋 *Think Food — Full Menu*\n\n${fmt("burgers")}\n\n${fmt("sandwiches")}\n\n${fmt("pizza")}\n\n${fmt("pizzaFries")}\n\n${fmt("rolls")}\n\n${fmt("pasta")}\n\n${fmt("noodles")}\n\n${fmt("rice")}\n\n${fmt("starters")}\n\n${fmt("steaks")}\n\n${fmt("toppings")}\n\nType any item name to order!`,
    };
  }

  // Burgers
  if (/\b(burger|zinger|jumbo|smoke burger|spicy stuff)\b/.test(t)) {
    return {
      content: `🍔 *Burger Menu*\n\n${fmt("burgers")}\n\n_Our *Think Food SP Burger* (PKR 550) is the house special!_\n\nItem ka naam type karein order karne ke liye.`,
      draftPatch: { lastCategory: "burger" },
    };
  }

  // Pizza Fries — must come before pizza so "pizza fries" is not caught by the pizza handler
  if (/\b(pizza fries)\b/.test(t) || (/\bfries\b/.test(t) && !/\b(strips|hot shot)\b/.test(t))) {
    return {
      content: `🍟 *Pizza Fries:*\n\n${fmt("pizzaFries")}\n\nAap small box lena chahenge ya large box?`,
      draftPatch: { lastCategory: "fries" },
    };
  }

  // Pizza
  if (/\b(pizza)\b/.test(t)) {
    return {
      content: `🍕 *Pizza Menu*\n\n${fmt("pizza")}\n\n_Try our *Think Food Special Pizza* — the house favourite at PKR 1,500!_`,
      draftPatch: { lastCategory: "pizza" },
    };
  }

  // Rice
  if (/(rice|chawal|singaporean)/.test(t)) {
    return {
      content: `🍚 *Rice Menu*\n\n${fmt("rice")}\n\n_Our *Singaporean Rice* (PKR 700) is a best-seller!_`,
      draftPatch: { lastCategory: "rice" },
    };
  }

  // Noodles
  if (/(noodles?|chowmein|chow\s+mein)/.test(t)) {
    return { content: `🍜 *Noodles Menu*\n\n${fmt("noodles")}`, draftPatch: { lastCategory: "chowmein" } };
  }

  // Pasta
  if (/(pasta|macaroni|alfredo)/.test(t)) {
    return { content: `🍝 *Pasta Menu*\n\n${fmt("pasta")}`, draftPatch: { lastCategory: "pasta" } };
  }

  // Chinese catch-all
  if (/\b(chinese)\b/.test(t)) {
    return {
      content: `🍜 *Chinese Menu*\n\n${fmt("noodles")}\n\n${fmt("rice")}\n\n${fmt("pasta")}\n\n_Our *Singaporean Rice* (PKR 700) is a crowd favourite!_`,
    };
  }

  // Sandwich
  if (/\b(sandwich|sandwiches)\b/.test(t)) {
    return {
      content: `🥪 *Sandwich Menu*\n\n${fmt("sandwiches")}\n\n_Our *Grill Sandwich* (PKR 650) is loaded with flavour!_`,
      draftPatch: { lastCategory: "sandwich" },
    };
  }

  // Roll / Wrap
  if (/\b(roll|wrap|gyro)\b/.test(t)) {
    return { content: `🌯 *Roll*\n\n${fmt("rolls")}`, draftPatch: { lastCategory: "roll" } };
  }

  // Starters
  if (/\b(starters?|strips|hot shot)\b/.test(t)) {
    return {
      content: `🍗 *Starters:*\n\n${fmt("starters")}`,
      draftPatch: { lastCategory: "starter" },
    };
  }

  // Steak (normalization converts "steaks" → "steak" before this check)
  if (/\b(steak)\b/.test(t)) {
    return { content: `🥩 *Steaks:*\n\n${fmt("steaks")}`, draftPatch: { lastCategory: "steak" } };
  }

  // Recommendation
  if (/\b(recommend|suggest|popular|best|what.*try|favourite|favorite|kya lena chahiye|kya mangwao|kya order karoon)\b/.test(t)) {
    return {
      content: `⭐ *Think Food — Top Picks*\n\n🥇 *Think Food SP Burger* — PKR 550\n_House special. Most ordered burger._\n\n🥈 *Singaporean Rice* — PKR 700\n_Rich, loaded with chicken. Best-seller._\n\n🥉 *Think Food Special Pizza* — PKR 1,500\n_Go-to for groups. Absolutely worth it._\n\n🍗 *Chicken Strips 6 pcs with fries* — PKR 750\n_Crispy, filling, crowd favourite._\n\n🥩 *Chicken Steak* — PKR 950\n_Grilled perfection. Hearty meal._\n\nKoi bhi naam type karein — order ready in seconds!`,
    };
  }

  // No deals
  if (/\b(combo|deal|today|aaj ka|special offer|offer)\b/.test(t)) {
    return {
      content: `Think Food ke paas koi official deal ya fixed combo nahi hai.\n\nAap menu se apni pasand ke items choose kar sakte hain:\n\n🍔 Burgers — from PKR 500\n🍕 Pizza — from PKR 550\n🥪 Sandwiches — from PKR 500`,
    };
  }

  // Location / address / branch
  if (/\b(address|location|kahan|located|branch|shop|maps?|directions?|bhej do|send karo|restaurant ka address|branch address)\b/.test(t)) {
    return {
      content: `📍 *Think Food Location:*\n\n${INFO.address}\n\n🗺️ *Google Maps:*\n${INFO.mapsUrl}\n\nYou can visit us between *${INFO.timing}*.`,
    };
  }

  // Delivery charges
  if (/\b(delivery charge|delivery fee|delivery ka charge|delivery cost|delivery kitne|delivery charges|charge kitna)\b/.test(t)) {
    return {
      content: `🚚 *Delivery Charges:* PKR ${INFO.deliveryFee}\n\nDelivery charges may vary based on distance if restaurant policy changes in future.`,
    };
  }

  // Delivery time
  if (/\b(delivery time|kitne time|kitni der|kitne minutes|how long|how many minutes|order time|deliver hoga|lagegi|lagega|estimated)\b/.test(t)) {
    return {
      content: `⏱️ *Estimated Delivery Time:* ${INFO.deliveryTime} after order confirmation.\n\nAapka order pehle *Pending Verification* mein jaega. Hamare staff aapko confirm karne ke liye call karein ge, phir preparation aur delivery shuru hogi.`,
    };
  }

  // General restaurant info (timing / phone / contact)
  if (/\b(timing|time|open|hours|phone|contact|number|info|whatsapp|khulte|khulta|khultay|khulne|khulta hai)\b/.test(t)) {
    return {
      content: `📋 *Think Food — Restaurant Info*\n\n📌 *Address:*\n${INFO.address}\n\n🕕 *Opening Hours:* ${INFO.timing}\n\n📞 *WhatsApp Only:* ${INFO.phone}\n\n🚚 *Delivery Charges:* PKR ${INFO.deliveryFee}\n⏱️ *Delivery Time:* ${INFO.deliveryTime}`,
    };
  }

  // Checkout trigger (fallback for non-cart phases)
  if (CHECKOUT_TRIGGER.test(t)) {
    if (draft.cart.length > 0) {
      return {
        content: reviewSummary(draft.cart),
        nextPhase: "checkout_review",
      };
    }
    return { content: `🛒 Pehle koi item select karein.\n\nMenu browse karein ya item ka naam type karein.` };
  }

  // Order with item name (fallback)
  if (ORDER_INTENT.test(t) || /\b(order|place|buy)\b/.test(t)) {
    const items = extractItems(t);
    if (items.length > 0) {
      let newCart = [...draft.cart];
      const addedLines: string[] = [];
      const actions: CartAction[] = [];
      let lastAddedName: string | undefined;
      for (const { item, qty } of items) {
        const existing = newCart.find((i) => i.name === item.name);
        if (existing) {
          newCart = newCart.map((i) => i.name === item.name ? { ...i, qty: i.qty + qty } : i);
        } else {
          newCart = [...newCart, { name: item.name, price: item.price, qty }];
        }
        addedLines.push(`${qty} x ${item.name}`);
        actions.push({ op: "add", item: { name: item.name, price: item.price, qty } });
        lastAddedName = item.name;
      }
      const addedText = addedLines.length === 1 ? `${addedLines[0]} added.` : `${addedLines.join(", ")} added.`;
      return {
        content: `${addedText}\n\n${cartSummary(newCart)}${cartTrail}`,
        nextPhase: "item_selected",
        cartActions: actions,
        draftPatch: { lastItem: lastAddedName },
      };
    }
    return {
      content: `🛒 *Kya order karna chahenge?*\n\n🍔 *Burgers* — from PKR 500\n🍕 *Pizza* — from PKR 550\n🥪 *Sandwiches* — from PKR 500\n🍜 *Chinese* — from PKR 400\n🍝 *Pasta* — from PKR 500\n\nItem name type karein ya menu browse karein!`,
    };
  }

  // Price question
  if (/\b(price|cost|how much|kitna|rate|pkr)\b/.test(t)) {
    const item = findMenuItem(t);
    if (item)
      return { content: `*${item.name}* — *PKR ${item.price}*.` };
    return {
      content: `Quick price overview:\n\n🍔 *Burgers* — PKR 500–750\n🍕 *Pizza* — PKR 550–1,600\n🥪 *Sandwiches* — PKR 500–650\n🍜 *Noodles* — PKR 600–650\n🍚 *Rice* — PKR 400–750\n🍝 *Pasta* — PKR 500–850\n🍗 *Starters* — PKR 750–800\n🥩 *Steak* — PKR 950`,
    };
  }

  // Off-topic / unrecognised — stay scoped to Think Food
  if (draft.cart.length > 0) {
    return {
      content: `Main Think Food ke menu, prices, order aur delivery se related help kar sakta hoon.\n\n${cartSummary(draft.cart)}${cartTrail}`,
    };
  }
  return {
    content: `Main Think Food ke menu, prices, order aur delivery se related help kar sakta hoon.\n\nOrder karne ke liye item ka naam type karein, ya *menu* likhein puri list dekhne ke liye.`,
  };
}

// ─── Cart reducer (pure) ──────────────────────────────────────────────────────
// Mirrors the cart-mutation logic the UI component applies via refs, but as a
// pure function so the test harness can thread state through a conversation
// without touching React.

export function applyCartAction(cart: CartItem[], action: CartAction): CartItem[] {
  if (action.op === "add") {
    const existing = cart.find((i) => i.name === action.item.name);
    if (existing) {
      return cart.map((i) =>
        i.name === action.item.name ? { ...i, qty: i.qty + action.item.qty } : i
      );
    }
    return [...cart, action.item];
  }
  if (action.op === "reduce") {
    const existing = cart.find((i) => i.name === action.name);
    if (!existing) return cart;
    const newQty = existing.qty - action.by;
    if (newQty <= 0) return cart.filter((i) => i.name !== action.name);
    return cart.map((i) => (i.name === action.name ? { ...i, qty: newQty } : i));
  }
  if (action.op === "remove") {
    return cart.filter((i) => i.name !== action.name);
  }
  if (action.op === "update_qty") {
    return cart.map((i) => (i.name === action.name ? { ...i, qty: action.qty } : i));
  }
  return [];
}
