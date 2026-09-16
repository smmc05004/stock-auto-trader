import { describe, expect, it, vi } from "vitest";
import { probePaperBroker, validatePaperProbeEnvironment } from "./paperProbe";

const settings = {
  BROKER_PROVIDER: "kis", TRADING_MODE: "paper", ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "test", KIS_PAPER_APP_SECRET: "test", KIS_PAPER_ACCOUNT_NO: "12345678",
};

describe("paper deployment probe", () => {
  it("requires dedicated paper credentials and rejects live or custom endpoints", () => {
    expect(validatePaperProbeEnvironment(settings)).toBe("005930");
    for (const overrides of [
      { TRADING_MODE: "live" }, { ALLOW_LIVE_TRADING: "true" },
      { KIS_BASE_URL: "https://example.com" }, { KIS_PAPER_APP_KEY: "" },
      { PAPER_SYMBOL: "invalid" }, { BROKER_PROVIDER: "mock" },
    ]) {
      expect(() => validatePaperProbeEnvironment({ ...settings, ...overrides })).toThrow();
    }
  });

  it("reads sequentially, omits the account number, and never orders", async () => {
    const calls: string[] = [];
    const broker = {
      getAccountSummary: async () => {
        calls.push("account");
        return { accountNo: "12345678", cash: 1000000, currency: "KRW", totalMarketValue: 0, positions: [] };
      },
      getQuote: async () => {
        calls.push("quote");
        return { symbol: "005930", name: "test", market: "KR" as const, currency: "KRW", price: 100, changeRate: 0, timestamp: "test" };
      },
      placeOrder: vi.fn(),
    };
    const result = await probePaperBroker(broker, "005930");
    expect(calls).toEqual(["account", "quote"]);
    expect(result).not.toHaveProperty("accountNo");
    expect(result.ordersEnabled).toBe(false);
    expect(broker.placeOrder).not.toHaveBeenCalled();
    await expect(probePaperBroker(broker, "000660")).rejects.toThrow("different symbol");
    broker.getQuote = async () => ({ symbol: "005930", name: "test", market: "KR", currency: "KRW", price: 0, changeRate: 0, timestamp: "test" });
    await expect(probePaperBroker(broker, "005930")).rejects.toThrow("invalid");
  });
});
