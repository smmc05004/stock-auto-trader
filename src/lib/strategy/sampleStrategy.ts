import type { TradingStrategy } from "@/lib/strategy/strategy";

export const sampleMomentumStrategy: TradingStrategy = {
  name: "sample-momentum",
  description: "가격 변동률만 확인하는 샘플 전략입니다. 실거래에 사용하지 마세요.",
  async evaluate({ quote }) {
    if (quote.changeRate >= 1) {
      return {
        symbol: quote.symbol,
        action: "buy",
        confidence: 0.35,
        reason: "Mock quote change rate is above the sample threshold.",
        suggestedOrder: {
          symbol: quote.symbol,
          side: "buy",
          type: "market",
          quantity: 1,
        },
      };
    }

    if (quote.changeRate <= -1) {
      return {
        symbol: quote.symbol,
        action: "sell",
        confidence: 0.35,
        reason: "Mock quote change rate is below the sample threshold.",
        suggestedOrder: {
          symbol: quote.symbol,
          side: "sell",
          type: "market",
          quantity: 1,
        },
      };
    }

    return {
      symbol: quote.symbol,
      action: "hold",
      confidence: 0.2,
      reason: "No sample strategy threshold was met.",
    };
  },
};
