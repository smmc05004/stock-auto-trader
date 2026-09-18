import { describe, expect, it } from "vitest";
import { KR_COST_MODEL_2026, applySlippage, resolveSchedule, roundTripCostRate, tradeCost, type CostModel } from "./cost";
import { checkBars, simpleMovingAverage, type DailyBar } from "@/lib/marketData/bars";
import { createAbsoluteMomentumStrategy, createBuyAndHoldStrategy, createTrendStrategy, runDailyBacktest } from "./daily";

const model: CostModel = {
  version: "test",
  schedules: {
    kospi_stock: [
      { effectiveFrom: "2020-01-01", commissionRate: 0, sellTaxRate: 0.0023, basis: "이전" },
      { effectiveFrom: "2026-01-01", commissionRate: 0, sellTaxRate: 0.002, basis: "현행" },
    ],
    domestic_equity_etf: [{ effectiveFrom: "2020-01-01", commissionRate: 0, sellTaxRate: 0, basis: "ETF" }],
  },
};

function bar(date: string, close: number, open = close): DailyBar {
  return { symbol: "229200", date, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000, adjustedClose: close, distribution: 0 };
}
function series(count: number, price: (i: number) => number, from = Date.parse("2026-01-01T00:00:00Z")) {
  return Array.from({ length: count }, (_, i) => bar(new Date(from + i * 86400_000).toISOString().slice(0, 10), price(i)));
}

describe("cost model", () => {
  it("picks the schedule effective on the trade date, not the newest one", () => {
    expect(resolveSchedule(model, "kospi_stock", "2025-06-30").sellTaxRate).toBe(0.0023);
    expect(resolveSchedule(model, "kospi_stock", "2026-06-30").sellTaxRate).toBe(0.002);
  });
  it("charges sell tax only on sells and moves price against the order", () => {
    const buy = tradeCost(model, { side: "buy", price: 10_000, quantity: 1, instrument: "kospi_stock", date: "2026-06-30", tickSize: 10 }, 0.00015);
    const sell = tradeCost(model, { side: "sell", price: 10_000, quantity: 1, instrument: "kospi_stock", date: "2026-06-30", tickSize: 10 }, 0.00015);
    expect(buy.tax).toBe(0);
    expect(buy.effectivePrice).toBe(10_010);
    expect(sell.effectivePrice).toBe(9_990);
    expect(sell.tax).toBeCloseTo(9_990 * 0.002, 6);
    expect(buy.cashDelta).toBeLessThan(0);
    expect(sell.cashDelta).toBeGreaterThan(0);
  });
  it("makes an ETF round trip cheaper than a stock round trip", () => {
    const stock = roundTripCostRate(model, "kospi_stock", "2026-06-30", 0.00015, 10_000, 10);
    const etf = roundTripCostRate(model, "domestic_equity_etf", "2026-06-30", 0.00015, 10_000, 10);
    expect(stock).toBeGreaterThan(etf);
    expect(etf).toBeGreaterThan(0);
  });
  it("rejects implausible inputs instead of coercing them", () => {
    expect(() => tradeCost(model, { side: "buy", price: 0, quantity: 1, instrument: "kospi_stock", date: "2026-06-30", tickSize: 10 }, 0.00015)).toThrow();
    expect(() => tradeCost(model, { side: "buy", price: 100, quantity: 1.5, instrument: "kospi_stock", date: "2026-06-30", tickSize: 10 }, 0.00015)).toThrow();
    expect(() => tradeCost(model, { side: "buy", price: 100, quantity: 1, instrument: "kospi_stock", date: "2026-06-30", tickSize: 10 }, 0.5)).toThrow();
    expect(() => applySlippage(100, "buy", 0, 1)).toThrow();
  });
  it("ships a 2026 Korean model whose commission must be supplied per account", () => {
    for (const cls of ["kospi_stock", "kosdaq_stock", "domestic_equity_etf"] as const) {
      expect(resolveSchedule(KR_COST_MODEL_2026, cls, "2026-09-18").commissionRate).toBe(0);
      expect(resolveSchedule(KR_COST_MODEL_2026, cls, "2026-09-18").basis).not.toBe("");
    }
    expect(resolveSchedule(KR_COST_MODEL_2026, "kospi_stock", "2026-09-18").sellTaxRate).toBe(0.002);
  });
});

describe("bar integrity", () => {
  it("flags duplicates, disorder and impossible candles", () => {
    const kinds = checkBars([bar("2026-01-02", 100), bar("2026-01-02", 100), bar("2026-01-01", 100)]).map(i => i.kind);
    expect(kinds).toContain("duplicate_date");
    expect(kinds).toContain("out_of_order");
    const broken = { ...bar("2026-01-05", 100), high: 90, low: 110 };
    expect(checkBars([broken]).map(i => i.kind)).toContain("high_below_low");
  });
  it("flags an unadjusted split as an implausible change", () => {
    expect(checkBars([bar("2026-01-01", 100), bar("2026-01-02", 20)]).map(i => i.kind)).toContain("implausible_change");
  });
  it("accepts a clean series and averages the adjusted close", () => {
    const bars = series(5, () => 100);
    expect(checkBars(bars)).toEqual([]);
    expect(simpleMovingAverage(bars, 5)).toBe(100);
    expect(simpleMovingAverage(bars, 6)).toBeUndefined();
  });
});

