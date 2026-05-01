import { env } from "@/lib/config/env";
import { getKoreanRegularMarketSession } from "@/lib/engine/marketHours";
import { findRecentDuplicateOrder } from "@/lib/engine/orderHistory";
import type {
  AccountSummary,
  OrderRequest,
  OrderSafetyCheck,
  Quote,
} from "@/lib/types/trading";

type ValidateOrderInput = {
  account: AccountSummary;
  order: OrderRequest;
  quote: Quote;
  now?: Date;
};

function getOrderPrice(order: OrderRequest, quote: Quote) {
  return order.type === "limit" ? order.limitPrice ?? 0 : quote.price;
}

export function validateOrder({
  account,
  order,
  quote,
  now,
}: ValidateOrderInput): OrderSafetyCheck {
  const reasons: string[] = [];
  const orderPrice = getOrderPrice(order, quote);
  const estimatedOrderValue = orderPrice * order.quantity;
  const duplicateOrder = findRecentDuplicateOrder(order, now?.getTime());
  const marketSession = getKoreanRegularMarketSession(now);

  if (env.TRADING_MODE === "live" && !env.ALLOW_LIVE_TRADING) {
    reasons.push("Live trading is disabled. Set ALLOW_LIVE_TRADING=true to enable it.");
  }

  if (duplicateOrder) {
    reasons.push(
      `Duplicate order blocked within ${env.DUPLICATE_ORDER_WINDOW_MS}ms for ${order.symbol}.`,
    );
  }

  if (!marketSession.isOpen) {
    reasons.push(marketSession.reason ?? "Korean regular market is closed.");
  }

  if (order.symbol !== quote.symbol) {
    reasons.push("Order symbol does not match the evaluated quote symbol.");
  }

  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    reasons.push("Order quantity must be a positive integer.");
  }

  if (order.quantity > env.MAX_ORDER_QUANTITY) {
    reasons.push(`Order quantity exceeds MAX_ORDER_QUANTITY (${env.MAX_ORDER_QUANTITY}).`);
  }

  if (order.type === "limit" && (!order.limitPrice || order.limitPrice <= 0)) {
    reasons.push("Limit orders require a positive limitPrice.");
  }

  if (orderPrice <= 0) {
    reasons.push("Order price must be greater than zero.");
  }

  if (estimatedOrderValue > env.MAX_ORDER_VALUE) {
    reasons.push(`Estimated order value exceeds MAX_ORDER_VALUE (${env.MAX_ORDER_VALUE}).`);
  }

  if (order.side === "buy" && estimatedOrderValue > account.cash) {
    reasons.push("Estimated buy order value exceeds available cash.");
  }

  if (order.side === "sell") {
    const position = account.positions.find((item) => item.symbol === order.symbol);

    if (!position) {
      reasons.push("Cannot sell a symbol that is not currently held.");
    } else if (order.quantity > position.quantity) {
      reasons.push("Sell quantity exceeds current position quantity.");
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    estimatedOrderValue,
    maxOrderValue: env.MAX_ORDER_VALUE,
    maxOrderQuantity: env.MAX_ORDER_QUANTITY,
  };
}
