import { setTimeout as delay } from "node:timers/promises";
import { KisBrokerClient } from "../broker/kisBroker";
import { SYMBOL, type Sample } from "./strategy";
export type RemoteOrder = { id: string; org: string; side: "buy" | "sell"; symbol: string; qty: number; filled: number; remaining: number; average: number; cancelled: boolean; rejected: number; date: string; parent: string };
const BASE = "https://openapivts.koreainvestment.com:29443";
function num(v: unknown) { const n = Number(v); if (v === undefined || v === "" || !Number.isFinite(n) || n < 0) throw new Error("Invalid broker numeric field"); return n; }
export class RangeBroker {
  private auth = new KisBrokerClient();
  private last = 0;
  private approval?: { key: string; at: number };
  private chain: Promise<unknown> = Promise.resolve();
  readonly droppedFrames = { stale: 0, future: 0, invalidTime: 0, lastAt: 0 };
  private lastDropEvent = 0;
  constructor(readonly diagnostic: (kind: string, data: unknown) => void = () => {}) {
    if (process.env.TRADING_MODE !== "paper" || process.env.ALLOW_LIVE_TRADING !== "false" || process.env.BROKER_PROVIDER !== "kis" || process.env.KIS_BASE_URL) throw new Error("Range runner requires fixed KIS paper environment");
    if (!process.env.KIS_PAPER_APP_KEY || !process.env.KIS_PAPER_APP_SECRET || !/^5\d{7}$/.test(process.env.KIS_PAPER_ACCOUNT_NO ?? "") || process.env.KIS_PAPER_ACCOUNT_PRODUCT_CODE !== "01") throw new Error("Explicit paper stock credentials required");
  }
  private account() { return { CANO: process.env.KIS_PAPER_ACCOUNT_NO!, ACNT_PRDT_CD: "01" }; }
  private request(endpoint: string, tr: string, body: Record<string, string>, post = false, cont?: string): Promise<{ data: Record<string, unknown>; more: boolean }> {
    const queuedAt = Date.now();
    const job = this.chain.then(async () => {
      const startedAt = Date.now();
      let sentAt: number | undefined, httpStatus: number | undefined, code: string | undefined;
      let outcome = "error";
      try {
        const token = await this.auth.getAccessToken();
        await delay(Math.max(0, this.last + 1100 - Date.now())); this.last = Date.now();
        const url = new URL(endpoint, BASE);
        if (!post) Object.entries(body).forEach(([k, v]) => url.searchParams.set(k, v));
        sentAt = Date.now();
        const res = await fetch(url, { method: post ? "POST" : "GET", headers: {
          "content-type": "application/json", authorization: `Bearer ${token}`, appkey: process.env.KIS_PAPER_APP_KEY!, appsecret: process.env.KIS_PAPER_APP_SECRET!, tr_id: tr, custtype: "P", ...(cont ? { tr_cont: cont } : {}),
        }, ...(post ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
        httpStatus = res.status;
        const data = await res.json() as Record<string, unknown>;
        code = String(data.msg_cd ?? "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
        if (data.msg_cd === "EGW00123") {
          // Refresh for the next reconciliation, never replay an order or cancel request.
          await this.auth.getAccessToken(true);
          throw new Error("KIS token refreshed; reconciliation required");
        }
        if (!res.ok) throw new Error(`KIS HTTP ${res.status} ${tr} ${code} latency=${Date.now() - this.last}ms`);
        if (data.rt_cd !== "0") throw new Error(`KIS ${code}`);
        outcome = "ok";
        return { data, more: ["F", "M"].includes(res.headers.get("tr_cont") ?? "") };
      } catch (error) {
        if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) outcome = "timeout";
        throw error;
      } finally {
        const completedAt = Date.now();
        this.diagnostic("broker_request", { tr, queuedAt, startedAt, completedAt,
          queueMs: startedAt - queuedAt, prepareMs: (sentAt ?? completedAt) - startedAt,
          requestMs: sentAt === undefined ? null : completedAt - sentAt,
          totalMs: completedAt - queuedAt, httpStatus, code, outcome });
      }
    });
    this.chain = job.catch(() => undefined); return job;
  }
  async orders(start: string, end: string): Promise<RemoteOrder[]> {
    let fk = "", nk = ""; const rows: RemoteOrder[] = [];
    for (let page = 0; page < 30; page++) {
      const { data, more } = await this.request("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", "VTTC0081R", { ...this.account(), INQR_STRT_DT: start.replaceAll("-", ""), INQR_END_DT: end.replaceAll("-", ""), SLL_BUY_DVSN_CD: "00", CCLD_DVSN: "00", INQR_DVSN: "00", INQR_DVSN_3: "00", PDNO: "", ORD_GNO_BRNO: "", ODNO: "", INQR_DVSN_1: "", CTX_AREA_FK100: fk, CTX_AREA_NK100: nk, EXCG_ID_DVSN_CD: "KRX" }, false, page ? "N" : undefined);
      if (!Array.isArray(data.output1)) throw new Error("Missing broker orders");
      for (const r of data.output1 as Record<string, unknown>[]) {
        if (!["01", "02"].includes(String(r.sll_buy_dvsn_cd))) throw new Error("Unknown order side");
        rows.push({ id: String(r.odno), org: String(r.ord_gno_brno ?? ""), date: String(r.ord_dt), parent: String(r.orgn_odno ?? ""), symbol: String(r.pdno), side: r.sll_buy_dvsn_cd === "02" ? "buy" : "sell", qty: num(r.ord_qty), filled: num(r.tot_ccld_qty), remaining: num(r.rmn_qty), average: num(r.avg_prvs), cancelled: r.cncl_yn === "Y", rejected: num(r.rjct_qty) });
      }
      if (!more) return rows;
      const a = String(data.ctx_area_fk100 ?? ""), b = String(data.ctx_area_nk100 ?? "");
      if (a === fk && b === nk) throw new Error("Repeated order cursor"); fk = a; nk = b;
    }
    throw new Error("Order pagination limit");
  }
  async positions() {
    const { data, more } = await this.request("/uapi/domestic-stock/v1/trading/inquire-balance", "VTTC8434R", { ...this.account(), AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "01", UNPR_DVSN: "01", FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00", CTX_AREA_FK100: "", CTX_AREA_NK100: "" });
    if (more || !Array.isArray(data.output1)) throw new Error("Incomplete account snapshot");
    return (data.output1 as Record<string, unknown>[]).map(r => ({ symbol: String(r.pdno), qty: num(r.hldg_qty) })).filter(r => r.qty > 0);
  }
  async submit(side: "buy" | "sell", qty: number, price: number | null) {
    if (!Number.isInteger(qty) || qty < 1 || qty > 3 || (price !== null && (!Number.isInteger(price) || price <= 0 || price % 5 !== 0))) throw new Error("Invalid range order");
    if (side === "buy" && (price === null || qty * price > 300_000)) throw new Error("Invalid range buy budget");
    const { data } = await this.request("/uapi/domestic-stock/v1/trading/order-cash", side === "buy" ? "VTTC0012U" : "VTTC0011U", { ...this.account(), PDNO: SYMBOL, ORD_DVSN: price === null ? "01" : "00", ORD_QTY: String(qty), ORD_UNPR: String(price ?? 0), EXCG_ID_DVSN_CD: "KRX", SLL_TYPE: side === "sell" ? "01" : "", CNDT_PRIC: "" }, true);
    const r = data.output as Record<string, string>;
    if (!r?.ODNO || !r.KRX_FWDG_ORD_ORGNO) throw new Error("Missing accepted order identifier");
    return { id: r.ODNO, org: r.KRX_FWDG_ORD_ORGNO };
  }
  async cancel(order: { id: string; org: string }, remaining: number) {
    if (!/^\d+$/.test(order.id) || !/^\d+$/.test(order.org) || !Number.isInteger(remaining) || remaining < 1) throw new Error("Invalid cancel intent");
    const { data } = await this.request("/uapi/domestic-stock/v1/trading/order-rvsecncl", "VTTC0013U", { ...this.account(), KRX_FWDG_ORD_ORGNO: order.org, ORGN_ODNO: order.id, ORD_DVSN: "00", RVSE_CNCL_DVSN_CD: "02", ORD_QTY: String(remaining), ORD_UNPR: "0", QTY_ALL_ORD_YN: "Y", EXCG_ID_DVSN_CD: "KRX" }, true);
    return String((data.output as Record<string, string>)?.ODNO ?? "");
  }
  acceptProviderTime(stamp: number, now: number) {
    if (Number.isFinite(stamp) && Math.abs(now - stamp) <= 5000) return true;
    const reason = !Number.isFinite(stamp) ? "invalidTime" : stamp > now ? "future" : "stale";
    this.droppedFrames[reason]++; this.droppedFrames.lastAt = now;
    // Count every discarded frame, but bound SQLite writes during a bad feed.
    if (!this.lastDropEvent || now - this.lastDropEvent >= 60_000) {
      this.lastDropEvent = now;
      this.diagnostic("feed_frame_dropped", { reason, counts: { ...this.droppedFrames }, ageMs: Number.isFinite(stamp) ? now - stamp : null });
    }
    return false;
  }
  async connect(onQuote: (s: Sample) => void, onTrade: (at: number) => void, onDisconnect: (reason?: string) => void, onStatus?: (tr: string, ok: boolean, code: string) => void) {
    if (!this.approval || Date.now() - this.approval.at > 3600_000) {
      const r = await fetch(`${BASE}/oauth2/Approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_PAPER_APP_KEY, secretkey: process.env.KIS_PAPER_APP_SECRET }), signal: AbortSignal.timeout(15_000) });
      const data = await r.json() as { approval_key?: string };
      if (!r.ok || !data.approval_key) throw new Error("WebSocket approval failed");
      this.approval = { key: data.approval_key, at: Date.now() };
    }
    const approval = this.approval.key;
    const ws = new WebSocket("ws://ops.koreainvestment.com:31000");
    ws.addEventListener("open", () => {
      for (const tr of ["H0STASP0", "H0STCNT0"]) ws.send(JSON.stringify({ header: { approval_key: approval, custtype: "P", tr_type: "1", "content-type": "utf-8" }, body: { input: { tr_id: tr, tr_key: SYMBOL } } }));
    });
    ws.addEventListener("message", (e) => {
      try {
        const raw = String(e.data);
        if (raw.startsWith("{")) { const msg = JSON.parse(raw); if (msg.header?.tr_id === "PINGPONG") ws.send(raw); else if (msg.body?.rt_cd !== undefined) { onStatus?.(String(msg.header?.tr_id ?? ""), msg.body.rt_cd === "0", String(msg.body.msg_cd ?? "")); if (msg.body.rt_cd !== "0") { this.approval = undefined; onDisconnect("subscription_rejected"); ws.close(); } } return; }
        const [kind, tr, , payload] = raw.split("|"); if (kind !== "0" || !payload) return;
        const f = payload.split("^"); if (f[0] !== SYMBOL) return;
        const now = Date.now(), k = new Date(now + 9 * 3600_000).toISOString();
        const stamp = Date.parse(`${k.slice(0, 10)}T${f[1].slice(0, 2)}:${f[1].slice(2, 4)}:${f[1].slice(4, 6)}+09:00`);
        if (!this.acceptProviderTime(stamp, now)) return;
        if (tr === "H0STCNT0") onTrade(now);
        if (tr === "H0STASP0") {
          const s = { at: now, providerAt: stamp, ask: num(f[3]), bid: num(f[13]), askSize: num(f[23]), bidSize: num(f[33]) };
          if (s.bid > 0 && s.ask >= s.bid && s.bid % 5 === 0 && s.ask % 5 === 0) onQuote(s);
        }
      } catch { onDisconnect("parse_error"); ws.close(); }
    });
    ws.addEventListener("close", e => onDisconnect(`socket_close_${e.code}`)); ws.addEventListener("error", () => onDisconnect("socket_error"));
    return ws;
  }
}
