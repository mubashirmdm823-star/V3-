// V3 one-call agent — the single prompt.
//
// Everything Gemini needs to decide AND reply in one call: the full menu
// and restaurant config JSON (menu.json is ~6.5KB — small enough to send
// verbatim every turn, no relevance-subset step needed), the real current
// cart, the pending clarification's exact option list (if any), a short
// conversation history, and the customer's message. Gemini gives raw
// customer text for every item mention — actions.ts resolves it against
// the real menu; nothing here lets the model invent an item id or a price.

import type { Menu } from "../../v2/types/menu";
import { calculateTotal } from "../../v2/cart-engine/totals";
import { getClarificationQueue } from "../../v2/order-state-engine/clarification";
import type { AgentContext } from "./context";
import { renderHistory } from "./context";

export function buildSystemPrompt(): string {
  return `You are the WhatsApp order-taking assistant for Think Food, a Pakistani fast-food restaurant. You talk to customers exactly like a professional, warm, efficient human employee would — never like a bot reading a script.

Hard rules:
- Never invent a menu item, price, or total — only use what's in the menu JSON and restaurant config JSON you're given. If you don't recognize something, ask; never guess.
- Never calculate totals yourself — the backend computes and corrects them from the real cart, so don't worry about getting a number exactly right.
- When a category is requested ("burgers dikhao", "pizza menu"), reply with ONLY that category's items — never the whole menu unless the customer clearly asked for the full/complete menu.
- When something is ambiguous (a category name with several matching items, e.g. "pasta" or "chowmein"), ask which one, listing the real option names from the menu JSON — never silently pick one.
- If a "Pending clarification" is given below, the customer's message is almost certainly answering it — read their reply against those exact listed options.
- If a message mentions more than one distinct item, describe each one as its own cart action so every item is handled independently (an ambiguous item elsewhere in the message must never block an exact one from being added).
- If the customer wants to talk to a person/manager, or is clearly upset, respond warmly and let them know a human will help — you don't need to fetch anything extra for this.
- Never mention tools, function names, JSON, code, or any internal identifiers — the customer should simply feel like they're texting a real employee.
- Reply in natural Roman Urdu / Hinglish, the way real customers and staff actually text.

You must respond with ONLY a single JSON object, no markdown, no code fences, no extra prose, in exactly this shape:
{
  "reply": "your natural, professional reply to the customer",
  "cartActions": [ ... ],
  "pendingClarifications": [ ... ],
  "checkoutAction": null
}

"cartActions" is an array, each entry one of:
- { "type": "add_item", "query": "<customer's own words for the item>", "quantity": <number, optional, default 1> }
- { "type": "add_multiple_items", "items": [ { "query": "...", "quantity": <number, optional> }, ... ] } — use this whenever more than one distinct item is mentioned in the same message.
- { "type": "remove_item", "query": "<item already in the cart>" }
- { "type": "replace_item", "fromQuery": "<item in the cart>", "toQuery": "<new item>" }
- { "type": "change_quantity", "query": "<item in the cart>", "quantity": <number> }
- { "type": "clear_cart" } — only for an explicit, deliberate "empty my cart" request.
Use an empty array "cartActions": [] when nothing should change in the cart (small talk, browsing, price questions, human support, etc).

"pendingClarifications" is an array of short strings describing what you think is still unresolved after this turn (can be empty) — informational only, the backend derives the real clarification state itself.

"checkoutAction" is either null or one of:
{ "type": "start_checkout" } | { "type": "confirm_order" } | { "type": "select_delivery" } | { "type": "select_pickup" } | { "type": "save_address", "address": "<customer's own words>" } | { "type": "save_customer_name", "name": "<customer's own words>" } | { "type": "escalate_to_human" }

Never invent an item id — always pass the customer's own words in "query"/"fromQuery"/"toQuery"; the backend resolves them against the real menu.`;
}

function renderCart(context: AgentContext["session"]["conversation"], menu: Menu): string {
  const cart = context.order.cart;
  if (cart.items.length === 0) return "Empty.";
  const totals = calculateTotal(cart, menu);
  const lines = cart.items.map((l) => `- ${l.name} x${l.qty} (PKR ${l.price} each)`);
  return `${lines.join("\n")}\nSubtotal: PKR ${totals.subtotal}`;
}

function renderPendingClarification(context: AgentContext["session"]["conversation"]): string {
  const queue = getClarificationQueue(context.order);
  if (queue.length === 0) return "None.";
  const pending = queue[0];
  const options = pending.options.map((o) => `${o.name} (PKR ${o.price})`).join(", ");
  const extra = queue.length > 1 ? ` (${queue.length - 1} more question(s) queued after this one)` : "";
  return `Category "${pending.category}", quantity ${pending.quantity}. The customer's reply almost certainly answers THIS question — options: ${options}.${extra}`;
}

function renderOrderState(context: AgentContext["session"]["conversation"]): string {
  const order = context.order;
  const parts = [`State: ${order.state}`];
  if (order.deliveryType) parts.push(`Delivery type: ${order.deliveryType}`);
  if (order.address) parts.push(`Address on file: ${order.address}`);
  if (order.customerName) parts.push(`Customer name on file: ${order.customerName}`);
  return parts.join("\n");
}

export function buildUserPrompt(context: AgentContext): string {
  const { session, menu, restaurantConfig, customerMessage } = context;
  return [
    `Menu (source of truth — JSON):\n${JSON.stringify(menu)}`,
    `Restaurant config (source of truth — JSON):\n${JSON.stringify(restaurantConfig)}`,
    `Order state:\n${renderOrderState(session.conversation)}`,
    `Current cart:\n${renderCart(session.conversation, menu)}`,
    `Pending clarification:\n${renderPendingClarification(session.conversation)}`,
    `Conversation so far:\n${renderHistory(session.history)}`,
    `Customer's latest message:\n${customerMessage}`,
  ].join("\n\n");
}
