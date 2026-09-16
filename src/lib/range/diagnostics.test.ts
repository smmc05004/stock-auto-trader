import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RangeBroker } from "./broker";
vi.mock("../broker/kisBroker", () => ({ KisBrokerClient: class { async getAccessToken() { return "test-token-secret"; } } }));
beforeEach(() => {
  for (const [key, value] of Object.entries({ TRADING_MODE: "paper", ALLOW_LIVE_TRADING: "false", BROKER_PROVIDER: "kis", KIS_PAPER_APP_KEY: "test-key-secret", KIS_PAPER_APP_SECRET: "test-app-secret", KIS_PAPER_ACCOUNT_NO: "50000000", KIS_PAPER_ACCOUNT_PRODUCT_CODE: "01" })) vi.stubEnv(key, value);
  vi.stubEnv("KIS_BASE_URL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("broker diagnostics", () => {
  it("counts every expired frame, bounds event writes, and preserves timestamp limits", () => {
    const event = vi.fn(), broker = new RangeBroker(event), now = 1789520000000;
    expect(broker.acceptProviderTime(now - 5000, now)).toBe(true);
    expect(broker.acceptProviderTime(now + 5000, now)).toBe(true);
    for (let i = 0; i < 100; i++) expect(broker.acceptProviderTime(now - 5001, now)).toBe(false);
    broker.acceptProviderTime(now + 5001, now);
    broker.acceptProviderTime(NaN, now);
    expect(broker.droppedFrames).toEqual({ stale: 100, future: 1, invalidTime: 1, lastAt: now });
    expect(event).toHaveBeenCalledTimes(1);
    broker.acceptProviderTime(now, now + 60000);
    expect(event).toHaveBeenCalledTimes(2);
    expect(event.mock.calls[1][1].counts.stale).toBe(101);
  });
  it.each([200, 500])("records status, code and measured latency without raw responses (%s)", async status => {
    let now = 1789520000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const event = vi.fn(), broker = new RangeBroker(event);
    vi.stubGlobal("fetch", vi.fn(async () => {
      now += 18000;
      return new Response(JSON.stringify({ rt_cd: status === 200 ? "0" : "1", msg_cd: "EGW00215", msg1: "private-account-data", output1: [] }), { status });
    }));
    if (status === 200) await expect(broker.positions()).resolves.toEqual([]);
    else await expect(broker.positions()).rejects.toThrow("KIS HTTP 500");
    expect(event).toHaveBeenCalledWith("broker_request", expect.objectContaining({ tr: "VTTC8434R", code: "EGW00215", httpStatus: status, requestMs: 18000, totalMs: 18000, outcome: status === 200 ? "ok" : "error" }));
    expect(JSON.stringify(event.mock.calls)).not.toMatch(/test-token-secret|test-key-secret|test-app-secret|50000000|private-account-data/);
  });
  it("records timeouts and does not retry the failed request", async () => {
    const event = vi.fn(), broker = new RangeBroker(event);
    const fetchMock = vi.fn(async () => { throw new DOMException("sensitive response", "TimeoutError"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(broker.orders("2026-09-16", "2026-09-16")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith("broker_request", expect.objectContaining({ tr: "VTTC0081R", outcome: "timeout" }));
    expect(JSON.stringify(event.mock.calls)).not.toContain("sensitive response");
  });
});
