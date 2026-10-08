import { expect, it } from 'vitest';
import { getOrderUnitPrice } from './kisBroker';
it('preserves ETF user limit prices instead of rounding away the spread', () => {
  expect(getOrderUnitPrice({symbol:'229200',side:'sell',type:'limit',quantity:65,limitPrice:15365})).toBe('15365');
  expect(getOrderUnitPrice({symbol:'229200',side:'buy',type:'limit',quantity:65,limitPrice:15360})).toBe('15360');
});
it('rejects invalid limit prices and leaves market division price at zero', () => {
  expect(() => getOrderUnitPrice({symbol:'229200',side:'sell',type:'limit',quantity:1,limitPrice:0})).toThrow();
  expect(getOrderUnitPrice({symbol:'229200',side:'sell',type:'market',quantity:1})).toBe('0');
});
