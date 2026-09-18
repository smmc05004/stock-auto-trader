import type { DailyBar } from "./bars";

/**
 * KIS 국내주식 기간별시세(일봉) 응답을 DailyBar로 바꾼다.
 * 네트워크 호출과 분리해 두어 저장된 응답으로도 재현 검증할 수 있게 한다.
 */
export type KisDailyRow = {
  stck_bsop_date?: string; stck_oprc?: string; stck_hgpr?: string;
  stck_lwpr?: string; stck_clpr?: string; acml_vol?: string;
  /** 수정주가 여부에 따라 응답이 달라지므로 요청 파라미터와 함께 기록한다. */
  prdy_vrss?: string;
};

function numeric(value: string | undefined, field: string, date: string) {
  const parsed = Number(value);
  // 숫자 오류를 0으로 바꾸지 않는다. 잘못된 값이 조용히 신호에 들어가면 안 된다.
  if (value === undefined || value === "" || !Number.isFinite(parsed)) throw new Error(`KIS ${field} is not numeric on ${date}: ${value}`);
  return parsed;
}

export function parseKisDailyRows(symbol: string, rows: KisDailyRow[], options: { adjusted: boolean }): DailyBar[] {
  const bars = rows.map(row => {
    const raw = row.stck_bsop_date ?? "";
    if (!/^\d{8}$/.test(raw)) throw new Error(`KIS stck_bsop_date is malformed: ${raw}`);
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
    const close = numeric(row.stck_clpr, "stck_clpr", date);
    return {
      symbol, date,
      open: numeric(row.stck_oprc, "stck_oprc", date),
      high: numeric(row.stck_hgpr, "stck_hgpr", date),
      low: numeric(row.stck_lwpr, "stck_lwpr", date),
      close,
      volume: numeric(row.acml_vol, "acml_vol", date),
      // 수정주가로 요청한 경우에만 close를 수정 종가로 쓴다. 아니면 호출자가 별도 보정해야 한다.
      adjustedClose: close,
      distribution: 0,
    };
  });
  if (!options.adjusted) {
    // 원주가 응답을 수정 종가처럼 쓰면 분할·분배금 구간에서 신호가 틀어진다.
    for (const bar of bars) bar.adjustedClose = Number.NaN;
  }
  return bars.sort((a, b) => a.date < b.date ? -1 : 1);
}

export type KisDailyFetcher = (params: { symbol: string; start: string; end: string; adjusted: boolean }) => Promise<KisDailyRow[]>;

/** KIS 일봉은 한 번에 최대 100건이라 구간을 나눠 모은다. 중복 날짜는 마지막 응답을 쓴다. */
export async function collectDailyBars(fetcher: KisDailyFetcher, params: {
  symbol: string; start: string; end: string; adjusted: boolean; chunkDays?: number;
}): Promise<DailyBar[]> {
  const { symbol, start, end, adjusted, chunkDays = 100 } = params;
  const byDate = new Map<string, DailyBar>();
  let cursor = Date.parse(`${end}T00:00:00Z`);
  const floor = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(floor) || cursor < floor) throw new Error("Invalid collection range");
  let guard = 0;
  while (cursor >= floor) {
    if (++guard > 200) throw new Error("Collection exceeded the expected number of requests");
    const chunkStart = Math.max(floor, cursor - (chunkDays - 1) * 86400_000);
    const rows = await fetcher({
      symbol, adjusted,
      start: new Date(chunkStart).toISOString().slice(0, 10),
      end: new Date(cursor).toISOString().slice(0, 10),
    });
    if (!rows.length) break;
    for (const bar of parseKisDailyRows(symbol, rows, { adjusted })) byDate.set(bar.date, bar);
    cursor = chunkStart - 86400_000;
  }
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}
