/** 일봉과 무결성 검사. 미래 데이터가 과거 신호를 바꾸지 못하도록 데이터셋 버전을 함께 관리한다. */
export type DailyBar = {
  symbol: string;
  /** 거래일 YYYY-MM-DD (KST). */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 분배금·분할을 반영한 수정 종가. 신호 계산에는 이 값을 쓴다. */
  adjustedClose: number;
  /** 해당 일자에 지급된 주당 분배금. 없으면 0. */
  distribution: number;
};

export type BarIssue = { kind: string; date?: string; detail: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 적재 시 검사. 실패 항목이 있으면 호출자가 신규 주문과 백테스트를 막는다.
 * 휴장일을 알 수 없으므로 "결측일"은 판단하지 않고 간격만 보고한다.
 */
export function checkBars(bars: DailyBar[], options: { maxChangeRate?: number; maxGapDays?: number } = {}): BarIssue[] {
  const { maxChangeRate = 0.3, maxGapDays = 10 } = options;
  const issues: BarIssue[] = [];
  const seen = new Set<string>();
  let previous: DailyBar | undefined;

  for (const bar of bars) {
    if (!DATE.test(bar.date)) { issues.push({ kind: "invalid_date", date: bar.date, detail: "YYYY-MM-DD 형식이 아니다" }); continue; }
    if (seen.has(bar.date)) issues.push({ kind: "duplicate_date", date: bar.date, detail: "같은 거래일이 두 번 있다" });
    seen.add(bar.date);
    if (previous && bar.date <= previous.date) issues.push({ kind: "out_of_order", date: bar.date, detail: `${previous.date} 다음에 ${bar.date}가 온다` });

    for (const [field, value] of [["open", bar.open], ["high", bar.high], ["low", bar.low], ["close", bar.close], ["adjustedClose", bar.adjustedClose]] as const) {
      if (!Number.isFinite(value) || value <= 0) issues.push({ kind: "invalid_price", date: bar.date, detail: `${field}=${value}` });
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) issues.push({ kind: "invalid_volume", date: bar.date, detail: `volume=${bar.volume}` });
    if (bar.distribution < 0) issues.push({ kind: "invalid_distribution", date: bar.date, detail: `distribution=${bar.distribution}` });
    if (bar.high < bar.low) issues.push({ kind: "high_below_low", date: bar.date, detail: `${bar.high} < ${bar.low}` });
    if (bar.open > bar.high || bar.open < bar.low || bar.close > bar.high || bar.close < bar.low) {
      issues.push({ kind: "ohlc_out_of_range", date: bar.date, detail: `O${bar.open} H${bar.high} L${bar.low} C${bar.close}` });
    }

    if (previous) {
      const change = Math.abs(bar.adjustedClose - previous.adjustedClose) / previous.adjustedClose;
      // 분할·병합이 수정계수에 반영되지 않으면 여기서 드러난다.
      if (change > maxChangeRate) issues.push({ kind: "implausible_change", date: bar.date, detail: `수정종가 변동 ${(change * 100).toFixed(1)}%` });
      const gapDays = Math.round((Date.parse(`${bar.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) / 86400_000);
      if (gapDays > maxGapDays) issues.push({ kind: "long_gap", date: bar.date, detail: `직전 거래일과 ${gapDays}일 차이` });
    }
    previous = bar;
  }
  if (bars.some(b => b.symbol !== bars[0]?.symbol)) issues.push({ kind: "mixed_symbols", detail: "한 데이터셋에 여러 종목이 섞여 있다" });
  return issues;
}

/** 신호 계산에 쓸 수 있는 상태인지. 하나라도 문제가 있으면 쓰지 않는다. */
export function barsUsable(bars: DailyBar[], minimum: number) {
  const issues = checkBars(bars);
  if (issues.length) return { usable: false as const, reason: "integrity_failed", issues };
  if (bars.length < minimum) return { usable: false as const, reason: "insufficient_history", issues };
  return { usable: true as const, reason: "ok", issues };
}

/** 확정된 과거 구간만 남긴다. 당일 진행 중인 봉을 신호에 쓰지 않기 위한 장치. */
export function confirmedBars(bars: DailyBar[], asOfDate: string) {
  return bars.filter(b => b.date < asOfDate);
}

export function simpleMovingAverage(bars: DailyBar[], period: number) {
  if (period <= 0 || bars.length < period) return undefined;
  const window = bars.slice(-period);
  return window.reduce((total, bar) => total + bar.adjustedClose, 0) / period;
}
