import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RangeEngine, type State } from "./engine";
import { RangeStore } from "./store";
import { dataQuality, type Sample } from "./strategy";
import { entryReport } from "./report";

const start = Date.parse("2026-09-16T10:00:00+09:00");
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture(initial = start) {
  let now = initial;
  const dir = mkdtempSync(path.join(tmpdir(), "range-clock-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RangeStore(path.join(dir, "range.sqlite"), () => now);
  store.claim(); cleanup.push(() => store.close());
  const broker = { orders: vi.fn(async () => []), positions: vi.fn(async () => []),
    submit: vi.fn(async () => ({ id: "123", org: "001" })), cancel: vi.fn(async () => "124") };
  const engine = new RangeEngine(store, broker, { start: "2026-09-14", end: "2026-09-25", fee: .000146527, enabled: true, cancellationVerified: true }, () => now);
  const sample = (t: number): Sample => {
    const bid = Math.floor((14000 + 100 * Math.sin((t - initial) / 15000)) / 5) * 5;
    return { at: t, bid, ask: bid + 5, bidSize: 100, askSize: 100 };
  };
  engine.samples = Array.from({ length: 1801 }, (_, i) => sample(initial - 1800000 + i * 1000));
  engine.latest = engine.samples.at(-1); engine.lastTrade = now;
  engine.state.date = "2026-09-16";
  engine.state.days = ["2026-09-14", "2026-09-15", "2026-09-16"];
  const advance = (seconds: number, collect = true) => {
    for (let i = 0; i < seconds; i++) {
      now += 1000;
      if (collect) { engine.quote(sample(now)); engine.lastTrade = now; }
    }
    if (collect) engine.latest = { ...sample(now), bid: 14040, ask: 14045 };
  };
  return { engine, broker, store, advance, now: () => now };
}
describe("evaluation after broker IO", () => {
  it("enters with continuous data during a 20-second reconciliation instead of falsely warming", async () => {
    const f = fixture();
    f.broker.orders.mockImplementationOnce(async () => { f.advance(12); return []; });
    f.broker.positions.mockImplementationOnce(async () => { f.advance(8); return []; });
    await f.engine.tick();
    // The pre-fix clock demonstrably rejects this same pruned buffer.
    expect(dataQuality(f.engine.samples, start).reason).toBe("warming_30m");
    expect(f.engine.state.lastEval).toBe(f.now());
    expect(f.engine.state.lastDecision).toMatchObject({ at: f.now(), reason: "entry_selected", marketData: { ready: true } });
    expect(f.broker.submit).toHaveBeenCalledWith("buy", 3, expect.any(Number));
  });
  it("still blocks a real gap even when the latest quote is fresh", async () => {
    const f = fixture();
    f.broker.orders.mockImplementationOnce(async () => { f.advance(19, false); f.advance(2); return []; });
    await f.engine.tick();
    expect(f.engine.state.lastDecision).toMatchObject({ reason: "data_gap_30m", marketData: { ready: false, maxGapMs: 20000 } });
    expect(f.broker.submit).not.toHaveBeenCalled();
    expect(f.engine.state.lastDecision!.marketData.gapClearsAfter).toBe(f.now() - 1000 + 1800000);
  });
  it("does not reuse stale live quotes after a slow query", async () => {
    const f = fixture();
    f.broker.positions.mockImplementationOnce(async () => { f.advance(20, false); return []; });
    await f.engine.tick();
    expect(f.engine.state.lastDecision?.reason).toBe("no_fresh_market");
    expect(f.broker.submit).not.toHaveBeenCalled();
  });
  it("checks the entry cutoff after IO, including automatic preflight", async () => {
    for (const time of ["15:14:50", "14:59:50"]) {
      const f = fixture(Date.parse(`2026-09-16T${time}+09:00`));
      if (time === "14:59:50") { f.engine.config.cancellationVerified = false; f.engine.config.autoPreflight = true; }
      f.broker.orders.mockImplementationOnce(async () => { f.advance(20); return []; });
      await f.engine.tick();
      expect(f.broker.submit).not.toHaveBeenCalled();
      expect(f.engine.state.lastDecision?.reason).toBe(time === "15:14:50" ? "outside_experiment_session" : "orders_not_armed");
    }
  });
  it("keeps the risk stop and once-per-minute decision gate after IO", async () => {
    const f = fixture(); f.engine.state.streak = 3;
    f.broker.orders.mockImplementationOnce(async () => { f.advance(20); return []; });
    await f.engine.tick();
    expect(f.engine.state.lastDecision?.reason).toBe("risk_limit_or_cooldown");
    const before = f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='decision'").get()!.n;
    await f.engine.tick();
    expect(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='decision'").get()!.n).toBe(before);
    expect(f.broker.submit).not.toHaveBeenCalled();
  });
  it("reports the persisted actual decision separately from a newer preview", async () => {
    const f = fixture();
    f.broker.orders.mockImplementationOnce(async () => { f.advance(20, false); return []; });
    await f.engine.tick();
    const row = f.store.db.prepare("SELECT payload FROM events WHERE kind='decision' ORDER BY id DESC LIMIT 1").get()!;
    const decision = JSON.parse(String(row.payload));
    f.advance(2);
    const report = entryReport(f.engine, f.now(), { gate: { allowed: true, reason: "authorized" }, feedReady: true, inSession: true, lastError: "" });
    expect(report.lastDecision).toEqual(decision);
    expect(report.lastDecision).toEqual(f.store.get<State>("state")!.lastDecision);
    expect(report.entryBlockReason).toBe("no_fresh_market");
    expect(report.currentEntryStatus).toBe("data_gap_30m");
    delete f.engine.state.lastDecision;
    expect(entryReport(f.engine, f.now(), { gate: { allowed: true, reason: "authorized" }, feedReady: true, inSession: true, lastError: "" }).lastDecision).toBeNull();
  });
});
