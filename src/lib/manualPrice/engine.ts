import type { Quote } from "@/lib/types/trading";

export type ManualPhase = "waiting_buy" | "buying" | "selling" | "completed" | "blocked";
export type ManualOrder = { side: "buy" | "sell"; limitPrice: number; quantity: number; filledQuantity: number };
export type ManualEngineState = { phase: ManualPhase; buy?: ManualOrder; sell?: ManualOrder; lastQuoteAt?: number; completedCycles: number; reason?: string };
export type ManualEngineAction =
  | { type: "submit_buy"; price: number; quantity: number }
  | { type: "submit_sell"; price: number; quantity: number }
  | { type: "wait"; reason: string }
  | { type: "reconcile"; reason: string };

export type ManualEngineConfig = { buyPrice: number; sellPrice: number; plannedQuantity: number; maxQuoteAgeMs?: number };

export function createManualEngineState(): ManualEngineState {
  return { phase: "waiting_buy", completedCycles: 0 };
}

export function onQuote(state: ManualEngineState, config: ManualEngineConfig, quote: Quote, now = Date.now()): ManualEngineAction {
  const quoteAt = Date.parse(quote.timestamp);
  const age = Number.isFinite(quoteAt) ? now - quoteAt : Number.POSITIVE_INFINITY;
  const maxAge = config.maxQuoteAgeMs ?? 3_000;
  state.lastQuoteAt = quoteAt;
  if (age < -1_000 || age > maxAge) return { type: "wait", reason: "stale_quote" };
  if (state.phase !== "waiting_buy") return { type: "wait", reason: `phase_${state.phase}` };
  const ask = quote.ask ?? quote.price;
  if (!(ask > 0) || ask > config.buyPrice) return { type: "wait", reason: "buy_price_not_reached" };
  state.phase = "buying";
  state.buy = { side: "buy", limitPrice: config.buyPrice, quantity: config.plannedQuantity, filledQuantity: 0 };
  return { type: "submit_buy", price: config.buyPrice, quantity: config.plannedQuantity };
}

export function onBuyStatus(state: ManualEngineState, config: ManualEngineConfig, filledQuantity: number, remainingQuantity: number): ManualEngineAction {
  if (state.phase !== "buying" || !state.buy) return { type: "reconcile", reason: "unexpected_buy_status" };
  state.buy.filledQuantity = filledQuantity;
  if (remainingQuantity > 0) return { type: "wait", reason: "buy_partially_filled" };
  if (filledQuantity <= 0) { state.phase = "waiting_buy"; state.buy = undefined; return { type: "wait", reason: "buy_cancelled_without_fill" }; }
  state.phase = "selling";
  state.sell = { side: "sell", limitPrice: config.sellPrice, quantity: filledQuantity, filledQuantity: 0 };
  return { type: "submit_sell", price: config.sellPrice, quantity: filledQuantity };
}

export function onSellStatus(state: ManualEngineState, filledQuantity: number, remainingQuantity: number): ManualEngineAction {
  if (state.phase !== "selling" || !state.sell) return { type: "reconcile", reason: "unexpected_sell_status" };
  state.sell.filledQuantity = filledQuantity;
  if (remainingQuantity > 0) return { type: "wait", reason: "sell_partially_filled" };
  if (filledQuantity !== state.sell.quantity) return { type: "reconcile", reason: "sell_quantity_mismatch" };
  state.phase = "waiting_buy";
  state.buy = undefined;
  state.sell = undefined;
  state.completedCycles += 1;
  return { type: "wait", reason: "cycle_completed" };
}
