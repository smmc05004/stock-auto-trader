import { env } from "@/lib/config/env";
import type { OrderRequest } from "@/lib/types/trading";

type OrderHistoryEntry = {
  key: string;
  recordedAt: number;
};

const orderHistoryKey = "__stockAutoTraderOrderHistory";

function getOrderHistory() {
  const globalStore = globalThis as typeof globalThis & {
    [orderHistoryKey]?: OrderHistoryEntry[];
  };

  globalStore[orderHistoryKey] ??= [];

  return globalStore[orderHistoryKey];
}

export function getDuplicateOrderKey(order: OrderRequest) {
  return [order.symbol, order.side, order.type].join(":");
}

export function findRecentDuplicateOrder(order: OrderRequest, now = Date.now()) {
  if (env.DUPLICATE_ORDER_WINDOW_MS === 0) {
    return undefined;
  }

  const duplicateKey = getDuplicateOrderKey(order);
  const cutoff = now - env.DUPLICATE_ORDER_WINDOW_MS;

  return getOrderHistory().find(
    (entry) => entry.key === duplicateKey && entry.recordedAt >= cutoff,
  );
}

export function recordOrderAttempt(order: OrderRequest, now = Date.now()) {
  const history = getOrderHistory();
  const cutoff = now - env.DUPLICATE_ORDER_WINDOW_MS;

  history.push({
    key: getDuplicateOrderKey(order),
    recordedAt: now,
  });

  const retained = history.filter((entry) => entry.recordedAt >= cutoff);
  history.splice(0, history.length, ...retained);
}

export function reserveOrderAttempt(order: OrderRequest, now = Date.now()) {
  if (findRecentDuplicateOrder(order, now)) {
    return false;
  }

  recordOrderAttempt(order, now);

  return true;
}

export function clearOrderHistory() {
  getOrderHistory().splice(0);
}
