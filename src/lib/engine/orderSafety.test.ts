import { describe, expect, it, vi } from "vitest";
import type { AccountSummary, OrderRequest, Quote } from "@/lib/types/trading";

const baseAccount: AccountSummary = {
  accountNo: "12345678",
  cash: 1_000_000,
  currency: "KRW",
  totalMarketValue: 1_000_000,
  positions: [
    {
      symbol: "005930",
      name: "Samsung Electronics",
      quantity: 5,
      averagePrice: 70_000,
      currentPrice: 73_500,
      currency: "KRW",
    },
  ],
};

const baseQuote: Quote = {
  symbol: "005930",
  name: "Samsung Electronics",
  market: "KR",
  price: 73_500,
  changeRate: 1.2,
  currency: "KRW",
  timestamp: "2026-05-01T00:00:00.000Z",
};

async function validateWithEnv(
  env: Record<string, unknown>,
  order: OrderRequest,
  account: AccountSummary = baseAccount,
  quote: Quote = baseQuote,
) {
  vi.resetModules();
  vi.doMock("@/lib/config/env", () => ({
    env: {
      TRADING_MODE: "paper",
      ALLOW_LIVE_TRADING: false,
      MAX_ORDER_VALUE: 1_000_000,
      MAX_ORDER_QUANTITY: 10,
      ...env,
    },
  }));

  const { validateOrder } = await import("@/lib/engine/orderSafety");

  return validateOrder({
    account,
    order,
    quote,
  });
}

describe("validateOrder", () => {
  it("allows a valid paper buy order", async () => {
    const result = await validateWithEnv(
      {},
      {
        symbol: "005930",
        side: "buy",
        type: "market",
        quantity: 1,
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.estimatedOrderValue).toBe(73_500);
  });

  it("blocks live orders unless live trading is explicitly enabled", async () => {
    const result = await validateWithEnv(
      {
        TRADING_MODE: "live",
        ALLOW_LIVE_TRADING: false,
      },
      {
        symbol: "005930",
        side: "buy",
        type: "market",
        quantity: 1,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(
      "Live trading is disabled. Set ALLOW_LIVE_TRADING=true to enable it.",
    );
  });

  it("blocks orders above the configured maximum value", async () => {
    const result = await validateWithEnv(
      {
        MAX_ORDER_VALUE: 100_000,
      },
      {
        symbol: "005930",
        side: "buy",
        type: "market",
        quantity: 2,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Estimated order value exceeds MAX_ORDER_VALUE (100000).");
  });

  it("blocks sell orders that exceed the current position", async () => {
    const result = await validateWithEnv(
      {},
      {
        symbol: "005930",
        side: "sell",
        type: "market",
        quantity: 6,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Sell quantity exceeds current position quantity.");
  });

  it("requires a positive limit price for limit orders", async () => {
    const result = await validateWithEnv(
      {},
      {
        symbol: "005930",
        side: "buy",
        type: "limit",
        quantity: 1,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Limit orders require a positive limitPrice.");
  });
});
