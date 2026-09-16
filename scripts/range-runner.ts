import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readDeploymentGate } from "../src/lib/range/deployment";
import { setTimeout as delay } from "node:timers/promises";
import { RangeBroker } from "../src/lib/range/broker";
import { RangeEngine, type Config } from "../src/lib/range/engine";
import { RangeStore } from "../src/lib/range/store";
import { korea, VERSION } from "../src/lib/range/strategy";
import { FeedController } from "../src/lib/range/feed";
import { entryReport } from "../src/lib/range/report";
import { ShadowComparison } from "../src/lib/range/shadow";

const config: Config = {
  start: process.env.RANGE_START_DATE ?? "", end: process.env.RANGE_END_DATE ?? "",
  fee: Number(process.env.RANGE_FEE_RATE ?? "0"), enabled: process.env.RANGE_ORDERS_ENABLED === "true",
  cancellationVerified: process.env.RANGE_CANCEL_VERIFIED === "true",
  autoPreflight: process.env.RANGE_AUTO_PREFLIGHT === "true",
  feeBasis: process.env.RANGE_FEE_BASIS ?? "unconfirmed",
};
const store = new RangeStore(process.env.RANGE_DB_PATH ?? "/app/data/range.sqlite");
store.claim();
const broker = new RangeBroker((kind, data) => store.event(kind, data)), engine = new RangeEngine(store, broker, config);
const shadow = new ShadowComparison(store, config.fee);
const revision = "evaluation-clock-20260916";
const gitCommit = process.env.APP_GIT_COMMIT ?? "unknown";
const gateFile = process.env.RANGE_DEPLOYMENT_GATE;
const bootId = gateFile ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "unmanaged";
const gate = () => readDeploymentGate(gateFile, gitCommit, bootId);
engine.entryAllowed = () => gate().allowed;
let tickInProgress = false;
shadow.invalidate("process_restart");
let lastError = "", stopping = false, lastShadowSecond = 0;
const feed = new FeedController(broker.connect.bind(broker), s => {
  if (engine.latest && s.at - engine.latest.at > 10_000) shadow.invalidate("quote_gap");
  engine.quote(s);
  const second = Math.floor(s.at / 1000);
  if (second !== lastShadowSecond && Date.now() - engine.lastTrade < 5000) { lastShadowSecond = second; shadow.tick(engine.samples, s, Date.now()); }
}, at => { engine.lastTrade = at; }, () => { engine.disconnect(); shadow.invalidate("feed_disconnected"); }, (kind, payload) => store.event(kind, payload));
function feedSession() {
  const k = korea(Date.now());
  return !stopping && k.date >= config.start && k.date <= config.end && k.weekday > 0 && k.weekday < 6 && k.minute >= 540 && k.minute < 920;
}
const feedTimer = setInterval(() => { void feed.tick(feedSession()).catch(() => { lastError = "feed_controller_error"; }); }, 500);
const escape = (s: unknown) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function report() {
  const s = engine.state, quote = engine.latest;
  const now = Date.now();
  return { gitCommit, revision, deployment: { ...gate(), bootId, tickInProgress, protocol: 1 }, ...entryReport(engine, now, { gate: gate(), feedReady: feed.ready, inSession: feedSession(), lastError }),
    feed: { ...feed.snapshot(), droppedFrames: broker.droppedFrames }, version: VERSION, mode: "KIS PAPER ONLY", config, day: s.days.indexOf(korea(Date.now()).date) + 1,
    status: s.halted ?? (lastError || "running"), safeToStop: s.safeToStop && Date.now() - s.lastSync < 60_000,
    ordersArmed: engine.strategyArmed() && gate().allowed,
    warmupSamples: engine.samples.length, quoteAgeMs: quote ? Date.now() - quote.at : null,
    estimatedEquity: s.cash + s.quantity * (quote?.bid ?? (s.quantity ? s.basis / s.quantity : 0)) * (1 - config.fee),
    state: s, shadow: shadow.states, recentEvents: store.db.prepare("SELECT at,kind,payload FROM events ORDER BY id DESC LIMIT 60").all(),
    note: "수수료는 설정 요율 추정. shadow는 1초 지연·가격 관통 가정의 가상 결과로 KIS 체결과 다름. stale quote 평가금액 주의." };
}
const server = createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === "/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, version: VERSION, gitCommit, heartbeat: store.db.prepare("SELECT expires FROM lease WHERE id=1").get() })); return; }
  if (url.pathname === "/report.json") { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(report())); return; }
  if (url.pathname === "/events.csv") {
    const date = url.searchParams.get("date") ?? korea(Date.now()).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400).end(); return; }
    const from = Date.parse(`${date}T00:00:00+09:00`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="range-${date}.csv"`);
    const rows = store.db.prepare("SELECT at,kind,payload FROM events WHERE at>=? AND at<? ORDER BY id LIMIT 100000").all(from, from + 86400_000);
    res.end("\uFEFFat,kind,payload\r\n" + rows.map(r => [new Date(Number(r.at)).toISOString(), r.kind, r.payload].map(v => '"' + String(v).replaceAll('"', '""') + '"').join(",")).join("\r\n")); return;
  }
  if (url.pathname !== "/") { res.writeHead(404).end(); return; }
  const r = report();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>모의 구간 매매</title><style>body{font:16px system-ui;max-width:1050px;margin:32px auto;padding:20px;background:#101722;color:#edf4ff}a{color:#87c9ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#192536;padding:16px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #456;text-align:left}</style><h1>KODEX 코스닥150 · 모의투자</h1><p>배포 커밋: ${escape(gitCommit)}</p><p>${escape(VERSION)} · ${escape(r.day)}일차 · 주문 ${r.ordersArmed ? "활성" : "비활성(관찰)"}</p><p>마지막 실제 판단: ${escape(r.entryBlockReason)} (${escape(r.lastDecision ? new Date(r.lastDecision.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음")})</p><p>현재 진입 상태: ${escape(r.currentEntryStatus)} · 최근 30분 ${r.marketData.samples30m}개 / 5분 ${r.marketData.samples5m}개 · 최대 공백 ${r.marketData.maxGapMs}ms · 연결 시도 ${r.feed.attempts}</p><p>공백 해제 예상: ${escape(r.marketData.gapClearsAfter ? new Date(r.marketData.gapClearsAfter).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "해당 없음")} · 폐기 시세 ${r.feed.droppedFrames.stale + r.feed.droppedFrames.future + r.feed.droppedFrames.invalidTime}개(프로세스 시작 이후)</p><p>상태: ${escape(r.status)} / 종료 확인: ${r.safeToStop ? "보유·미체결 없음" : "종료 확인 필요"}</p><p>추정 자산 ${r.estimatedEquity.toFixed(0)}원 · 실현손익 ${r.state.realized.toFixed(0)}원 · 보유 ${r.state.quantity}주 · 준비 표본 ${r.warmupSamples}/1800</p><p>${escape(r.note)}</p><p><a href="/events.csv">오늘 CSV</a> · <a href="/report.json">전체 상태 JSON</a></p><h2>현재 주문</h2><pre>${escape(JSON.stringify(r.state.orders, null, 2))}</pre><h2>진입 제외 사유</h2><pre>${escape(JSON.stringify(r.state.counts, null, 2))}</pre><h2>최근 기록</h2><table><tr><th>시각(KST)</th><th>이벤트</th><th>내용</th></tr>${r.recentEvents.map(e => `<tr><td>${escape(new Date(Number(e.at)).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</td><td>${escape(e.kind)}</td><td>${escape(e.payload)}</td></tr>`).join("")}</table></html>`);
});
server.listen(8787, "0.0.0.0");
const heartbeat = setInterval(() => { try { store.heartbeat(); } catch { process.exit(2); } }, 10_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; engine.shutdown = true; });
async function run() {
  store.event("runner_started", { version: VERSION, revision, gitCommit, config });
  while (true) {
    const now = Date.now(), k = korea(now), inExperiment = k.date >= config.start && k.date <= config.end;
    try {
      tickInProgress = true;
      await engine.tick(); lastError = "";
      if ((k.minute >= 920 || k.date > config.end) && engine.state.safeToStop) {
        await feed.tick(false);
        try { store.backup(k.date); } catch { store.event("backup_error", { date: k.date }); }
      }
    } catch (e) {
      // No API raw response or credentials in logs.
      lastError = e instanceof Error && /^(KIS |Account\/order|Invalid |Inconsistent |Missing |Incomplete |Repeated |Order pagination|Sell exceeds|Fill amount)/.test(e.message) ? e.message : "runner_error_check_orders";
      store.event("runner_error", { reason: lastError });
      if (engine.state.active) { engine.state.exiting = "runner_error"; engine.save(); }
    } finally { tickInProgress = false; }
    if (stopping && engine.state.safeToStop && !engine.state.active && !engine.state.halted) break;
    await delay(engine.state.active ? 1000 : gateFile || k.minute >= 540 && k.minute < 920 && inExperiment ? 2000 : 60_000);
  }
  clearInterval(feedTimer); feed.stop(); server.close(); clearInterval(heartbeat); store.close();
}
run().catch(() => { console.error("Range runner stopped unexpectedly; reconcile paper orders before restart"); process.exitCode = 1; server.close(); clearInterval(heartbeat); clearInterval(feedTimer); feed.stop(); });
