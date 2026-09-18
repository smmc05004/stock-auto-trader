import { simpleMovingAverage, barsUsable, type DailyBar } from "@/lib/marketData/bars";
import { applySlippage, tradeCost, type CostModel, type InstrumentClass, type TradeCost } from "./cost";

/**
 * 일봉 백테스트. 신호는 확정 종가로만 만들고 체결은 다음 거래일 시가로 한다.
 * 같은 봉에서 판단하고 체결하지 않는다.
 */
export type DailySignal = { targetWeight: number; reason: string };
export type DailyStrategy = {
  name: string;
  version: string;
  /** history는 판단 시점까지 확정된 봉만 담는다. */
  evaluate(history: DailyBar[], context: { date: string; equity: number; quantity: number }): DailySignal;
};

export type DailyFill = {
  date: string; side: "buy" | "sell"; quantity: number; price: number;
  cost: TradeCost; reason: string;
};

/** netChange는 실현손익이 아니라 월말 자산 증감이다. */
export type MonthlyRow = { month: string; netChange: number; costs: number; trades: number; endEquity: number };

export type DailyBacktestResult = {
  strategy: string; strategyVersion: string; datasetVersion: string;
  initialCash: number; finalEquity: number; returnRate: number;
  maxDrawdown: number; recoveryDays: number;
  trades: number; costTotal: number; realized: number; unrealizedAtEnd: number;
  averageExposure: number; turnover: number;
  fills: DailyFill[]; monthly: MonthlyRow[]; blocked: string[];
};

export type DailyBacktestInput = {
  bars: DailyBar[];
  strategy: DailyStrategy;
  costModel: CostModel;
  commissionRate: number;
  instrument: InstrumentClass;
  tickSize: number;
  initialCash: number;
  /** 이동평균 등 준비에 필요한 최소 봉 수. 이 전에는 신호를 만들지 않는다. */
  warmupBars: number;
  slippageTicks?: number;
  datasetVersion?: string;
};

function drawdownAndRecovery(curve: { date: string; equity: number }[]) {
  let peak = curve[0]?.equity ?? 0, peakIndex = 0, maxDrawdown = 0, recoveryDays = 0, worstIndex = 0;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].equity > peak) { peak = curve[i].equity; peakIndex = i; }
    const drop = peak > 0 ? (peak - curve[i].equity) / peak : 0;
    if (drop > maxDrawdown) { maxDrawdown = drop; worstIndex = peakIndex; }
  }
  if (maxDrawdown > 0) {
    const target = curve[worstIndex].equity;
    const recovered = curve.findIndex((p, i) => i > worstIndex && p.equity >= target);
    recoveryDays = recovered === -1 ? curve.length - worstIndex : recovered - worstIndex;
  }
  return { maxDrawdown, recoveryDays };
}

