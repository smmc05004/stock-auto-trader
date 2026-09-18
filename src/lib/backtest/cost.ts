/**
 * 거래 비용 모델. 상품 분류와 시행일에 따라 버전을 관리한다.
 * 모든 요율은 확인된 출처를 함께 기록하며, 확인되지 않은 값을 기본값으로 쓰지 않는다.
 */
export type InstrumentClass =
  | "kospi_stock"
  | "kosdaq_stock"
  | "domestic_equity_etf"
  | "other_etf";

export type CostSchedule = {
  /** 이 요율이 적용되기 시작하는 날짜(YYYY-MM-DD, 포함). */
  effectiveFrom: string;
  /** 편도 위탁수수료율. 계좌 개설 경로에 따라 다르므로 호출자가 실제 요율을 주입한다. */
  commissionRate: number;
  /** 매도 시 증권거래세 + 농어촌특별세 합계. 매수에는 부과하지 않는다. */
  sellTaxRate: number;
  /** 요율 근거. 출처 없이 숫자만 두지 않는다. */
  basis: string;
};

export type CostModel = {
  version: string;
  schedules: Partial<Record<InstrumentClass, CostSchedule[]>>;
};

export type TradeCostInput = {
  side: "buy" | "sell";
  price: number;
  quantity: number;
  instrument: InstrumentClass;
  /** 체결일(YYYY-MM-DD). 시행일이 다른 요율을 고르는 데 쓴다. */
  date: string;
  /** 호가 단위. 슬리피지를 틱으로 계산한다. */
  tickSize: number;
  /** 불리한 방향으로 가정할 틱 수. 기본 1틱. */
  slippageTicks?: number;
};

export type TradeCost = {
  /** 슬리피지를 반영한 실제 체결 가정 가격. */
  effectivePrice: number;
  grossAmount: number;
  commission: number;
  tax: number;
  slippage: number;
  /** 수수료 + 세금 + 슬리피지. */
  total: number;
  /** 현금 증감. 매수는 음수, 매도는 양수. */
  cashDelta: number;
  scheduleBasis: string;
};

/**
 * 2026년 기준 국내 요율. 수수료는 계좌마다 다르므로 0으로 두고 호출자가 주입하게 한다.
 * 0을 "수수료 없음"으로 해석하지 않도록 resolveSchedule에서 검증한다.
 */
export const KR_COST_MODEL_2026: CostModel = {
  version: "kr-2026-01",
  schedules: {
    kospi_stock: [{
      effectiveFrom: "2026-01-01",
      commissionRate: 0,
      sellTaxRate: 0.002,
      basis: "증권거래세 0.05% + 농어촌특별세 0.15% (2026 환원). 수수료는 계좌별 확인 필요",
    }],
    kosdaq_stock: [{
      effectiveFrom: "2026-01-01",
      commissionRate: 0,
      sellTaxRate: 0.002,
      basis: "증권거래세 0.20% (농특세 없음, 2026 환원). 수수료는 계좌별 확인 필요",
    }],
    domestic_equity_etf: [{
      effectiveFrom: "2026-01-01",
      commissionRate: 0,
      sellTaxRate: 0,
      basis: "국내 상장 ETF 매도 증권거래세 비과세로 가정. KIS/KRX 공식 안내로 재확인 필요",
    }],
    other_etf: [{
      effectiveFrom: "2026-01-01",
      commissionRate: 0,
      sellTaxRate: 0,
      basis: "채권형·원자재형 등. 매매차익 배당소득세는 이 모델이 아니라 계좌 과세로 별도 처리",
    }],
  },
};

export function resolveSchedule(model: CostModel, instrument: InstrumentClass, date: string): CostSchedule {
  const list = model.schedules[instrument];
  if (!list?.length) throw new Error(`No cost schedule for ${instrument}`);
  const applicable = list.filter(s => s.effectiveFrom <= date).sort((a, b) => a.effectiveFrom < b.effectiveFrom ? 1 : -1);
  if (!applicable.length) throw new Error(`No cost schedule effective on ${date} for ${instrument}`);
  return applicable[0];
}

/** 호가 단위로 불리하게 반올림한다. 매수는 올림, 매도는 내림. */
export function applySlippage(price: number, side: "buy" | "sell", tickSize: number, ticks: number) {
  if (!(tickSize > 0)) throw new Error("tickSize must be positive");
  const shifted = price + (side === "buy" ? ticks : -ticks) * tickSize;
  const rounded = side === "buy" ? Math.ceil(shifted / tickSize) : Math.floor(shifted / tickSize);
  return Math.max(rounded * tickSize, tickSize);
}

export function tradeCost(model: CostModel, input: TradeCostInput, commissionRate: number): TradeCost {
  const { side, price, quantity, instrument, date, tickSize, slippageTicks = 1 } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (!(price > 0)) throw new Error("price must be positive");
  if (!(commissionRate >= 0) || commissionRate >= 0.01) throw new Error("commissionRate must be a plausible decimal rate");
  const schedule = resolveSchedule(model, instrument, date);
  const effectivePrice = applySlippage(price, side, tickSize, slippageTicks);
  const grossAmount = effectivePrice * quantity;
  const slippage = Math.abs(effectivePrice - price) * quantity;
  const commission = grossAmount * commissionRate;
  const tax = side === "sell" ? grossAmount * schedule.sellTaxRate : 0;
  const total = commission + tax + slippage;
  return {
    effectivePrice, grossAmount, commission, tax, slippage, total,
    cashDelta: side === "buy" ? -(grossAmount + commission) : grossAmount - commission - tax,
    scheduleBasis: schedule.basis,
  };
}

/** 같은 규모로 한 번 사고 한 번 파는 데 드는 비용 비율. 전략 문턱 계산에 쓴다. */
export function roundTripCostRate(model: CostModel, instrument: InstrumentClass, date: string, commissionRate: number, price: number, tickSize: number, slippageTicks = 1) {
  const buy = tradeCost(model, { side: "buy", price, quantity: 1, instrument, date, tickSize, slippageTicks }, commissionRate);
  const sell = tradeCost(model, { side: "sell", price, quantity: 1, instrument, date, tickSize, slippageTicks }, commissionRate);
  return (buy.total + sell.total) / price;
}
