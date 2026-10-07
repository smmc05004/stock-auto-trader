export const MANUAL_SYMBOL = "229200";
export const DEFAULT_BUDGET_KRW = 1_000_000;
export const DEFAULT_COMMISSION_RATE = 0.000146527;

export type ManualPriceInput = {
  buyPrice: number;
  sellPrice: number;
  budget: number;
  tickSize?: number;
};

export type ManualPricePreview = {
  quantity: number;
  buyAmount: number;
  sellAmount: number;
  buyFee: number;
  sellFee: number;
  tax: number;
  netProfit: number;
  commissionRate: number;
};

const won = (value: number) => Math.ceil(value - Number.EPSILON);

export function previewManualPrice(input: ManualPriceInput): ManualPricePreview {
  const tickSize = input.tickSize ?? 5;
  if (!Number.isInteger(input.buyPrice) || input.buyPrice <= 0) throw new Error("매수가는 양의 정수여야 합니다.");
  if (!Number.isInteger(input.sellPrice) || input.sellPrice <= 0) throw new Error("매도가는 양의 정수여야 합니다.");
  if (input.sellPrice <= input.buyPrice) throw new Error("매도가는 매수가보다 높아야 합니다.");
  if (input.buyPrice % tickSize !== 0 || input.sellPrice % tickSize !== 0) throw new Error(`가격은 ${tickSize}원 호가 단위여야 합니다.`);
  if (!Number.isInteger(input.budget) || input.budget < 1 || input.budget > DEFAULT_BUDGET_KRW) throw new Error("예산은 1원 이상 100만원 이하의 정수여야 합니다.");

  const commissionRate = DEFAULT_COMMISSION_RATE;
  const quantity = Math.floor(input.budget / (input.buyPrice * (1 + commissionRate)));
  if (quantity < 1) throw new Error("예산으로 매수 가능한 수량이 없습니다.");
  const buyAmount = input.buyPrice * quantity;
  const sellAmount = input.sellPrice * quantity;
  const buyFee = won(buyAmount * commissionRate);
  const sellFee = won(sellAmount * commissionRate);
  const tax = 0;
  const netProfit = sellAmount - sellFee - tax - buyAmount - buyFee;
  if (netProfit <= 0) throw new Error("수수료를 제외한 예상 순이익이 0원 이하입니다.");
  return { quantity, buyAmount, sellAmount, buyFee, sellFee, tax, netProfit, commissionRate };
}
