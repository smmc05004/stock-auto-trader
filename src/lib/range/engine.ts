import { createHash, randomUUID } from "node:crypto";
import { type RangeBroker, type RemoteOrder } from "./broker";
import { RangeStore } from "./store";
import { VERSION, SYMBOL, korea, makeBox, shock, ceilTick, floorTick, dataQuality, validSample, type Box, type Sample } from "./strategy";
export type Config = { start: string; end: string; fee: number; enabled: boolean; cancellationVerified: boolean; autoPreflight?: boolean; feeBasis?: string };
export type LocalOrder = { key: string; id?: string; org?: string; side: "buy" | "sell"; qty: number; price: number | null; filled: number; amount: number; remaining: number; terminal: boolean; cancelled?: boolean; at: number; status: "intent" | "accepted" | "unknown"; cancelAt?: number; cancelId?: string; leg: number };
export type State = { version: string; configHash: string; date: string; days: string[]; active?: Box; orders: LocalOrder[]; cash: number; quantity: number; basis: number; firstFill?: number; exiting?: string; halted?: string; realized: number; dayStart: number; high: number; drawdown: number; streak: number; boxes: number; groupStart: number; lastEnd: number; lastEval: number; counts: Record<string, number>; pnl: Record<string, number>; lastSync: number; safeToStop: boolean; preflight?: { status: "running" | "passed" | "failed"; at: number; pnl?: number; cancelOrderId?: string } };
type Broker = Pick<RangeBroker, "orders" | "positions" | "submit" | "cancel">;
export function linkedCancellation(local: LocalOrder, original: RemoteOrder, rows: RemoteOrder[]) {
  return Boolean(local.cancelAt && local.cancelId && original.id === local.id && original.symbol === SYMBOL && original.date === korea(local.at).date.replaceAll("-", "") && original.side === local.side && original.qty === local.qty && original.rejected === 0 && original.remaining === 0 && rows.some(c => c.id === local.cancelId && c.parent === original.id && c.date === original.date && c.symbol === original.symbol && c.side === original.side && c.cancelled && c.rejected === 0 && c.remaining === 0 && c.filled === 0 && c.qty === original.qty - original.filled && c.qty > 0));
}

