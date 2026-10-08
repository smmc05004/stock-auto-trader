import type { PaperDailyOrder } from '../broker/paperOrders';

export function koreaOrderDate(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error('Missing or invalid order submission date');
  return new Date(time + 9 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
}

export function matchStoredOrder(rows: PaperDailyOrder[], stored: {
  broker_order_id: string | null; submitted_at: string | null; side: 'buy' | 'sell'; requested_quantity: number;
}, symbol: string): PaperDailyOrder | null {
  if (!stored.submitted_at || !stored.broker_order_id) throw new Error('Order requires reconciliation');
  const id = stored.broker_order_id.split('-').at(-1);
  const date = koreaOrderDate(stored.submitted_at);
  const matches = rows.filter(row => row.date === date && row.orderId === id && row.symbol === symbol && row.side === stored.side && row.quantity === stored.requested_quantity);
  if (matches.length > 1) throw new Error('Ambiguous broker order');
  return matches[0] ?? null;
}

// A cumulative snapshot is replaced, never appended as another execution.
export function executionSnapshot(order: PaperDailyOrder, commissionRate: number) {
  if (order.filledQuantity > 0 && !(order.averagePrice > 0)) throw new Error('Missing execution price');
  if (!Number.isFinite(commissionRate) || commissionRate < 0) throw new Error('Invalid commission rate');
  const amount = Math.round(order.averagePrice * order.filledQuantity);
  return { filled_quantity: order.filledQuantity, average_fill_price_krw: order.averagePrice,
    filled_amount_krw: amount, estimated_fee_krw: Math.ceil(amount * commissionRate), costs_confirmed: false };
}
