export const VERSION = "kr-etf-range-v0.2";
export const SYMBOL = "229200";
export type Sample = { at: number; bid: number; ask: number; bidSize: number; askSize: number; providerAt?: number };
export type Box = { low: number; high: number; width: number; stop: number; buys: number[]; targets: number[]; quantities: number[]; at: number; strategy: "A" | "B" };
export function korea(at: number) {
  const d = new Date(at + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}
export const floorTick = (p: number) => Math.floor(p / 5) * 5;
export const ceilTick = (p: number) => Math.ceil(p / 5) * 5;
const mid = (s: Sample) => (s.bid + s.ask) / 2;
export function er(samples: Sample[]) {
  const sum = samples.slice(1).reduce((n, s, i) => n + Math.abs(mid(s) - mid(samples[i])), 0);
  return sum ? Math.abs(mid(samples.at(-1)!) - mid(samples[0])) / sum : Infinity;
}
function width(s: Sample[]) { const p = s.map(mid); return p.length ? Math.max(...p) - Math.min(...p) : 0; }
export function shock(samples: Sample[], at: number) {
  const recent = samples.filter(s => s.at >= at - 60_000);
  const prior = samples.filter(s => s.at >= at - 300_000 && s.at < at - 60_000);
  return recent.length > 10 && prior.length > 30 && width(recent) > Math.max(20, 2 * width(prior));
}
export function validSample(s: Sample) {
  return [s.at,s.bid,s.ask,s.bidSize,s.askSize].every(Number.isFinite) && s.at > 0 && s.bid > 0 && s.ask >= s.bid && s.bid % 5 === 0 && s.ask % 5 === 0 && s.bidSize >= 0 && s.askSize >= 0;
}
export function dataQuality(samples: Sample[], at: number) {
  const date = korea(at).date;
  const window = samples.filter(s => validSample(s) && s.at >= at - 1800_000 && s.at < at && korea(s.at).date === date && korea(s.at).minute >= 540);
  const short = window.filter(s => s.at >= at - 300_000);
  let maxGapMs = 0, lastGapEnd = 0;
  for (let i = 1; i < window.length; i++) {
    const gap = window[i].at - window[i - 1].at;
    maxGapMs = Math.max(maxGapMs, gap);
    if (gap > 10_000) lastGapEnd = window[i].at;
  }
  const spanMs = window.length ? window.at(-1)!.at - window[0].at : 0;
  const reason = lastGapEnd ? "data_gap_30m" : spanMs < 1790_000 ? "warming_30m" : window.length < 1620 ? "insufficient_samples_30m" : short.length < 270 ? "insufficient_samples_5m" : "ready";
  return { ready: reason === "ready", reason, samples30m: window.length, samples5m: short.length, coverage30m: window.length / 1800, coverage5m: short.length / 300, spanMs, maxGapMs, gapClearsAfter: lastGapEnd ? lastGapEnd + 1800_000 : null };
}
export function makeBox(samples: Sample[], at: number, strategy: "A" | "B", fee: number): { box?: Box; reason: string } {
  const k = korea(at), current = samples.at(-1);
  if (k.weekday === 0 || k.weekday === 6 || k.minute < 570 || k.minute >= 915) return { reason: "outside_entry_session" };
  if (!current || at - current.at > 3000 || current.ask - current.bid > 10 || current.bidSize < 3 || current.askSize < 3) return { reason: "stale_or_wide_or_shallow" };
  if (!Number.isFinite(fee) || fee <= 0 || fee >= .01) return { reason: "fee_unconfirmed" };
  const window = samples.filter(s => s.at >= at - 1800_000 && s.at < at && korea(s.at).date === k.date && korea(s.at).minute >= 540);
  const quality = dataQuality(samples, at);
  if (!quality.ready) return { reason: quality.reason };
  const short = window.filter(s => s.at >= at - 300_000);
  if (short.length < 270 || er(window) > .25 || er(short) > .25) return { reason: "directional_market" };
  if (shock(window, at)) return { reason: "volatility_shock" };
  const low = Math.min(...short.map(mid)), high = Math.max(...short.map(mid)), w = high - low;
  const buys = (strategy === "A" ? [.2] : [.3, .2, .1]).map(x => floorTick(low + x * w));
  const targets = buys.map(b => ceilTick(strategy === "A" ? low + .6 * w : b + .3 * w));
  const quantities = strategy === "A" ? [3] : [1, 1, 1];
  const stop = floorTick(low - .1 * w);
  if (new Set(buys).size !== buys.length || buys.some((b, i) => b <= 0 || targets[i] - b < ceilTick((b + targets[i]) * fee + 15))) return { reason: "box_too_narrow_after_cost" };
  if (buys.some(b => b >= current.ask)) return { reason: "price_already_through_entry" };
  if (buys.reduce((n, b, i) => n + b * quantities[i] * (1 + fee), 0) > 300_000 || buys.reduce((n, b, i) => n + (b - stop + 10 + (b + stop) * fee) * quantities[i], 0) > 2000) return { reason: "risk_budget" };
  return { reason: "eligible", box: { low, high, width: w, stop, buys, targets, quantities, at, strategy } };
}
