/**
 * Compare fixed, predeclared daily ETF candidates on the same chronological
 * windows. This script never calls a broker or submits orders.
 *
 * npm run backtest:etf -- --db data/market/bars.sqlite
 *   --symbol 229200 --dataset <version> --commission-rate 0.0001 --sell-tax-rate 0
 *   --sell-tax-basis "verified source and effective period" --tick-size 5
 *   --development-start 2016-01-01 --development-end 2021-12-31
 *   --selection-start 2022-01-01 --selection-end 2023-12-31
 *   --test-start 2024-01-01 --test-end 2026-09-18
 */
import { createHash } from "node:crypto";
import { BarStore } from "../src/lib/marketData/store";
import type { DailyBacktestResult } from "../src/lib/backtest/daily";
import {
  createAbsoluteMomentumStrategy, createBuyAndHoldStrategy, createTrendStrategy, runDailyBacktest,
} from "../src/lib/backtest/daily";
import type { CostModel } from "../src/lib/backtest/cost";

type Window = { name: string; start: string; end: string };

function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function date(value: string, name: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(`--${name} must be YYYY-MM-DD`);
  }
  return value;
}

function summary(result: DailyBacktestResult) {
  return {
    strategy: result.strategy, version: result.strategyVersion, initialCash: result.initialCash,
    finalEquity: result.finalEquity, returnRate: result.returnRate, maxDrawdown: result.maxDrawdown,
    recoveryDays: result.recoveryDays, trades: result.trades, costTotal: result.costTotal,
    averageExposure: result.averageExposure, turnover: result.turnover,
    monthly: result.monthly, blocked: result.blocked,
  };
}

function main() {
  const db = arg("db");
  const symbol = arg("symbol");
  const datasetVersion = arg("dataset");
  const commissionRate = Number(arg("commission-rate"));
  if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate >= 0.005) {
    throw new Error("--commission-rate must be a decimal rate from 0 (inclusive) to 0.005 (exclusive), so 2x cost stress remains valid");
  }
  const sellTaxRate = Number(arg("sell-tax-rate"));
  const sellTaxBasis = arg("sell-tax-basis");
  if (!Number.isFinite(sellTaxRate) || sellTaxRate < 0 || sellTaxRate >= 0.01) {
    throw new Error("--sell-tax-rate must be a decimal rate from 0 (inclusive) to 0.01 (exclusive)");
  }
  const windows: Window[] = [
    { name: "development", start: date(arg("development-start"), "development-start"), end: date(arg("development-end"), "development-end") },
    { name: "selection", start: date(arg("selection-start"), "selection-start"), end: date(arg("selection-end"), "selection-end") },
    { name: "final_test", start: date(arg("test-start"), "test-start"), end: date(arg("test-end"), "test-end") },
  ];
  if (windows.some(w => w.start > w.end)
    || windows[0].end >= windows[1].start || windows[1].end >= windows[2].start) {
    throw new Error("Evaluation windows must be ordered, non-overlapping, and have start <= end");
  }
  const lookbackWarmup = 253;
  const store = new BarStore(db);
  try {
    const bars = store.read(symbol);
    const tickSize = Number(arg("tick-size"));
    if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error("--tick-size must be positive");
    if (!bars.length) throw new Error(`No bars stored for ${symbol}`);
    const selected = bars.filter(b => b.date <= windows[2].end);
    if (selected.length < lookbackWarmup + 2) throw new Error("Insufficient history for a 252-observation candidate");
    const dataHash = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    const scenarios = [
      { name: "base", commissionRate, slippageTicks: 1 },
      { name: "cost_stress_2x", commissionRate: commissionRate * 2, slippageTicks: 2 },
    ];
    const strategies = [
      { id: "trend_120", make: () => createTrendStrategy({ period: 120, maxExposure: 0.6 }) },
      { id: "absolute_momentum_126", make: () => createAbsoluteMomentumStrategy({ lookback: 126, maxExposure: 0.6 }) },
      { id: "absolute_momentum_252", make: () => createAbsoluteMomentumStrategy({ lookback: 252, maxExposure: 0.6 }) },
      { id: "buy_and_hold_60pct", make: () => createBuyAndHoldStrategy({ targetWeight: 0.6 }) },
    ];
    const results = strategies.map(candidate => ({
      candidate: candidate.id,
      scenarios: scenarios.map(scenario => {
        const costModel: CostModel = {
          version: `caller-supplied-etf-cost-${scenario.name}`,
          schedules: {
            domestic_equity_etf: [{
              effectiveFrom: selected[0].date, commissionRate: scenario.commissionRate, sellTaxRate,
              basis: `Caller supplied: ${sellTaxBasis}`,
            }],
          },
        };
        return {
          name: scenario.name, commissionRate: scenario.commissionRate, slippageTicks: scenario.slippageTicks,
          windows: windows.map(window => {
            const result = runDailyBacktest({
              bars: selected, strategy: candidate.make(), costModel,
              commissionRate: scenario.commissionRate, instrument: "domestic_equity_etf", tickSize,
              initialCash: 1_000_000, warmupBars: lookbackWarmup, slippageTicks: scenario.slippageTicks,
              datasetVersion, evaluationStartDate: window.start, evaluationEndDate: window.end,
            });
            return { name: window.name, requestedStart: window.start, requestedEnd: window.end, ...summary(result) };
          }),
        };
      }),
    }));
    const nonzeroDistributions = selected.filter(b => b.distribution > 0).length;
    console.log(JSON.stringify({
      reportVersion: "kr-etf-candidate-comparison-v1", symbol, instrumentClass: "domestic_equity_etf", tickSize, datasetVersion,
      data: {
        firstDate: selected[0].date, lastDate: selected.at(-1)?.date, observations: selected.length,
        sha256: dataHash, nonzeroDistributionObservations: nonzeroDistributions,
        distributionStatus: nonzeroDistributions ? "partial_data_requires_review" : "missing_or_none_unverified",
      },
      settings: {
        initialCash: 1_000_000, targetExposure: 0.6, commissionRate, sellTaxRate, sellTaxBasis,
        stressMethod: "commission and slippage doubled; statutory tax unchanged",
        lookbackWarmup,
      },
      limitations: [
        "This report compares historical scenarios and does not predict future returns.",
        "Daily next-open fills approximate, and do not reproduce, the configured intraday limit-order execution.",
        "Distribution values must be verified; zero values do not prove that no distributions occurred.",
        "A positive final-test result alone is insufficient evidence of a robust edge.",
      ],
      candidates: results,
    }, null, 2));
  } finally {
    store.close();
  }
}

main();
