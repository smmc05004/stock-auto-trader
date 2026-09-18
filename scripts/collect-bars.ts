/**
 * KIS 일봉 수집 스크립트. 수집만 하고 주문은 하지 않는다.
 *   npx tsx scripts/collect-bars.ts --symbol 229200 --start 2020-01-01 --end 2026-09-17
 * 모의/실전 어느 키를 쓰는지와 수정주가 여부를 결과에 함께 기록한다.
 */
import { BarStore } from "../src/lib/marketData/store";
import { collectDailyBars, type KisDailyRow } from "../src/lib/marketData/kis";
import { checkBars } from "../src/lib/marketData/bars";

const BASE = process.env.KIS_BASE_URL ?? "https://openapivts.koreainvestment.com:29443";
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
  if (!res.ok) throw new Error(`Token request failed with HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Token response did not contain access_token");
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
    if (!res.ok) throw new Error(`Daily chart request failed with HTTP ${res.status}`);
    const data = await res.json() as { rt_cd?: string; msg1?: string; output2?: KisDailyRow[] };
    if (data.rt_cd !== "0") throw new Error(`KIS rejected the daily chart request: ${data.msg1 ?? "unknown"}`);
    return (data.output2 ?? []).filter(r => r.stck_bsop_date);
  }, { symbol, start, end, adjusted: true });

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
