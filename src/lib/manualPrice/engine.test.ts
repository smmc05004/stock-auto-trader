import { describe, expect, it } from "vitest";
import { createManualEngineState, onBuyStatus, onQuote, onSellStatus } from "./engine";

const config = { buyPrice: 10_000, sellPrice: 10_100, plannedQuantity: 3 };
const quote = (price: number, at = Date.now()) => ({ symbol: "229200", name: "ETF", market: "KR" as const, price, ask: price, bid: price - 5, changeRate: 0, currency: "KRW", timestamp: new Date(at).toISOString() });

describe("manual price engine", () => {
  it("waits for a fresh ask at or below the buy price", () => {
    const state = createManualEngineState();
    expect(onQuote(state, config, quote(10_010))).toMatchObject({ type: "wait", reason: "buy_price_not_reached" });
    expect(onQuote(state, config, quote(10_000))).toMatchObject({ type: "submit_buy", quantity: 3 });
  });
  it("blocks stale quotes", () => {
    const state = createManualEngineState();
    expect(onQuote(state, config, quote(10_000, Date.now() - 3_001))).toMatchObject({ type: "wait", reason: "stale_quote" });
  });
  it("submits the confirmed buy quantity for sell and starts the next cycle", () => {
    const state = createManualEngineState();
    onQuote(state, config, quote(10_000));
    expect(onBuyStatus(state, config, 2, 0)).toMatchObject({ type: "submit_sell", quantity: 2 });
    expect(onSellStatus(state, 2, 0)).toMatchObject({ type: "wait", reason: "cycle_completed" });
    expect(state.phase).toBe("waiting_buy");
    expect(state.completedCycles).toBe(1);
  });
});