export function validateConfig(c: Config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start) || !/^\d{4}-\d{2}-\d{2}$/.test(c.end)) throw new Error("Explicit experiment dates required");
  const start = Date.parse(c.start), end = Date.parse(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== c.start || new Date(end).toISOString().slice(0, 10) !== c.end || end < start || end - start > 13 * 86400_000) throw new Error("Experiment must be at most 14 calendar days");
  if (!Number.isFinite(c.fee) || c.fee < 0 || c.fee >= .01) throw new Error("Invalid decimal fee rate");
  if (c.enabled && ((!c.cancellationVerified && !c.autoPreflight) || c.fee <= 0)) throw new Error("Orders require cancellation gate and configured fee");
}
export class RangeEngine {
  state: State;
  samples: Sample[] = [];
  latest?: Sample;
  lastTrade = 0;
  shutdown = false;
  entryAllowed: () => boolean = () => true;
  constructor(readonly store: RangeStore, readonly broker: Broker, readonly config: Config, readonly clock = Date.now) {
    validateConfig(config);
    const hash = createHash("sha256").update(JSON.stringify({ ...config, version: VERSION })).digest("hex");
    this.state = store.get<State>("state") ?? { version: VERSION, configHash: hash, date: "", days: [], orders: [], cash: 1_000_000, quantity: 0, basis: 0, realized: 0, dayStart: 0, high: 1_000_000, drawdown: 0, streak: 0, boxes: 0, groupStart: 0, lastEnd: 0, lastEval: 0, counts: {}, pnl: {}, lastSync: 0, safeToStop: false };
    if (this.state.version !== VERSION) throw new Error("Persisted strategy version differs");
    if (this.state.configHash !== hash) {
      const previous = store.get<Config>("config");
      if (!previous || previous.start !== config.start || previous.end !== config.end || this.state.active || this.state.orders.length || this.state.quantity) throw new Error("Persisted experiment config differs; reconcile before config change");
      store.event("config_changed_flat", { previous, next: config });
      this.state.configHash = hash;
    }
    store.save("config", config);
    if (this.state.orders.some(o => o.status !== "accepted")) this.state.halted = "unknown_order_on_restart";
    if (this.state.active) this.state.exiting = "restart_reconciliation";
    this.state.safeToStop = false; this.save();
    const now = this.clock();
    const rows = store.db.prepare("SELECT * FROM quotes WHERE at>=? AND at<? ORDER BY at").all(now - 1800_000, now);
    const seen = new Set<number>();
    this.samples = rows.map(r => ({ at: Number(r.at), bid: Number(r.bid), ask: Number(r.ask), bidSize: Number(r.bid_size), askSize: Number(r.ask_size) })).filter(s => {
      const second = Math.floor(s.at / 1000);
      if (!validSample(s) || korea(s.at).date !== korea(now).date || korea(s.at).minute < 540 || seen.has(second)) return false;
      seen.add(second); return true;
    });
    this.event("quotes_restored", { count: this.samples.length, quality: dataQuality(this.samples, now), requiresLiveFeed: true });
  }
  save() { this.store.save("state", this.state); }
  strategyArmed() { return this.config.enabled && this.config.fee > 0 && (this.config.cancellationVerified || this.state.preflight?.status === "passed"); }
  event(kind: string, payload: unknown) { this.store.event(kind, payload); }
  quote(s: Sample) {
    if (!validSample(s) || s.at > this.clock() + 1000 || (this.latest && s.at < this.latest.at)) return;
    this.latest = s;
    const previous = this.samples.at(-1);
    if (previous && s.at <= previous.at) return;
    if (previous && Math.floor(s.at / 1000) === Math.floor(previous.at / 1000)) return;
    if (previous && s.at - previous.at > 10_000) this.event("quote_gap", { from: previous.at, to: s.at, gapMs: s.at - previous.at });
    this.samples = this.samples.filter(q => q.at >= s.at - 1800_000 && korea(q.at).date === korea(s.at).date);
    this.samples.push(s);
    this.store.db.prepare("INSERT OR IGNORE INTO quotes VALUES(?,?,?,?,?)").run(s.at, s.bid, s.ask, s.bidSize, s.askSize);
    if (s.providerAt) this.store.db.prepare("INSERT OR IGNORE INTO quote_source_times VALUES(?,?,?)").run(s.at, SYMBOL, s.providerAt);
  }
  disconnect() {
    this.event("feed_unavailable", { retainedSamples: this.samples.length, lastQuoteAt: this.latest?.at, lastTradeAt: this.lastTrade });
    this.latest = undefined; this.lastTrade = 0;
    if (this.state.active) { this.state.exiting = "feed_disconnected"; this.save(); }
  }
  private equity() { return this.state.cash + this.state.quantity * (this.latest?.bid ?? (this.state.quantity ? this.state.basis / this.state.quantity : 0)) * (1 - this.config.fee); }
  private block(reason: string) { this.state.counts[reason] = (this.state.counts[reason] ?? 0) + 1; this.event("decision", { reason, at: this.clock() }); }
  async reconcile() {
    const s = this.state, now = this.clock(), date = korea(now).date;
    const start = s.date && s.active ? s.date : date;
    const remote = await this.broker.orders(start, date);
    this.store.assertOwner();
    for (const local of s.orders) {
      if (!local.id) { s.halted = "unknown_order"; continue; }
      const r = remote.find(o => o.id === local.id && o.symbol === SYMBOL && o.date === korea(local.at).date.replaceAll("-", ""));
      if (!r) {
        if (!local.terminal && now - local.at > 30_000) s.halted = "accepted_order_missing";
        continue;
      }
      this.applyFill(local, { ...r, cancelled: r.cancelled || linkedCancellation(local, r, remote) });
    }
    const open = remote.filter(r => r.remaining > 0 && !r.cancelled && r.rejected < r.qty && (!r.parent || /^0+$/.test(r.parent)));
    if (open.some(r => !s.orders.some(o => o.id === r.id))) s.halted = "external_open_order";
    const positions = await this.broker.positions();
    const expected = positions.find(p => p.symbol === SYMBOL)?.qty ?? 0;
    if (positions.some(p => p.symbol !== SYMBOL) || expected !== s.quantity) {
      // Balance/order endpoints can be briefly inconsistent: no new mutation until the next consistent snapshot.
      s.safeToStop = false; this.save(); throw new Error("Account/order snapshot mismatch");
    }
    s.lastSync = this.clock();
    s.safeToStop = !s.halted && s.quantity === 0 && s.orders.every(o => o.terminal) && open.length === 0;
    this.event("reconciled", { quantity: s.quantity, openOrders: open.length, safeToStop: s.safeToStop }); this.save();
  }
  applyFill(local: LocalOrder, r: RemoteOrder) {
    const before = structuredClone(this.state);
    this.store.db.exec("BEGIN IMMEDIATE");
    try { this.applyFillState(local, r); this.store.db.exec("COMMIT"); }
    catch (e) { this.store.db.exec("ROLLBACK"); this.state = before; throw e; }
  }
  private applyFillState(local: LocalOrder, r: RemoteOrder) {
    const s = this.state;
    if (r.side !== local.side || r.filled < local.filled || r.filled > local.qty || r.remaining < 0 || !Number.isInteger(r.filled) || !Number.isInteger(r.remaining)) throw new Error("Inconsistent cumulative fill");
    const amount = r.filled * r.average, delta = r.filled - local.filled, deltaAmount = amount - local.amount;
    if (delta > 0) {
      if (deltaAmount <= 0) throw new Error("Invalid incremental execution amount");
      if (local.side === "buy") {
        s.quantity += delta; s.basis += deltaAmount * (1 + this.config.fee); s.cash -= deltaAmount * (1 + this.config.fee); s.firstFill ??= this.clock();
      } else {
        if (delta > s.quantity) throw new Error("Sell exceeds owned position");
        const cost = s.basis * delta / s.quantity;
        s.cash += deltaAmount * (1 - this.config.fee); s.realized += deltaAmount * (1 - this.config.fee) - cost;
        s.basis -= cost; s.quantity -= delta;
      }
      this.event("fill", { order: local.key, id: local.id, side: local.side, quantity: delta, amount: deltaAmount, estimatedFee: deltaAmount * this.config.fee, strategy: s.active?.strategy });
    } else if (Math.abs(deltaAmount) > .01) throw new Error("Fill amount changed without quantity");
    local.filled = r.filled; local.amount = amount; local.remaining = r.remaining;
    local.cancelled = r.cancelled;
    local.terminal = r.remaining === 0 || r.cancelled || r.rejected === r.qty;
    if (r.rejected > 0) { s.halted = "broker_rejected_order"; s.exiting = "broker_rejected_order"; }
    this.save();
  }
  async submit(side: "buy" | "sell", qty: number, price: number | null, leg: number) {
    const s = this.state;
    if (side === "buy" && !this.entryAllowed()) return;
    if (s.halted || !this.config.enabled) throw new Error("Orders disabled or halted");
    if (!this.strategyArmed() && s.preflight?.status !== "running") throw new Error("Cancellation preflight not passed");
    if (side === "sell" && (qty > s.quantity || qty + s.orders.filter(o => o.side === "sell" && !o.terminal).reduce((n, o) => n + o.remaining, 0) > s.quantity)) throw new Error("Oversell prevented");
    const o: LocalOrder = { key: randomUUID(), side, qty, price, leg, at: this.clock(), filled: 0, amount: 0, remaining: qty, terminal: false, status: "intent" };
    s.orders.push(o); s.safeToStop = false; this.save(); this.event("order_intent", o);
    try {
      this.store.assertOwner(); const result = await this.broker.submit(side, qty, price); this.store.assertOwner();
      Object.assign(o, result); o.status = "accepted"; this.event("order_accepted", { key: o.key, ...result, latency: this.clock() - o.at });
    } catch (e) { o.status = "unknown"; s.halted = "order_outcome_unknown"; this.event("order_unknown", { key: o.key }); this.save(); throw e; }
    this.save();
  }
  async cancel(o: LocalOrder) {
    if (!o.id || !o.org || o.terminal || o.cancelAt) return;
    o.cancelAt = this.clock(); this.save(); this.event("cancel_intent", { key: o.key, remaining: o.remaining });
    try { this.store.assertOwner(); o.cancelId = await this.broker.cancel({ id: o.id, org: o.org }, o.remaining); this.event("cancel_accepted", { key: o.key, latency: this.clock() - o.cancelAt }); }
    catch { this.event("cancel_unknown", { key: o.key }); this.state.exiting = "cancel_unknown"; }
    this.save();
  }
  async tick() {
    this.store.assertOwner();
    const now = this.clock(), k = korea(now), s = this.state;
    if (k.date < this.config.start || k.date > this.config.end || k.minute >= 915 || this.shutdown) s.exiting = "session_end";
    if (s.active && (!this.latest || now - this.latest.at > 5000 || now - this.lastTrade > 15_000)) s.exiting = "stale_feed";
    if (s.active && this.latest && this.latest.bid <= s.active.stop) s.exiting = "stop_loss";
    if (s.active && shock(this.samples, now)) s.exiting = "volatility_shock";
    if (s.firstFill && now - s.firstFill >= 120_000) s.exiting = "holding_timeout";
    await this.reconcile();
    if (s.halted) { this.save(); return; }
    // Reconciliation may take seconds: reassess urgent conditions after network waits.
    const afterSync = this.clock();
    if (s.active && (korea(afterSync).minute >= 915 || korea(afterSync).date > this.config.end || this.shutdown)) s.exiting = "session_end";
    if (s.active && (!this.latest || afterSync - this.latest.at > 5000 || afterSync - this.lastTrade > 15_000)) s.exiting = "stale_feed";
    if (s.active && this.latest && this.latest.bid <= s.active.stop) s.exiting = "stop_loss";
    if (s.firstFill && afterSync - s.firstFill >= 120_000) s.exiting = "holding_timeout";
    if (!s.active && s.date !== k.date) {
      if (s.date) this.event("day_summary", { date: s.date, realized: s.realized - s.dayStart, drawdown: s.drawdown, boxes: s.boxes, excluded: s.counts });
      s.date = k.date; s.dayStart = s.realized; s.streak = 0; s.boxes = 0; s.counts = {}; s.pnl = {}; s.high = this.equity(); s.drawdown = 0; s.exiting = undefined; this.save();
    }
    const equity = this.equity(); s.high = Math.max(s.high, equity); s.drawdown = Math.max(s.drawdown, s.high - equity);
    if (s.realized - s.dayStart + (equity - (1_000_000 + s.realized)) <= -10_000 || s.streak >= 3) s.exiting = "daily_risk_stop";
    if (s.active) {
      if (s.preflight?.status === "running") s.exiting = "preflight_cleanup";
      for (const o of s.orders.filter(o => !o.terminal && o.status === "accepted")) {
        if (s.exiting || (o.side === "buy" && now - o.at >= 10_000)) await this.cancel(o);
        if (o.cancelAt && now - o.cancelAt > 30_000 && !o.terminal) { s.halted = "cancel_confirmation_timeout"; this.save(); return; }
      }
      if (s.exiting) {
        if (s.orders.every(o => o.terminal) && s.quantity > 0) await this.submit("sell", s.quantity, null, -1);
      } else {
        for (let leg = 0; leg < s.active.buys.length; leg++) {
          const buy = s.orders.find(o => o.side === "buy" && o.leg === leg);
          if (!buy || !buy.terminal || buy.filled === 0 || s.orders.some(o => o.side === "sell" && o.leg === leg)) continue;
          const target = s.active.strategy === "A" ? s.active.targets[leg] : ceilTick(buy.amount / buy.filled + .3 * s.active.width);
          await this.submit("sell", buy.filled, target, leg);
        }
      }
      if (s.orders.every(o => o.terminal) && s.quantity === 0) {
        const pnl = s.realized - s.groupStart;
        if (s.preflight?.status === "running") {
          const buy = s.orders.find(o => o.side === "buy");
          const passed = Boolean(buy?.cancelled && buy.cancelAt && buy.cancelId && buy.filled === 0);
          s.preflight = { status: passed ? "passed" : "failed", at: s.preflight.at, pnl, cancelOrderId: buy?.cancelId };
          this.event("preflight_finished", s.preflight);
          // Keep diagnostic P&L separately from strategy P&L; virtual strategy capital restarts flat.
          s.cash -= pnl; s.realized -= pnl;
          if (!passed) s.halted = "preflight_failed_check_orders";
        } else {
          if (s.orders.some(o => o.filled > 0)) s.streak = pnl < 0 ? s.streak + 1 : 0;
          this.event("box_closed", { strategy: s.active.strategy, pnl, reason: s.exiting ?? "targets_or_no_fill" });
        }
        s.active = undefined; s.orders = []; s.firstFill = undefined; s.lastEnd = now;
        if (s.exiting !== "daily_risk_stop") s.exiting = undefined;
      }
      this.save(); return;
    }
    if (!this.entryAllowed()) { this.save(); return; }
    if (Math.floor(now / 60_000) === Math.floor(s.lastEval / 60_000)) { this.save(); return; }
    s.lastEval = now;
    if (k.date < this.config.start || k.date > this.config.end || k.weekday === 0 || k.weekday === 6 || k.minute < 540 || k.minute >= 915 || this.shutdown) { this.block("outside_experiment_session"); this.save(); return; }
    if (!this.latest || now - this.latest.at > 3000 || now - this.lastTrade > 5000) { this.block("no_fresh_market"); this.save(); return; }
    if (!s.days.includes(k.date)) { if (s.days.length >= 10) { this.block("experiment_complete"); this.save(); return; } s.days.push(k.date); }
    const day = s.days.indexOf(k.date) + 1, strategy = day % 2 === 1 ? "A" : "B";
    if (this.config.enabled && this.config.autoPreflight && !this.config.cancellationVerified && !s.preflight && day >= 2 && k.minute >= 570 && k.minute < 900 && s.safeToStop && dataQuality(this.samples, now).ready) {
      const price = floorTick(this.latest.bid * .98);
      if (price <= 0 || price > 300_000 || this.latest.ask - this.latest.bid > 10) { this.block("preflight_price_ineligible"); this.save(); return; }
      s.preflight = { status: "running", at: now };
      s.active = { low: price, high: price + 20, width: 20, stop: price - 10, buys: [price], targets: [price + 20], quantities: [1], at: now, strategy: "A" };
      s.groupStart = s.realized; s.orders = []; s.safeToStop = false; this.save();
      this.event("preflight_started", { symbol: SYMBOL, quantity: 1, price, purpose: "cancel_verification_not_strategy" });
      await this.submit("buy", 1, price, 0);
      s.exiting = "preflight_cleanup"; this.save(); return;
    }
    for (const variant of ["A", "B"] as const) {
      const result = makeBox(this.samples, now, variant, this.config.fee);
      this.event("shadow_signal", { strategy: variant, ...result, executionSimulated: false });
    }
    if (!this.strategyArmed() || day < 3) { this.block(day < 3 ? "observation_or_preflight_day" : "orders_not_armed"); this.save(); return; }
    if (s.exiting || s.streak >= 3 || s.boxes >= 30 || now - s.lastEnd < 60_000) { this.block("risk_limit_or_cooldown"); this.save(); return; }
    const result = makeBox(this.samples, now, strategy, this.config.fee);
    if (!result.box) { this.block(result.reason); this.save(); return; }
    const key = `${result.box.low}:${result.box.high}`;
    if ((s.counts[key] ?? 0) >= 2) { this.block("box_reentry_limit"); this.save(); return; }
    s.counts[key] = (s.counts[key] ?? 0) + 1; s.active = result.box; s.orders = []; s.groupStart = s.realized; s.boxes++; s.safeToStop = false; this.save();
    this.event("box_open", s.active);
    for (let leg = 0; leg < result.box.buys.length; leg++) {
      const fresh = this.latest;
      if (!fresh || this.clock() - fresh.at > 3000 || this.clock() - this.lastTrade > 5000 || fresh.bid <= result.box.stop || fresh.ask - fresh.bid > 10 || fresh.ask <= result.box.buys[leg] || korea(this.clock()).minute >= 915 || this.shutdown) { s.exiting = "entry_aborted"; this.save(); break; }
      await this.submit("buy", result.box.quantities[leg], result.box.buys[leg], leg);
    }
    this.save();
  }
}
