import type { RangeEngine } from "./engine";
import { korea, dataQuality, makeBox } from "./strategy";

/** Current eligibility is a preview; only lastDecision describes a completed engine evaluation. */
export function entryReport(engine: RangeEngine, now: number, options: {
  gate: { allowed: boolean; reason: string }; feedReady: boolean; inSession: boolean; lastError: string;
}) {
  const { gate, feedReady, inSession, lastError } = options;
  const s = engine.state, quote = engine.latest, config = engine.config;
  const k = korea(now), day = s.days.indexOf(k.date) + 1;
  const quality = dataQuality(engine.samples, now);
  const signal = makeBox(engine.samples, now, day % 2 ? "A" : "B", config.fee);
  const currentEntryStatus = s.halted ?? (!gate.allowed ? gate.reason : lastError || (
    !inSession || k.minute < 570 || k.minute >= 915 ? "outside_entry_session" :
    s.active ? "managing_orders_or_position" : !feedReady ? "feed_reconnecting" :
    !quote || now - quote.at > 3000 || now - engine.lastTrade > 5000 ? "no_fresh_market" :
    !quality.ready ? quality.reason : now - s.lastSync > 15_000 ? "account_snapshot_stale" :
    !engine.strategyArmed() ? "orders_not_armed" : day < 3 ? "observation_or_preflight_day" :
    s.exiting || s.streak >= 3 || s.boxes >= 30 || now - s.lastEnd < 60_000 ? "risk_limit_or_cooldown" :
    signal.box && (s.counts[`${signal.box.low}:${signal.box.high}`] ?? 0) >= 2 ? "box_reentry_limit" : signal.reason));
  return { marketData: quality, lastDecision: s.lastDecision ?? null, currentEntryStatus,
    entryBlockReason: s.lastDecision?.reason ?? "not_evaluated" };
}
