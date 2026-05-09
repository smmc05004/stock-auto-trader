import type { BrokerClient } from "@/lib/broker/broker";
import { reserveOrderAttempt } from "@/lib/engine/orderHistory";
import { validateOrder } from "@/lib/engine/orderSafety";
import type { TradingStrategy } from "@/lib/strategy/strategy";
import { appendAuditLog } from "@/lib/storage/auditLog";
import type { TradingDecision } from "@/lib/types/trading";

type RunStrategyInput = {
  broker: BrokerClient;
  strategy: TradingStrategy;
  symbol: string;
  executeOrder?: boolean;
};

async function appendAuditLogSafely(event: Parameters<typeof appendAuditLog>[0]) {
  await appendAuditLog(event).catch(() => undefined);
}

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

  await appendAuditLogSafely({
    type: "strategy_evaluated",
    strategyName: strategy.name,
    symbol,
    signal,
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
    await appendAuditLogSafely({
      type: "order_blocked",
      strategyName: strategy.name,
      symbol,
      order: signal.suggestedOrder,
      safetyCheck,
    });

    return {
      strategyName: strategy.name,
      signal,
      safetyCheck,
    };
  }

  const orderReserved = reserveOrderAttempt(signal.suggestedOrder);

  if (!orderReserved) {
    const duplicateSafetyCheck = {
      ...safetyCheck,
      allowed: false,
      reasons: [
        ...safetyCheck.reasons,
        "Duplicate order blocked because another matching order is already being processed.",
      ],
    };

    await appendAuditLogSafely({
      type: "order_blocked",
      strategyName: strategy.name,
      symbol,
      order: signal.suggestedOrder,
      safetyCheck: duplicateSafetyCheck,
    });

    return {
      strategyName: strategy.name,
      signal,
      safetyCheck: duplicateSafetyCheck,
    };
  }

  const order = await broker.placeOrder(signal.suggestedOrder);
  await appendAuditLogSafely({
    type: "order_requested",
    strategyName: strategy.name,
    symbol,
    order: signal.suggestedOrder,
    safetyCheck,
    result: order,
  });

  return {
    strategyName: strategy.name,
    signal,
    safetyCheck,
    order,
  };
}
