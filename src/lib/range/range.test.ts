import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBox, korea, shock } from "./strategy";
import { RangeStore } from "./store";
import { RangeEngine, linkedCancellation, validateConfig, type LocalOrder } from "./engine";
import type { RemoteOrder } from "./broker";
const at = Date.parse("2026-09-15T10:00:00+09:00");
const config = { start: "2026-09-14", end: "2026-09-25", fee: .00015, enabled: true, cancellationVerified: true };
function samples() { return Array.from({ length: 1801 }, (_, i) => { const p = 14000 + 100 * Math.sin(i / 15); return { at: at - 1800_000 + i * 1000, bid: Math.floor(p / 5) * 5, ask: Math.floor(p / 5) * 5 + 5, bidSize: 100, askSize: 100 }; }); }
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "range-test-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RangeStore(path.join(dir, "test.sqlite"), () => at); store.claim(); clean.push(() => store.close());
  const broker = { orders: vi.fn(async (): Promise<RemoteOrder[]> => []), positions: vi.fn(async (): Promise<{symbol:string;qty:number}[]> => []), submit: vi.fn(async () => ({ id: "123", org: "001" })), cancel: vi.fn(async () => "124") };
  const engine = new RangeEngine(store, broker, { ...config }, () => at); return { store, engine, broker };
}
function local(side: "buy" | "sell", qty = 3): LocalOrder { return { key: "k", side, qty, price: 14000, filled: 0, amount: 0, remaining: qty, terminal: false, status: "accepted", id: "123", org: "001", at: at - 20_000, leg: 0 }; }
function remote(side: "buy" | "sell", filled: number, average = 14000): RemoteOrder { return { id: "123", org: "001", date: "20260915", parent: "000", side, symbol: "229200", qty: 3, filled, remaining: 3 - filled, average, cancelled: false, rejected: 0 }; }
describe("range signal", () => {
  it("requires full 30 minutes, not just 5 minutes", () => { expect(makeBox(samples().slice(-300), at, "B", .00015).reason).toBe("warming_30m"); });
  it("generates distinct ETF ticks and equal total size", () => { const s = samples(); s[s.length - 1] = { ...s.at(-1)!, bid: 14040, ask: 14045 }; const a = makeBox(s, at, "A", .00015).box!, b = makeBox(s, at, "B", .00015).box!; expect(a).toBeDefined(); expect(b).toBeDefined(); expect(new Set(b.buys).size).toBe(3); expect([...b.buys, ...b.targets].every(p => p % 5 === 0)).toBe(true); expect(a.quantities[0]).toBe(3); });
  it("rejects a trend even with narrow recent motion", () => { const s = samples().map((v,i) => ({ ...v, bid: 13000 + i * 5, ask: 13005 + i * 5 })); expect(makeBox(s, at, "B", .00015).reason).toBe("directional_market"); });
  it("rejects missing sample intervals", () => { expect(makeBox(samples().filter((_,i) => i < 900 || i > 920), at, "B", .00015).reason).toBe("data_gap_30m"); });
  it("does not enter after 15:15 or on weekends", () => { expect(makeBox(samples(), Date.parse("2026-09-15T15:15:00+09:00"), "B", .00015).reason).toBe("outside_entry_session"); expect(korea(Date.parse("2026-09-19T09:00:00+09:00")).weekday).toBe(6); });
  it("detects abrupt volatility expansion", () => { const s = samples().map(v => ({ ...v, bid: 14000, ask: 14005 })); s[s.length - 1].ask += 100; expect(shock(s, at)).toBe(true); });
  it("requires a real fee and rejects wide spreads", () => { expect(makeBox(samples(), at, "A", 0).reason).toBe("fee_unconfirmed"); const s = samples(); s[s.length - 1].ask += 20; expect(makeBox(s, at, "A", .00015).reason).toBe("stale_or_wide_or_shallow"); });
});
describe("journal and lifecycle", () => {
  it("keeps strategy blocked until the broker confirms a zero-fill cancellation", async () => {
    const {engine, broker} = fixture();
    engine.config.cancellationVerified = false; engine.config.autoPreflight = true;
    await expect(engine.submit("buy", 1, 14000, 0)).rejects.toThrow("preflight");
    engine.samples = samples(); engine.latest = engine.samples.at(-1); engine.lastTrade = at;
    engine.state.days = ["2026-09-14"]; engine.state.date = "2026-09-15";
    await engine.tick();
    expect(engine.state.preflight?.status).toBe("running");
    expect(broker.submit).toHaveBeenCalledTimes(1);
    expect(broker.submit).toHaveBeenCalledWith("buy", 1, expect.any(Number));
    broker.orders.mockResolvedValue([{...remote("buy",0),qty:1,remaining:1}]);
    await engine.tick(); expect(broker.cancel).toHaveBeenCalledTimes(1);
    expect(engine.strategyArmed()).toBe(false);
    broker.orders.mockResolvedValue([{...remote("buy",0),qty:1,remaining:0,cancelled:true}]);
    await engine.tick(); expect(engine.state.preflight?.status).toBe("passed");
    expect(engine.strategyArmed()).toBe(true);
    await engine.tick(); expect(broker.submit).toHaveBeenCalledTimes(1);
  });
  it("does not pass preflight on a fill and liquidates the diagnostic share", async () => {
    const {engine, broker} = fixture();
    engine.config.cancellationVerified = false; engine.config.autoPreflight = true;
    engine.samples = samples(); engine.latest = engine.samples.at(-1); engine.lastTrade = at;
    engine.state.days = ["2026-09-14"]; engine.state.date = "2026-09-15";
    await engine.tick();
    broker.orders.mockResolvedValue([{...remote("buy",1),qty:1,remaining:0}]);
    broker.positions.mockResolvedValue([{symbol:"229200",qty:1}]);
    broker.submit.mockResolvedValue({id:"456",org:"001"});
    await engine.tick(); expect(broker.submit).toHaveBeenLastCalledWith("sell",1,null);
    broker.positions.mockResolvedValue([]);
    broker.orders.mockResolvedValue([{...remote("buy",1),qty:1,remaining:0},{...remote("sell",1),id:"456",qty:1,remaining:0}]);
    await engine.tick();
    expect(engine.state.preflight?.status).toBe("failed");
    expect(engine.state.quantity).toBe(0); expect(engine.strategyArmed()).toBe(false);
    expect(engine.state.halted).toBe("preflight_failed_check_orders");
  });
  it("validates bounded dates and activation gates", () => { expect(() => validateConfig({ ...config, end: "2026-10-30" })).toThrow(); expect(() => validateConfig({ ...config, cancellationVerified: false })).toThrow(); expect(() => validateConfig({ ...config, start: "2026-02-30" })).toThrow(); });
  it("prevents a second writer", () => { const {store} = fixture(); const other = new RangeStore(store.file, () => at); try { expect(() => other.claim()).toThrow(); } finally { other.close(); } expect(() => store.assertOwner()).not.toThrow(); });
  it("persists intent BEFORE broker IO and never retries ambiguous submission", async () => {
    const {engine, store, broker} = fixture();
    broker.submit.mockImplementation(async () => { expect(store.get<{orders:LocalOrder[]}>("state")!.orders[0].status).toBe("intent"); throw new Error("timeout"); });
    await expect(engine.submit("buy", 1, 14000, 0)).rejects.toThrow();
    expect(store.get<{halted:string}>("state")!.halted).toBe("order_outcome_unknown");
    await expect(engine.submit("buy", 1, 14000, 0)).rejects.toThrow(); expect(broker.submit).toHaveBeenCalledTimes(1);
  });
  it("accounts cumulative partial fills once and derives delta price", () => {
    const {engine} = fixture(), o = local("buy"); engine.state.orders.push(o);
    engine.applyFill(o, remote("buy", 1)); engine.applyFill(o, remote("buy", 1)); expect(engine.state.quantity).toBe(1);
    engine.applyFill(o, remote("buy", 3, 14010)); expect(engine.state.quantity).toBe(3); expect(engine.state.basis).toBeCloseTo(42030 * 1.00015);
    expect(() => engine.applyFill(o, remote("buy", 2))).toThrow();
  });
  it("prevents selling already-reserved shares", async () => {
    const {engine, broker} = fixture(); engine.state.quantity = 2; engine.state.orders.push({ ...local("sell", 1), remaining: 1 });
    await expect(engine.submit("sell", 2, 14050, 0)).rejects.toThrow("Oversell"); expect(broker.submit).not.toHaveBeenCalled();
  });
  it("cancel acceptance is not cancellation completion and is not repeated", async () => {
    const {engine, broker} = fixture(), o = local("buy"); engine.state.orders.push(o);
    await engine.cancel(o); await engine.cancel(o); expect(o.terminal).toBe(false); expect(broker.cancel).toHaveBeenCalledTimes(1);
    engine.applyFill(o, { ...remote("buy", 1), cancelled: true, remaining: 0 }); expect(engine.state.quantity).toBe(1); expect(o.terminal).toBe(true);
  });
  it("halts on external open orders and rejects balance mismatches", async () => {
    const {engine, broker} = fixture(); broker.orders.mockResolvedValue([remote("buy", 0)]); await engine.reconcile(); expect(engine.state.halted).toBe("external_open_order");
    broker.positions.mockResolvedValue([{symbol:"229200",qty:1}]); await expect(engine.reconcile()).rejects.toThrow("mismatch");
  });
  it("does not call broker when observing", async () => {
    const {engine, broker} = fixture(); engine.config.enabled = false;
    await expect(engine.submit("buy", 1, 14000, 0)).rejects.toThrow(); expect(broker.submit).not.toHaveBeenCalled();
  });
  it("restores unresolved intent as a durable halt", () => {
    const {engine, store, broker} = fixture(); engine.state.orders.push({ ...local("buy"), id: undefined, status: "intent" }); engine.save();
    const restored = new RangeEngine(store, broker, config, () => at);
    expect(restored.state.halted).toBe("unknown_order_on_restart");
  });
  it("does not mark a held position safe to stop", async () => {
    const {engine, broker} = fixture(); const buy = local("buy"); engine.state.orders.push(buy);
    broker.orders.mockResolvedValue([{ ...remote("buy", 3), remaining: 0 }]); broker.positions.mockResolvedValue([{symbol:"229200",qty:3}]);
    await engine.reconcile(); expect(engine.state.quantity).toBe(3); expect(engine.state.safeToStop).toBe(false);
  });
  it("submits a target only for confirmed terminal buy quantity", async () => {
    const {engine, broker} = fixture(); const data = samples(); data[data.length - 1] = {...data.at(-1)!,bid:14040,ask:14045};
    engine.state.active = makeBox(data, at, "A", config.fee).box;
    engine.state.date = "2026-09-15"; engine.samples = data; engine.latest = data.at(-1); engine.lastTrade = at;
    engine.state.orders.push(local("buy"));
    broker.orders.mockResolvedValue([{...remote("buy",1),cancelled:true,remaining:0}]); broker.positions.mockResolvedValue([{symbol:"229200",qty:1}]); broker.submit.mockResolvedValue({id:"456",org:"001"});
    await engine.tick(); expect(broker.submit).toHaveBeenCalledWith("sell",1,engine.state.active!.targets[0]);
  });
  it("waits for cancellation confirmation before emergency sell", async () => {
    const {engine, broker} = fixture(); const data = samples(); data[data.length - 1] = {...data.at(-1)!,bid:14040,ask:14045};
    engine.state.active = makeBox(data, at, "B", config.fee).box;
    engine.state.date = "2026-09-15"; engine.state.orders.push(local("buy")); engine.state.exiting = "stop_loss";
    broker.orders.mockResolvedValue([remote("buy",1)]); broker.positions.mockResolvedValue([{symbol:"229200",qty:1}]);
    await engine.tick(); expect(broker.cancel).toHaveBeenCalledTimes(1); expect(broker.submit).not.toHaveBeenCalled();
    broker.orders.mockResolvedValue([{...remote("buy",1),remaining:0,cancelled:true}]); broker.submit.mockResolvedValue({id:"456",org:"001"});
    await engine.tick(); expect(broker.submit).toHaveBeenCalledWith("sell",1,null);
  });
});

