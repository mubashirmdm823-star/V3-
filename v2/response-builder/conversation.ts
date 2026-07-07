// V2 Customer Conversation Layer — replies for the conversational intents
// (GREETING/THANKS/YES/NO/WAIT/CANCEL_ORDER/HUMAN_SUPPORT/COMPLAINT/
// RECOMMENDATION_REQUEST/CONFUSED_CUSTOMER/SMALL_TALK/IRRELEVANT_QUERY/
// HELP/GOODBYE). Same rules as every other response-builder file:
// professional Roman Urdu/Hinglish, no internal identifiers, restaurant
// facts only ever from restaurant-config.json, menu names/prices only ever
// from the live Menu object.

import type { Menu, MenuItem, RestaurantConfig } from "../types/menu";
import type { OrderContext } from "../types/order";
import { allMenuItems } from "../intent-parser/matching";
import { formatCurrency, bulletList, joinParagraphs } from "./formatter";

export const THANKS_REPLY =
  "Aapka bohat shukriya! Kisi aur cheez ki zaroorat ho to bas bata dein.";

export const GOODBYE_REPLY =
  "Allah Hafiz! Think Food ko yaad rakhne ka shukriya. Jab bhi bhook lage, hum yahin hain.";

export const SMALL_TALK_REPLY =
  'Hum bilkul theek hain, shukriya poochne ka! Aap batayein — kuch order karna chahenge? "menu" likh kar hamara pura menu dekh sakte hain.';

export const IRRELEVANT_REDIRECT_REPLY =
  'Maaf kijiye, main sirf Think Food ke orders aur menu mein madad kar sakta hoon. Menu dekhne ke liye "menu" likhein, ya jo item chahiye uska naam likh dein.';

export const ORDER_CANCELLED_REPLY =
  "Aapka order cancel kar diya gaya hai — koi masla nahi. Jab dil kare, dobara order kar lijiye ga. Hum hamesha hazir hain.";

export const NOTHING_TO_CANCEL_REPLY =
  'Is waqt koi active order nahi hai, is liye cancel karne ke liye kuch nahi. Kuch order karna chahen to "menu" likh kar dekh lein.';

// Simple Roman Urdu "how this works" guide — used for both HELP and a
// confused customer (requirement: explain what they can do, simply).
export function buildHelpReply(): string {
  return joinParagraphs(
    "Koi baat nahi, main asaan alfaz mein batata hoon:",
    bulletList([
      '"menu" likhein — pura menu dekhne ke liye',
      'Item ka naam likhein — jaise "2 Zinger Burger add karo"',
      '"cart dikhao" — apna order dekhne ke liye',
      '"checkout" — order mukammal karne ke liye',
    ]),
    "Aap mujh se timing, delivery charges ya address bhi pooch sakte hain."
  );
}

export function buildHumanSupportReply(config: RestaurantConfig): string {
  return joinParagraphs(
    "Bilkul, koi masla nahi.",
    `Hamari team se seedhi baat karne ke liye ${config.phone} par call karein (timing: ${config.timing}).`,
    "Us waqt tak main yahan hoon — order lena, menu batana ya koi bhi sawal, bas bata dein."
  );
}

export function buildComplaintReply(config: RestaurantConfig): string {
  return joinParagraphs(
    "Hum tahe dil se maazrat chahte hain — aisa tajurba bilkul nahi hona chahiye tha.",
    `Aapki shikayat hamari team tak zaroor pahunchai jayegi. Fauri baat ke liye ${config.phone} par call kar sakte hain.`,
    "Kya main abhi aapki kisi cheez mein madad kar sakta hoon?"
  );
}

// Customer favourites, derived from the live menu — a preferred list of
// flagship ids (verified against the menu at runtime), topped up from the
// first item of each category if any id ever disappears. Prices always come
// from the menu, never hardcoded.
const POPULAR_ITEM_IDS = [
  "zinger-burger",
  "think-food-special-pizza",
  "chicken-chowmein",
  "hot-shot-8-pcs-with-fries",
  "singaporean-rice",
  "chicken-steak",
];

export function pickPopularItems(menu: Menu, count = 4): MenuItem[] {
  const byId = new Map(allMenuItems(menu).map((item) => [item.id, item]));
  const picks: MenuItem[] = [];
  for (const id of POPULAR_ITEM_IDS) {
    const item = byId.get(id);
    if (item && picks.length < count) picks.push(item);
  }
  for (const category of menu.categories) {
    if (picks.length >= count) break;
    const first = category.items[0];
    if (first && !picks.some((p) => p.id === first.id)) picks.push(first);
  }
  return picks.slice(0, count);
}

export function buildRecommendationReply(menu: Menu): string {
  const picks = pickPopularItems(menu);
  return joinParagraphs(
    "Hamare customers ke pasandeeda items yeh hain:",
    bulletList(picks.map((item) => `${item.name} — ${formatCurrency(item.price)}`)),
    "Kaunsa try karna chahenge? Order karne ke liye bas item ka naam likh dein."
  );
}

export function buildWaitReply(before: OrderContext): string {
  const saved =
    before.cart.items.length > 0
      ? "Aapka order bilkul mehfooz hai — kuch bhi delete nahi hoga."
      : "Koi jaldi nahi hai.";
  return joinParagraphs(
    "Ji bilkul, aaram se.",
    saved,
    "Jab ready hon to bas message kar dein, wahin se aage chalein ge."
  );
}

// A bare "haan/yes" where the state itself didn't already consume it
// (ORDER_REVIEW and READY_TO_SUBMIT turn YES into confirm/submit before
// this is ever reached).
export function buildYesReply(before: OrderContext): string | null {
  switch (before.state) {
    case "AWAITING_DELIVERY_PICKUP":
      return 'Ji! Bas yeh bata dein — "Delivery" chahiye ya "Pickup"?';
    case "AWAITING_ADDRESS":
    case "AWAITING_NAME":
      // Let the existing focused re-prompts handle these.
      return null;
    default:
      return 'Ji, zaroor! Batayein kya order karna chahenge? "menu" likh kar options dekh sakte hain.';
  }
}

export function buildNoReply(before: OrderContext): string | null {
  switch (before.state) {
    case "ORDER_REVIEW":
      return 'Koi baat nahi. Aap items add ya remove kar sakte hain — jab sab theek lage to "Confirm Order" likh dein.';
    case "READY_TO_SUBMIT":
      return 'Theek hai, order abhi submit nahi kiya. Kuch change karna ho to bata dein — warna "Submit" likh kar order mukammal kar dein.';
    case "AWAITING_DELIVERY_PICKUP":
      return 'Koi baat nahi — "Delivery" ya "Pickup" mein se jo chahiye woh likh dein, ya "cancel" likh kar order rok dein.';
    case "AWAITING_CLARIFICATION":
      return "Theek hai, rehne dete hain. Kuch aur order karna chahen to item ka naam likh dein.";
    case "AWAITING_ADDRESS":
    case "AWAITING_NAME":
      return null;
    default:
      return "Theek hai, koi masla nahi. Jab order karna ho, bas bata dein.";
  }
}
