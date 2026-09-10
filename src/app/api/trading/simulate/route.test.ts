import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function createRequest(body: unknown) {
  return new NextRequest("http://localhost/api/trading/simulate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function loadRoute(orderExecutionToken?: string) {
  vi.resetModules();
  vi.doMock("@/lib/config/env", () => ({
    env: {
      BROKER_PROVIDER: "mock",
      TRADING_MODE: "paper",
      TRADING_MARKET: "KR",
      TRADING_BASE_CURRENCY: "KRW",
      MAX_ORDER_VALUE: 1_000_000,
      MAX_ORDER_QUANTITY: 10,
      DUPLICATE_ORDER_WINDOW_MS: 60_000,
      ALLOW_LIVE_TRADING: false,
      ORDER_EXECUTION_TOKEN: orderExecutionToken,
    },
  }));
  vi.doMock("@/lib/broker", () => ({
    createBrokerClient: () => ({
      getAccountSummary: async () => ({
        accountNo: "PAPER-ACCOUNT",
        cash: 1_000_000,
        currency: "KRW",
        totalMarketValue: 0,
        positions: [],
      }),
      getQuote: async (symbol: string) => ({
        symbol,
        name: "Samsung Electronics",
        market: "KR",
        price: 73_500,
        changeRate: 0,
        currency: "KRW",
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
      placeOrder: async () => ({
        orderId: "mock-order",
        accepted: true,
        mode: "paper",
        message: "Accepted",
        requestedAt: "2026-05-01T00:00:00.000Z",
      }),
    }),
  }));

  return import("@/app/api/trading/simulate/route");
}

describe("POST /api/trading/simulate", () => {
  it("runs strategy evaluation without an execution token when orders are not executed", async () => {
    const { POST } = await loadRoute();
    const response = await POST(createRequest({ symbol: "005930" }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.strategyName).toBe("sample-momentum");
    expect(data.signal.symbol).toBe("005930");
    expect(data.order).toBeUndefined();
  });

  it("applies request strategy settings to the sample strategy", async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      createRequest({
        symbol: "005930",
        strategyConfig: {
          buyChangeRateThreshold: -0.1,
          orderQuantity: 4,
          confidence: 0.8,
        },
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.signal.action).toBe("buy");
    expect(data.signal.confidence).toBe(0.8);
    expect(data.signal.suggestedOrder).toMatchObject({
      side: "buy",
      quantity: 4,
    });
  });

  it("blocks order execution without a matching execution token", async () => {
    const { POST } = await loadRoute("secret-token");
    const response = await POST(createRequest({ symbol: "005930", executeOrder: true }));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe("Order execution is disabled or the execution token is invalid.");
  });

  it("returns 400 when the symbol is empty", async () => {
    const { POST } = await loadRoute();
    const response = await POST(createRequest({ symbol: "" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid simulation request.");
    expect(data.details.symbol).toEqual(["String must contain at least 1 character(s)"]);
  });

  it("returns 400 when executeOrder is not a boolean", async () => {
    const { POST } = await loadRoute();
    const response = await POST(createRequest({ symbol: "005930", executeOrder: "true" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid simulation request.");
    expect(data.details.executeOrder).toEqual(["Expected boolean, received string"]);
  });

  it("returns 400 when strategy settings are outside the accepted range", async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      createRequest({
        symbol: "005930",
        strategyConfig: {
          confidence: 2,
        },
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid simulation request.");
    expect(data.details.strategyConfig).toEqual(["Number must be less than or equal to 1"]);
  });
});
