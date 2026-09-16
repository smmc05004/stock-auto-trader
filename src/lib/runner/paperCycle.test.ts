import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRecentBar, planPaperCycle, testSessionAllowed, type PaperCycle } from "./paperCycle";
import { readCycle, saveCycle, withPaperLock } from "./paperJournal";
import { dailyOrderSchema } from "../broker/paperOrders";

const state: PaperCycle = { version: 1, accountHash: "test", symbol: "005930", complete: false };
const buy = { date: "20260911", status: "accepted" as const, orderId: "123-000001", price: 269000 };
const fill = { date: "20260911", orderId: "000001", symbol: "005930", side: "buy" as const,
  quantity: 1, filledQuantity: 1, remainingQuantity: 0, averagePrice: 269000, cancelled: false, rejectedQuantity: 0 };

describe("one-cycle paper test", () => {
  it("buys only once and sells only after broker fill and balance agree", () => {
    expect(planPaperCycle(state, [], 0)).toBe("buy");
    expect(planPaperCycle(state, [], 1)).toBe("blocked_existing_activity");
    expect(planPaperCycle(state, [fill], 0)).toBe("blocked_existing_activity");
    expect(planPaperCycle({ ...state, buy }, [], 0)).toBe("awaiting_broker_order");
    expect(planPaperCycle({ ...state, buy }, [{ ...fill, filledQuantity: 0, remainingQuantity: 1 }], 0)).toBe("awaiting_fill");
    expect(planPaperCycle({ ...state, buy }, [fill], 0)).toBe("awaiting_balance");
    expect(planPaperCycle({ ...state, buy }, [fill], 1)).toBe("sell");
    expect(planPaperCycle({ ...state, buy }, [fill, { ...fill, orderId: "external" }], 1)).toBe("blocked_existing_activity");
  });

  it("never retries unknown, interrupted, rejected, or changed orders", () => {
    for (const status of ["unknown", "submitting", "rejected"] as const) {
      expect(planPaperCycle({ ...state, buy: { ...buy, status } }, [fill], 1)).toBe("blocked_unconfirmed_submission");
    }
    expect(planPaperCycle({ ...state, buy }, [{ ...fill, cancelled: true }], 1)).toBe("blocked_order_changed");
    const sell = { ...buy, orderId: "123-000002" };
    const sellFill = { ...fill, side: "sell" as const, orderId: "000002" };
    expect(planPaperCycle({ ...state, buy, sell }, [fill, sellFill], 0)).toBe("complete");
    expect(planPaperCycle({ ...state, complete: true }, [], 0)).toBe("complete");
  });

  it("requires explicit date, weekday, trading window and recent same-day data", () => {
    const now = new Date("2026-09-11T00:15:00Z");
    expect(testSessionAllowed("2026-09-11", now)).toBe(false);
    expect(testSessionAllowed("2026-09-11", new Date("2026-09-11T01:29:59Z"))).toBe(false);
    expect(testSessionAllowed("2026-09-11", new Date("2026-09-11T01:30:00Z"))).toBe(true);
    expect(testSessionAllowed(undefined, now)).toBe(false);
    expect(testSessionAllowed("2026-09-10", now)).toBe(false);
    expect(testSessionAllowed("2026-09-12", new Date("2026-09-12T00:15:00Z"))).toBe(false);
    expect(testSessionAllowed("2026-09-11", new Date("2026-09-11T06:10:00Z"))).toBe(false);
    expect(isRecentBar("20260911", "091400", now)).toBe(true);
    expect(isRecentBar("20260910", "091400", now)).toBe(false);
    expect(isRecentBar("20260911", "091600", now)).toBe(false);
    expect(isRecentBar("20260911", "090000", now)).toBe(false);
  });

  it("persists intents across restarts and blocks concurrent runs and corrupt journals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paper-cycle-"));
    try {
      await withPaperLock(dir, async () => {
        await expect(withPaperLock(dir, async () => undefined)).rejects.toThrow("lock");
        await saveCycle(dir, { ...state, buy: { ...buy, status: "submitting" } });
      });
      const restored = await readCycle(dir);
      expect(planPaperCycle(restored!, [], 0)).toBe("blocked_unconfirmed_submission");
      await writeFile(path.join(dir, "cycle.json"), "broken");
      await expect(readCycle(dir)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("validates broker fills without silently converting malformed amounts to zero", () => {
    const row = { ord_dt: "20260911", odno: "000001", pdno: "005930", sll_buy_dvsn_cd: "02",
      ord_qty: "1", tot_ccld_qty: "1", rmn_qty: "0", avg_prvs: "269000", cncl_yn: "N", rjct_qty: "0" };
    expect(dailyOrderSchema.parse(row)).toEqual(fill);
    expect(() => dailyOrderSchema.parse({ ...row, avg_prvs: "bad" })).toThrow();
    expect(() => dailyOrderSchema.parse({ ...row, ord_qty: "-1" })).toThrow();
  });
});
