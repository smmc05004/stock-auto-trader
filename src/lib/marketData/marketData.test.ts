import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BarStore } from "./store";
import { collectDailyBars, parseKisDailyRows, type KisDailyRow } from "./kis";
import { barsUsable, confirmedBars, type DailyBar } from "./bars";

const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(f => f()));
function store() {
  const dir = mkdtempSync(path.join(tmpdir(), "bars-test-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new BarStore(path.join(dir, "bars.sqlite"), () => 1);
  clean.push(() => s.close());
  return s;
}
function bar(date: string, close: number): DailyBar {
  return { symbol: "229200", date, open: close, high: close, low: close, close, volume: 10, adjustedClose: close, distribution: 0 };
}
function row(date: string, close: number): KisDailyRow {
  return { stck_bsop_date: date, stck_oprc: String(close), stck_hgpr: String(close), stck_lwpr: String(close), stck_clpr: String(close), acml_vol: "10" };
}

describe("KIS daily parsing", () => {
  it("converts and sorts rows oldest first", () => {
    const bars = parseKisDailyRows("229200", [row("20260105", 120), row("20260102", 100)], { adjusted: true });
    expect(bars.map(b => b.date)).toEqual(["2026-01-02", "2026-01-05"]);
    expect(bars[0].adjustedClose).toBe(100);
  });
  it("throws instead of coercing malformed numbers or dates to zero", () => {
    expect(() => parseKisDailyRows("229200", [{ ...row("20260102", 100), stck_clpr: "" }], { adjusted: true })).toThrow(/stck_clpr/);
    expect(() => parseKisDailyRows("229200", [{ ...row("2026-01-02", 100) }], { adjusted: true })).toThrow(/stck_bsop_date/);
  });
  it("refuses to present raw prices as adjusted closes", () => {
    const bars = parseKisDailyRows("229200", [row("20260102", 100)], { adjusted: false });
    expect(Number.isNaN(bars[0].adjustedClose)).toBe(true);
    // 무결성 검사가 이를 막아야 백테스트로 새어 들어가지 않는다.
    expect(barsUsable(bars, 1).usable).toBe(false);
  });
  it("pages backwards over the range and de-duplicates overlaps", async () => {
    const calls: string[] = [];
    const bars = await collectDailyBars(async ({ start, end }) => {
      calls.push(`${start}..${end}`);
      return start <= "2026-01-03" ? [row("20260102", 100), row("20260103", 101)] : [row("20260104", 102)];
    }, { symbol: "229200", start: "2026-01-01", end: "2026-01-06", adjusted: true, chunkDays: 3 });
    expect(calls.length).toBe(2);
    expect(bars.map(b => b.date)).toEqual(["2026-01-02", "2026-01-03", "2026-01-04"]);
  });
  it("stops rather than looping forever when the range is invalid", async () => {
    await expect(collectDailyBars(async () => [], { symbol: "229200", start: "2026-02-01", end: "2026-01-01", adjusted: true })).rejects.toThrow(/range/);
  });
});

describe("bar store", () => {
  it("rejects a batch that fails integrity and writes nothing", () => {
    const s = store();
    const result = s.ingest([bar("2026-01-02", 100), bar("2026-01-01", 100)], "v1");
    expect(result.written).toBe(0);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(s.read("229200")).toEqual([]);
  });
  it("stores, reads back in order and filters by range", () => {
    const s = store();
    expect(s.ingest([bar("2026-01-02", 100), bar("2026-01-05", 101), bar("2026-01-06", 102)], "v1").written).toBe(3);
    expect(s.read("229200").map(b => b.date)).toEqual(["2026-01-02", "2026-01-05", "2026-01-06"]);
    expect(s.read("229200", { from: "2026-01-05" }).map(b => b.date)).toEqual(["2026-01-05", "2026-01-06"]);
  });
  it("records a retroactive price revision instead of silently overwriting", () => {
    const s = store();
    s.ingest([bar("2026-01-02", 100)], "v1");
    s.ingest([bar("2026-01-02", 95)], "v2");
    const revisions = s.revisions("229200");
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.some(r => r.field === "close" && Number(r.previous) === 100 && Number(r.next) === 95)).toBe(true);
    expect(s.read("229200")[0].close).toBe(95);
  });
  it("round-trips instrument metadata used by the cost model", () => {
    const s = store();
    s.putInstrument({ symbol: "229200", name: "KODEX 코스닥150", instrumentClass: "domestic_equity_etf", tickSize: 5 });
    expect(s.getInstrument("229200")).toEqual({ symbol: "229200", name: "KODEX 코스닥150", instrumentClass: "domestic_equity_etf", tickSize: 5 });
    expect(s.getInstrument("000000")).toBeUndefined();
  });
});

describe("confirmed history", () => {
  it("excludes the in-progress day so a signal cannot see it", () => {
    const bars = [bar("2026-01-02", 100), bar("2026-01-05", 101)];
    expect(confirmedBars(bars, "2026-01-05").map(b => b.date)).toEqual(["2026-01-02"]);
  });
});
