import type { MomentumStrategyConfig } from "@/lib/strategy/config";
import type { TradingStrategy } from "@/lib/strategy/strategy";

export function createSampleMomentumStrategy(
  config: MomentumStrategyConfig,
): TradingStrategy {
  return {
    name: "sample-momentum",
    description:
      "가격 변동률만 확인하는 설정 주입형 샘플 전략입니다. 실거래에 사용하지 마세요.",
    async evaluate({ quote }) {
      if (quote.changeRate >= config.buyChangeRateThreshold) {
        return {
          symbol: quote.symbol,
          action: "buy",
          confidence: config.confidence,
          reason: `Quote change rate ${quote.changeRate}% is above the buy threshold ${config.buyChangeRateThreshold}%.`,
          suggestedOrder: {
            symbol: quote.symbol,
            side: "buy",
            type: "market",
            quantity: config.orderQuantity,
          },
        };
      }

      if (quote.changeRate <= config.sellChangeRateThreshold) {
        return {
          symbol: quote.symbol,
          action: "sell",
          confidence: config.confidence,
          reason: `Quote change rate ${quote.changeRate}% is below the sell threshold ${config.sellChangeRateThreshold}%.`,
          suggestedOrder: {
            symbol: quote.symbol,
            side: "sell",
            type: "market",
            quantity: config.orderQuantity,
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
}
