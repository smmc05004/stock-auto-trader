import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataQuality, type Sample } from "./strategy";
import { FeedController } from "./feed";
import { RangeEngine } from "./engine";
import { RangeStore } from "./store";
const at = Date.parse("2026-09-16T10:00:00+09:00");
const quote = (time: number): Sample => ({ at: time, bid: 14000, ask: 14005, bidSize: 100, askSize: 100 });
const samples = () => Array.from({ length: 1800 }, (_, i) => quote(at - 1800_000 + i * 1000));
describe("data recovery", () => {
  it("keeps the existing ten-second gap boundary", () => {
    expect(dataQuality(samples().filter((_,i) => i < 900 || i >= 909), at).ready).toBe(true);
    expect(dataQuality(samples().filter((_,i) => i < 900 || i >= 910), at).reason).toBe("data_gap_30m");
  });
  it("does not substitute sample density for missing history", () => {
    expect(dataQuality(samples().slice(-500), at).reason).toBe("warming_30m");
    expect(dataQuality(samples().filter((_,i) => i % 4 !== 1), at).reason).toBe("insufficient_samples_30m");
    expect(dataQuality(samples().filter((_,i) => i < 1500 || i % 4 !== 1), at).reason).toBe("insufficient_samples_5m");
  });
  it("ignores previous days and future quotes", () => {
    expect(dataQuality(samples().map(s => ({...s,at:s.at-86400_000})), at).samples30m).toBe(0);
    expect(dataQuality([quote(at+1000)],at).samples30m).toBe(0);
  });
  it("restores SQLite history but requires new live data; disconnect preserves it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(),"range-recovery-"));
    const store = new RangeStore(path.join(dir,"db"),()=>at); store.claim();
    const broker = {orders:vi.fn(async()=>[]),positions:vi.fn(async()=>[]),submit:vi.fn(),cancel:vi.fn()};
    const config={start:"2026-09-14",end:"2026-09-25",fee:.000146527,enabled:true,cancellationVerified:true};
    try {
      // Seed the historical fixture atomically instead of 1,800 fsyncs on CI disks.
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const insert = store.db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?)");
        for (const s of samples()) insert.run(s.at,s.bid,s.ask,s.bidSize,s.askSize);
        store.db.exec("COMMIT");
      } catch (e) { store.db.exec("ROLLBACK"); throw e; }
      const engine = new RangeEngine(store,broker,config,()=>at);
      expect(engine.samples).toHaveLength(1800); expect(engine.latest).toBeUndefined();
      await engine.tick(); expect(broker.submit).not.toHaveBeenCalled();
      engine.quote(quote(at)); engine.lastTrade=at;
      engine.disconnect(); expect(engine.samples).toHaveLength(1801); expect(engine.latest).toBeUndefined();
      expect(dataQuality(engine.samples,at).ready).toBe(true);
      broker.orders.mockRejectedValueOnce(new Error("KIS HTTP 500"));
      await expect(engine.tick()).rejects.toThrow(); expect(engine.samples).toHaveLength(1801);
      expect(broker.submit).not.toHaveBeenCalled();
    } finally {store.close(); rmSync(dir,{recursive:true,force:true});}
  });
  it("retains a large real gap until it leaves the window", () => {
    const retained=samples().filter((_,i)=>i<900||i>930);
    expect(dataQuality(retained,at).reason).toBe("data_gap_30m");
    const later=Array.from({length:1800},(_,i)=>quote(at+i*1000));
    expect(dataQuality([...retained,...later],at+1800_000).ready).toBe(true);
  });
});
describe("independent reconnect controller", () => {
  it("ignores old connection callbacks and duplicate failures, waits for close, and requires both subscriptions", async () => {
    let now=at;
    const connections: {down:(reason?:string)=>void;ack:(tr:string,ok:boolean,code:string)=>void;quote:(s:Sample)=>void;socket:{readyState:number;close:()=>void}}[]=[];
    const sink=vi.fn(), disconnected=vi.fn(), events=vi.fn();
    const connect=vi.fn(async (q:(s:Sample)=>void,_t:(at:number)=>void,d:(reason?:string)=>void,a:(tr:string,ok:boolean,code:string)=>void)=>{
      const socket={readyState:1,close(){this.readyState=2;}};
      connections.push({down:d,ack:a,quote:q,socket}); return socket;
    });
    const feed=new FeedController(connect,sink,vi.fn(),disconnected,events,()=>now,()=>0);
    await feed.tick(true); const first=connections[0];
    first.quote(quote(now)); expect(sink).not.toHaveBeenCalled();
    first.ack("H0STASP0",true,"ok"); expect(feed.ready).toBe(false);
    first.ack("H0STCNT0",true,"ok"); first.quote(quote(now)); expect(sink).toHaveBeenCalledTimes(1);
    first.down("error"); first.down("close"); expect(disconnected).toHaveBeenCalledTimes(1);
    now+=1500; await feed.tick(true); expect(connect).toHaveBeenCalledTimes(1);
    first.socket.readyState=3; await feed.tick(true); expect(connect).toHaveBeenCalledTimes(2);
    const second=connections[1]; second.ack("H0STASP0",true,"ok");second.ack("H0STCNT0",true,"ok");
    expect(events).toHaveBeenCalledWith("feed_ready", expect.objectContaining({ generation: 2, downtimeMs: 1500 }));
    expect(feed.snapshot()).toMatchObject({ lastDownAt: at, lastReadyAt: now });
    first.down("late_close"); expect(feed.ready).toBe(true);
    first.quote(quote(now)); expect(sink).toHaveBeenCalledTimes(1);
    second.quote(quote(now)); expect(sink).toHaveBeenCalledTimes(2);
    await feed.tick(false); expect(feed.ready).toBe(false);
  });
});