describe("linked cancellation evidence", () => {
  const order = {...local("buy",1),cancelAt:at,cancelId:"124"};
  const original = {...remote("buy",0),qty:1,remaining:0};
  const cancellation = {...original,id:"124",parent:"123",cancelled:true};
  it("accepts a separate cancellation while the original flag remains N", () => {
    expect(linkedCancellation(order,original,[original,cancellation])).toBe(true);
  });
  it.each([{parent:"999"},{id:"999"},{date:"20260914"},{symbol:"005930"},{side:"sell" as const},{rejected:1},{cancelled:false},{remaining:1},{filled:1},{qty:0}])("rejects mismatched or incomplete cancellation %j", patch => {
    expect(linkedCancellation(order,original,[{...cancellation,...patch}])).toBe(false);
  });
  it("does not infer cancellation from zero remaining or acknowledgment alone", () => {
    expect(linkedCancellation(order,original,[])).toBe(false);
    expect(linkedCancellation(order,{...original,remaining:1},[cancellation])).toBe(false);
  });
  it("reconciles the linked cancellation without counting it as a fill", async () => {
    const {engine,broker}=fixture(); engine.state.orders=[{...order}];
    broker.orders.mockResolvedValue([original,cancellation]);
    await engine.reconcile();
    expect(engine.state.orders[0].cancelled).toBe(true);
    expect(engine.state.quantity).toBe(0);
    expect(engine.state.safeToStop).toBe(true);
  });
});
