import { describe, it, expect } from 'vitest';
import { koreaOrderDate, matchStoredOrder, executionSnapshot } from './recovery';
const row = { date: '20261008', orderId: '123', symbol: '229200', side: 'buy' as const, quantity: 65, filledQuantity: 20, remainingQuantity: 45, averagePrice: 15360, cancelled: false, rejectedQuantity: 0 };
const stored = { broker_order_id: 'kis-123', submitted_at: '2026-10-07T23:59:00Z', side: 'buy' as const, requested_quantity: 65 };
describe('manual order recovery', () => {
  it('uses Korean submission date across UTC midnight', () => expect(koreaOrderDate(stored.submitted_at)).toBe('20261008'));
  it('distinguishes reused order numbers by date and symbol', () => {
    expect(matchStoredOrder([{...row,date:'20261009'}, {...row,symbol:'005930'}, row], stored, '229200')).toEqual(row);
    expect(matchStoredOrder([{...row,date:'20261009'}], stored, '229200')).toBeNull();
  });
  it('rejects ambiguous matches and missing dates', () => {
    expect(() => matchStoredOrder([row,row], stored, '229200')).toThrow();
    expect(() => koreaOrderDate('')).toThrow();
  });
  it('replaces cumulative execution totals without double counting', () => {
    const first = executionSnapshot(row, 0.000146527);
    expect(first.filled_amount_krw).toBe(307200);
    expect(executionSnapshot(row, 0.000146527)).toEqual(first);
    expect(executionSnapshot({...row, filledQuantity: 30}, 0.000146527).filled_amount_krw).toBe(460800);
    expect(first.costs_confirmed).toBe(false);
  });
});
