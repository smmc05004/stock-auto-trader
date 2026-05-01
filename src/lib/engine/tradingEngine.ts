import type { BrokerClient } from "@/lib/broker/broker";
import { recordOrderAttempt } from "@/lib/engine/orderHistory";
import { validateOrder } from "@/lib/engine/orderSafety";
import type { TradingStrategy } from "@/lib/strategy/strategy";
import type { TradingDecision } from "@/lib/types/trading";

type RunStrategyInput = {
  broker: BrokerClient;
  strategy: TradingStrategy;
  symbol: string;
  executeOrder?: boolean;
};

export async function runStrategy({
  broker,
  strategy,
  symbol,
  executeOrder = false,
}: RunStrategyInput): Promise<TradingDecision> {
  const [account, quote] = await Promise.all([
    broker.getAccountSummary(),
    broker.getQuote(symbol),
  ]);

  const totalAssetValue = account.cash + account.totalMarketValue;
  const cashRatio = totalAssetValue > 0 ? account.cash / totalAssetValue : 0;

  const signal = await strategy.evaluate({
    account,
    quote,
    quoteHistory: [quote],
    positions: account.positions,
    orderHistory: [],
    cashRatio,
  });

  if (!executeOrder || !signal.suggestedOrder || signal.action === "hold") {
    return {
      strategyName: strategy.name,
      signal,
    };
  }

  const safetyCheck = validateOrder({
    account,
    order: signal.suggestedOrder,
    quote,
  });

  if (!safetyCheck.allowed) {
    return {
      strategyName: strategy.name,
      signal,
      safetyCheck,
    };
  }

  const order = await broker.placeOrder(signal.suggestedOrder);
  recordOrderAttempt(signal.suggestedOrder);

  return {
    strategyName: strategy.name,
    signal,
    safetyCheck,
    order,
  };
}