describe("daily backtest", () => {
  const base = { costModel: model, commissionRate: 0.00015, instrument: "domestic_equity_etf" as const, tickSize: 5, initialCash: 1_000_000, warmupBars: 3 };

  it("never executes on the bar that produced the signal", () => {
    const bars = series(10, i => 100 + i);
    const seen: string[] = [];
    const result = runDailyBacktest({
      ...base, bars, warmupBars: 3,
      strategy: { name: "probe", version: "t", evaluate: history => { seen.push(history[history.length - 1].date); return { targetWeight: 1, reason: "always" }; } },
    });
    // 첫 신호는 warmup 충족 시점(4번째 봉)에 나오고, 체결은 그 다음 봉이어야 한다.
    expect(seen[0]).toBe(bars[2].date);
    expect(result.fills[0].date).toBe(bars[3].date);
    expect(result.fills[0].price).toBe(bars[3].open);
  });

  it("subtracts costs so a flat market loses exactly the round trip cost", () => {
    const bars = series(8, () => 10_000);
    let weight = 0;
    const result = runDailyBacktest({
      ...base, bars,
      strategy: { name: "toggle", version: "t", evaluate: () => ({ targetWeight: (weight = weight ? 0 : 1), reason: "toggle" }) },
    });
    expect(result.trades).toBeGreaterThan(0);
    expect(result.costTotal).toBeGreaterThan(0);
    // 가격이 전혀 움직이지 않았는데 이익이 나면 비용이 빠지지 않은 것이다.
    expect(result.finalEquity).toBeLessThan(base.initialCash);
    expect(base.initialCash - result.finalEquity).toBeCloseTo(result.costTotal, 0);
  });

  it("refuses to run on data that fails integrity checks", () => {
    const bars = [bar("2026-01-02", 100), bar("2026-01-01", 100)];
    expect(() => runDailyBacktest({ ...base, bars, warmupBars: 1, strategy: createTrendStrategy({ period: 1, maxExposure: 1 }) })).toThrow(/Unusable bars/);
  });

  it("holds a trend strategy above its average and goes flat below it", () => {
    const up = series(40, i => 100 + i);
    const held = runDailyBacktest({ ...base, bars: up, warmupBars: 10, strategy: createTrendStrategy({ period: 10, maxExposure: 0.6 }) });
    expect(held.averageExposure).toBeGreaterThan(0);
    expect(held.fills.some(f => f.side === "buy")).toBe(true);

    const down = series(40, i => 200 - i);
    const flat = runDailyBacktest({ ...base, bars: down, warmupBars: 10, strategy: createTrendStrategy({ period: 10, maxExposure: 0.6 }) });
    expect(flat.fills.filter(f => f.side === "buy")).toHaveLength(0);
    expect(flat.finalEquity).toBe(base.initialCash);
  });

  it("compares an absolute momentum gate and passive exposure through the same cost engine", () => {
    const rising = series(40, i => 10_000 + i * 20);
    const momentum = runDailyBacktest({
      ...base, bars: rising, warmupBars: 10,
      strategy: createAbsoluteMomentumStrategy({ lookback: 5, maxExposure: 0.6 }),
    });
    const passive = runDailyBacktest({
      ...base, bars: rising, warmupBars: 10,
      strategy: createBuyAndHoldStrategy({ targetWeight: 0.6 }),
    });
    expect(momentum.fills[0].date).toBe(rising[10].date);
    expect(momentum.fills[0].side).toBe("buy");
    expect(passive.fills[0].side).toBe("buy");
    expect(momentum.strategy).not.toBe(passive.strategy);
  });

  it("keeps absolute momentum in cash when the lookback return is nonpositive", () => {
    const falling = series(30, i => 20_000 - i * 100);
    const result = runDailyBacktest({
      ...base, bars: falling, warmupBars: 10,
      strategy: createAbsoluteMomentumStrategy({ lookback: 5, maxExposure: 0.6 }),
    });
    expect(result.fills.filter(fill => fill.side === "buy")).toHaveLength(0);
    expect(result.finalEquity).toBe(base.initialCash);
  });

  it("reports monthly rows, drawdown and turnover", () => {
    const bars = series(70, i => 10_000 + Math.round(Math.sin(i / 5) * 500));
    const result = runDailyBacktest({ ...base, bars, warmupBars: 10, datasetVersion: "test-1", strategy: createTrendStrategy({ period: 10, maxExposure: 0.6 }) });
    expect(result.datasetVersion).toBe("test-1");
    expect(result.monthly.length).toBeGreaterThan(1);
    expect(result.monthly.every(m => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.turnover).toBeGreaterThan(0);
  });
});
