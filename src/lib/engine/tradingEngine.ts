import type { BrokerClient } from "@/lib/broker/broker";
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

  const signal = await strategy.evaluate({ account, quote });

  if (!executeOrder || !signal.suggestedOrder || signal.action === "hold") {
    return {
      strategyName: strategy.name,
      signal,
    };
  }

  const order = await broker.placeOrder(signal.suggestedOrder);

  return {
    strategyName: strategy.name,
    signal,
    order,
  };
}
