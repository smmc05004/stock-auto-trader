import { describe, expect, it } from "vitest";
import type { StrategyContext } from "@/lib/strategy/strategy";
import { createSampleMomentumStrategy } from "@/lib/strategy/samples/momentumStrategy";

const baseContext: StrategyContext = {
  account: {
    accountNo: "12345678",
    cash: 1_000_000,
    currency: "KRW",
    totalMarketValue: 0,
    positions: [],
  },
  quote: {
    symbol: "005930",
    name: "Samsung Electronics",
    market: "KR",
    price: 73_500,
    changeRate: 0,
    currency: "KRW",
    timestamp: "2026-05-01T00:00:00.000Z",
  },
  quoteHistory: [],
  positions: [],
  orderHistory: [],
  cashRatio: 1,
};

const strategy = createSampleMomentumStrategy({
  buyChangeRateThreshold: 1,
  sellChangeRateThreshold: -1,
  orderQuantity: 3,
  confidence: 0.4,
});

describe("createSampleMomentumStrategy", () => {
  it("returns buy when quote change rate reaches the buy threshold", async () => {
    const signal = await strategy.evaluate({
      ...baseContext,
      quote: {
        ...baseContext.quote,
        changeRate: 1.2,
      },
    });

    expect(signal.action).toBe("buy");
    expect(signal.confidence).toBe(0.4);
    expect(signal.suggestedOrder).toMatchObject({
      symbol: "005930",
      side: "buy",
      type: "market",
      quantity: 3,
    });
  });

  it("returns sell when quote change rate reaches the sell threshold", async () => {
    const signal = await strategy.evaluate({
      ...baseContext,
      quote: {
        ...baseContext.quote,
        changeRate: -1.2,
      },
    });

    expect(signal.action).toBe("sell");
    expect(signal.suggestedOrder).toMatchObject({
      side: "sell",
      quantity: 3,
    });
  });

  it("returns hold when no threshold is met", async () => {
    const signal = await strategy.evaluate(baseContext);

    expect(signal.action).toBe("hold");
    expect(signal.suggestedOrder).toBeUndefined();
  });
});
