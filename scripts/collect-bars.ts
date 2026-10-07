/**
 * KIS 일봉 수집 스크립트. 수집만 하고 주문은 하지 않는다.
 *   npx tsx scripts/collect-bars.ts --symbol 229200 --start 2020-01-01 --end 2026-09-17
 * 모의/실전 어느 키를 쓰는지와 수정주가 여부를 결과에 함께 기록한다.
 */
import { BarStore } from "../src/lib/marketData/store";
import { collectDailyBars, type KisDailyRow } from "../src/lib/marketData/kis";
import { checkBars } from "../src/lib/marketData/bars";

// 빈 문자열도 미설정으로 본다. Compose와 .env.local이 KIS_BASE_URL을 빈 값으로 두는 경우가 있다.
const BASE = process.env.KIS_BASE_URL || "https://openapivts.koreainvestment.com:29443";
const APP_KEY = process.env.KIS_PAPER_APP_KEY ?? "";
const APP_SECRET = process.env.KIS_PAPER_APP_SECRET ?? "";

function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

async function token() {
  const res = await fetch(new URL("/oauth2/tokenP", BASE), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: APP_KEY, appsecret: APP_SECRET }),
  });
  const data = await res.json().catch(() => ({})) as { access_token?: string; error_code?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Token request failed: HTTP ${res.status} ${data.error_code ?? ""} ${data.error_description ?? ""}`.trim());
  }
  return data.access_token;
}

async function main() {
  const symbol = arg("symbol");
  const start = arg("start");
  const end = arg("end");
  const file = arg("db", "data/market/bars.sqlite");
  const datasetVersion = arg("dataset", `kis-${new Date().toISOString().slice(0, 10)}`);
  if (!APP_KEY || !APP_SECRET) throw new Error("KIS_PAPER_APP_KEY / KIS_PAPER_APP_SECRET are required");

  const access = await token();
  // 토큰 직후 바로 조회하면 초당 호출 제한에 걸린다. 첫 요청 전에 잠시 둔다.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const bars = await collectDailyBars(async ({ symbol: code, start: from, end: to, adjusted }) => {
    const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", BASE);
    for (const [k, v] of Object.entries({
      FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: from.replaceAll("-", ""), FID_INPUT_DATE_2: to.replaceAll("-", ""),
      FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: adjusted ? "0" : "1",
    })) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: {
      "content-type": "application/json", authorization: `Bearer ${access}`,
      appkey: APP_KEY, appsecret: APP_SECRET, tr_id: "FHKST03010100", custtype: "P" } });
    // KIS는 오류도 본문에 코드를 담아 보내므로 상태코드만 보고 버리지 않는다.
    const data = await res.json().catch(() => ({})) as { rt_cd?: string; msg_cd?: string; msg1?: string; output2?: KisDailyRow[] };
    if (!res.ok || data.rt_cd !== "0") {
      throw new Error(`Daily chart request failed: HTTP ${res.status} rt_cd=${data.rt_cd ?? "?"} msg_cd=${data.msg_cd ?? "?"} msg=${String(data.msg1 ?? "").trim() || "unknown"}`);
    }
    return (data.output2 ?? []).filter(r => r.stck_bsop_date);
  }, { symbol, start, end, adjusted: true, delayMs: 700 });

  const issues = checkBars(bars);
  const store = new BarStore(file);
  const result = store.ingest(bars, datasetVersion);
  store.close();

  console.log(JSON.stringify({
    symbol, start, end, datasetVersion, file,
    fetched: bars.length, first: bars[0]?.date, last: bars.at(-1)?.date,
    written: result.written, revisions: result.revisions,
    issues: issues.slice(0, 20),
    note: "FID_ORG_ADJ_PRC=0 으로 수정주가를 요청했다. 분배금 컬럼은 별도 확보가 필요하다.",
  }, null, 2));
  if (issues.length) process.exitCode = 1;
}

main().catch(error => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); });
