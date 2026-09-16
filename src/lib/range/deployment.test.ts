import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDeploymentGate } from "./deployment";
import { RangeEngine, type LocalOrder } from "./engine";
import { RangeStore } from "./store";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).reverse().forEach(f => f()));
const now = Date.parse("2026-09-16T10:00:00+09:00");
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-gate-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RangeStore(path.join(dir, "db"), () => now); store.claim(); clean.push(() => store.close());
  const broker = { orders: vi.fn(async () => []), positions: vi.fn(async (): Promise<{symbol:string;qty:number}[]> => []), submit: vi.fn(async () => ({id:"456",org:"001"})), cancel: vi.fn(async () => "999") };
  const engine = new RangeEngine(store, broker, {start:"2026-09-14",end:"2026-09-25",fee:.00015,enabled:true,cancellationVerified:true}, () => now);
  return { dir, store, engine, broker };
}
describe("deployment buy permission", () => {
  it("fails closed for missing, broken, old boot, old commit, expired and excessively long permits", () => {
    const {dir} = fixture(), file = path.join(dir, "gate.json");
    expect(readDeploymentGate(file, "sha", "boot", now).allowed).toBe(false);
    writeFileSync(file, "{"); expect(readDeploymentGate(file, "sha", "boot", now).allowed).toBe(false);
    const valid = {allow:true,commit:"sha",bootId:"boot",expires:now+180000,requestId:"r"};
    for (const patch of [{allow:false},{commit:"old"},{bootId:"old"},{expires:now},{expires:now+400000}]) {
      writeFileSync(file, JSON.stringify({...valid,...patch}));
      expect(readDeploymentGate(file, "sha", "boot", now).allowed).toBe(false);
    }
    writeFileSync(file, JSON.stringify(valid));
    expect(readDeploymentGate(file, "sha", "boot", now)).toEqual({allowed:true,reason:"authorized",requestId:"r"});
  });
  it("does not create a buy intent or block a protective sell while paused", async () => {
    const {engine, broker, store} = fixture(); engine.entryAllowed = () => false;
    await engine.submit("buy", 1, 14000, 0);
    expect(broker.submit).not.toHaveBeenCalled(); expect(engine.state.orders).toHaveLength(0);
    expect(store.db.prepare("SELECT * FROM events WHERE kind='order_intent'").all()).toHaveLength(0);
    engine.state.quantity = 1;
    await engine.submit("sell", 1, 14030, 0);
    expect(broker.submit).toHaveBeenCalledWith("sell", 1, 14030);
  });
  it("rechecks permission after asynchronous account reconciliation and blocks preflight", async () => {
    const {engine, broker} = fixture(); let allowed = true;
    engine.entryAllowed = () => allowed;
    broker.positions.mockImplementation(async () => { allowed = false; return []; });
    engine.config.cancellationVerified = false; engine.config.autoPreflight = true;
    engine.state.days = ["2026-09-14"];
    await engine.tick();
    expect(broker.orders).toHaveBeenCalled(); expect(broker.submit).not.toHaveBeenCalled();
    expect(engine.state.preflight).toBeUndefined(); expect(engine.state.safeToStop).toBe(true);
  });
  it("keeps the strategy exit path and live quote while paused instead of forcing liquidation", async () => {
    const {engine, broker} = fixture(); engine.entryAllowed = () => false;
    engine.state.active = {at:now,strategy:"A",low:14000,high:14100,width:100,stop:13980,buys:[14000],targets:[14060],quantities:[1]};
    engine.state.quantity=1; engine.state.basis=14000; engine.state.firstFill=now;
    const buy: LocalOrder = {key:"k",id:"123",org:"001",side:"buy",qty:1,price:14000,filled:1,amount:14000,remaining:0,terminal:true,status:"accepted",at:now,leg:0};
    engine.state.orders=[buy];
    engine.quote({at:now,bid:14020,ask:14025,bidSize:100,askSize:100}); engine.lastTrade=now;
    broker.positions.mockResolvedValue([{symbol:"229200",qty:1}]);
    await engine.tick();
    expect(broker.submit).toHaveBeenCalledWith("sell",1,14060);
    expect(engine.state.exiting).toBeUndefined(); expect(engine.latest).toBeDefined();
  });
});
