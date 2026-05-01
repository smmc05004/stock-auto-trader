import { describe, expect, it } from "vitest";
import { runBacktest, type HistoricalPrice } from "@/lib/backtest/backtest";
import { createSampleMomentumStrategy } from "@/lib/strategy/samples/momentumStrategy";

const prices: HistoricalPrice[] = [
  {
    symbol: "005930",
    name: "Samsung Electronics",
    market: "KR",
    close: 10_000,
    changeRate: 1.2,
    currency: "KRW",
    timestamp: "2026-05-01T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "Samsung Electronics",
    market: "KR",
    close: 11_000,
    changeRate: 0.1,
    currency: "KRW",
    timestamp: "2026-05-02T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "Samsung Electronics",
    market: "KR",
    close: 12_000,
    changeRate: -1.2,
    currency: "KRW",
    timestamp: "2026-05-03T00:00:00.000Z",
  },
];

describe("runBacktest", () => {
  it("runs a sample momentum strategy over historical prices", async () => {
    const strategy = createSampleMomentumStrategy({
      buyChangeRateThreshold: 1,
      sellChangeRateThreshold: -1,
      orderQuantity: 1,
      confidence: 0.35,
    });

    const result = await runBacktest({
      strategy,
      prices,
      initialCash: 100_000,
    });

    expect(result.strategyName).toBe("sample-momentum");
    expect(result.tradeCount).toBe(2);
    expect(result.trades.map((trade) => trade.side)).toEqual(["buy", "sell"]);
    expect(result.finalEquity).toBe(102_000);
    expect(result.returnRate).toBe(0.02);
    expect(result.winRate).toBe(1);
    expect(result.signals).toHaveLength(3);
  });

  it("respects cash constraints", async () => {
    const strategy = createSampleMomentumStrategy({
      buyChangeRateThreshold: 1,
      sellChangeRateThreshold: -1,
      orderQuantity: 20,
      confidence: 0.35,
    });

    const result = await runBacktest({
      strategy,
      prices,
      initialCash: 100_000,
    });

    expect(result.tradeCount).toBe(0);
    expect(result.finalEquity).toBe(100_000);
  });
});
