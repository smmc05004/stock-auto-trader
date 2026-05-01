import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/backtest/sample/route";

function createRequest(body: unknown) {
  return new Request("http://localhost/api/backtest/sample", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/backtest/sample", () => {
  it("returns a sample backtest result", async () => {
    const response = await POST(createRequest({ initialCash: 1_000_000, feeRate: 0 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.strategyName).toBe("sample-momentum");
    expect(data.dataPoints).toBeGreaterThan(0);
    expect(data.tradeCount).toBeGreaterThan(0);
    expect(data.trades.length).toBe(data.tradeCount);
  });

  it("returns 400 for invalid input", async () => {
    const response = await POST(createRequest({ initialCash: -1 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid backtest request.");
  });
});