export function runDailyBacktest(input: DailyBacktestInput): DailyBacktestResult {
  const { bars, strategy, costModel, commissionRate, instrument, tickSize, initialCash, warmupBars, slippageTicks = 1, datasetVersion = "" } = input;
  const usable = barsUsable(bars, warmupBars + 1);
  if (!usable.usable) throw new Error(`Unusable bars: ${usable.reason} (${usable.issues.length} issues)`);

  let cash = initialCash, quantity = 0, basis = 0, realized = 0, costTotal = 0, turnoverAmount = 0;
  const fills: DailyFill[] = [];
  const blocked: string[] = [];
  const curve: { date: string; equity: number }[] = [];
  const exposures: number[] = [];
  /** 전일 종가에 결정해 다음 봉 시가에 실행할 주문. */
  let pending: { targetWeight: number; reason: string } | undefined;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    if (pending) {
      const equity = cash + quantity * bar.open;
      // 수량은 슬리피지까지 반영한 예상 체결가로 계산한다. 시가로 계산하면 매수가 현금을 넘긴다.
      const sizingPrice = applySlippage(bar.open, "buy", tickSize, slippageTicks);
      const targetQuantity = Math.floor(equity * pending.targetWeight / (sizingPrice * (1 + commissionRate)));
      const delta = targetQuantity - quantity;
      if (delta !== 0) {
        const side = delta > 0 ? "buy" : "sell";
        const size = Math.abs(delta);
        const cost = tradeCost(costModel, { side, price: bar.open, quantity: size, instrument, date: bar.date, tickSize, slippageTicks }, commissionRate);
        const affordable = side === "buy" ? cash + cost.cashDelta >= 0 : size <= quantity;
        if (affordable) {
          if (side === "buy") { basis += cost.grossAmount + cost.commission; quantity += size; }
          else {
            const removed = basis * size / quantity;
            realized += cost.grossAmount - cost.commission - cost.tax - removed;
            basis -= removed; quantity -= size;
          }
          cash += cost.cashDelta;
          costTotal += cost.total;
          turnoverAmount += cost.grossAmount;
          fills.push({ date: bar.date, side, quantity: size, price: bar.open, cost, reason: pending.reason });
        } else blocked.push(`${bar.date}: ${side} ${size}주 실행 불가`);
      }
      pending = undefined;
    }

    // 방금 마감된 봉까지가 확정 이력이다. 체결은 다음 봉 시가이므로 미래 정보가 아니다.
    const history = bars.slice(0, i + 1);
    const equity = cash + quantity * bar.close;
    curve.push({ date: bar.date, equity });
    exposures.push(equity > 0 ? (quantity * bar.close) / equity : 0);

    if (history.length >= warmupBars && i < bars.length - 1) {
      const signal = strategy.evaluate(history, { date: bar.date, equity, quantity });
      if (signal.targetWeight < 0 || signal.targetWeight > 1) throw new Error("targetWeight must be between 0 and 1");
      pending = { targetWeight: signal.targetWeight, reason: signal.reason };
    }
  }

  const last = bars[bars.length - 1];
  const finalEquity = cash + quantity * last.close;
  const monthly = new Map<string, MonthlyRow>();
  for (const point of curve) {
    const month = point.date.slice(0, 7);
    monthly.set(month, { month, netChange: 0, costs: 0, trades: 0, endEquity: point.equity });
  }
  for (const fill of fills) {
    const row = monthly.get(fill.date.slice(0, 7));
    if (row) { row.costs += fill.cost.total; row.trades += 1; }
  }
  let previousEquity = initialCash;
  for (const row of [...monthly.values()]) { row.netChange = row.endEquity - previousEquity; previousEquity = row.endEquity; }

  const { maxDrawdown, recoveryDays } = drawdownAndRecovery(curve);
  return {
    strategy: strategy.name, strategyVersion: strategy.version, datasetVersion,
    initialCash, finalEquity, returnRate: (finalEquity - initialCash) / initialCash,
    maxDrawdown, recoveryDays, trades: fills.length, costTotal, realized,
    unrealizedAtEnd: quantity * last.close - basis,
    averageExposure: exposures.reduce((a, b) => a + b, 0) / (exposures.length || 1),
    turnover: turnoverAmount / initialCash,
    fills, monthly: [...monthly.values()], blocked,
  };
}

/** 첫 검증 대상 전략. 전 거래일 확정 종가가 N일 이동평균 위이면 보유한다. */
export function createTrendStrategy(options: { period: number; maxExposure: number; band?: number }): DailyStrategy {
  const { period, maxExposure, band = 0 } = options;
  let held = false;
  return {
    name: `kr-etf-trend-${period}`,
    version: "v0.1",
    evaluate(history) {
      const sma = simpleMovingAverage(history, period);
      const close = history[history.length - 1]?.adjustedClose;
      if (sma === undefined || close === undefined) return { targetWeight: held ? maxExposure : 0, reason: "insufficient_history" };
      if (close > sma * (1 + band)) held = true;
      else if (close < sma * (1 - band)) held = false;
      return { targetWeight: held ? maxExposure : 0, reason: held ? "above_sma" : "below_sma" };
    },
  };
}
