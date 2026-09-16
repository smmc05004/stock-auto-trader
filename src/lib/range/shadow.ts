import { type Box, type Sample, korea, makeBox, shock } from "./strategy";
import { type RangeStore } from "./store";
type Leg = { buy: number; target: number; quantity: number; bought?: number; sold?: number };
type Shadow = { cash: number; realized: number; active?: Box; legs: Leg[]; firstFill?: number; lastEval: number; lastEnd: number; trades: number; day: string; dayStart: number; streak: number; groupStart: number; boxes: number; counts: Record<string, number> };
export class ShadowComparison {
  readonly states: Record<"A" | "B", Shadow>;
  constructor(readonly store: RangeStore, readonly fee: number) {
    const initial = (): Shadow => ({ cash: 1_000_000, realized: 0, legs: [], lastEval: 0, lastEnd: 0, trades: 0, day: "", dayStart: 0, streak: 0, groupStart: 0, boxes: 0, counts: {} });
    this.states = store.get("shadow") ?? { A: initial(), B: initial() };
  }
  invalidate(reason: string) {
    for (const variant of ["A", "B"] as const) {
      const s = this.states[variant];
      if (!s.active) continue;
      this.store.event("shadow_scenario_excluded", { variant, reason, state: structuredClone(s), interpretation: "unobserved_path_not_a_fill" });
      s.cash = 1_000_000 + s.groupStart; s.realized = s.groupStart;
      s.trades -= s.legs.filter(l => l.sold).length;
      s.active = undefined; s.legs = []; s.firstFill = undefined;
      s.lastEnd = Date.now();
    }
    this.store.save("shadow", this.states);
  }
  tick(samples: Sample[], quote: Sample, now: number) {
    if (!Number.isFinite(this.fee) || this.fee <= 0) return;
    for (const variant of ["A", "B"] as const) {
      const s = this.states[variant], k = korea(now);
      if (s.day !== k.date && !s.active) { s.day = k.date; s.dayStart = s.realized; s.streak = 0; s.boxes = 0; s.counts = {}; }
      if (s.active) {
        const equity = s.cash + s.legs.filter(l => l.bought && !l.sold).reduce((n, l) => n + quote.bid * l.quantity * (1 - this.fee), 0);
        const exit = s.active.at + 86400_000 < now || korea(s.active.at).date !== k.date || k.minute >= 915 || quote.bid <= s.active.stop || (s.firstFill !== undefined && now - s.firstFill >= 120_000) || shock(samples, now) || equity - 1_000_000 - s.dayStart <= -10_000;
        for (const l of s.legs) {
          // Delayed cross-through scenario: deliberately not a claim of actual queue fills.
          if (!exit && !l.bought && now - s.active.at >= 1000 && now - s.active.at < 10_000 && quote.ask <= l.buy - 5) {
            l.bought = now; s.firstFill ??= now; s.cash -= l.buy * l.quantity * (1 + this.fee);
          }
          if (l.bought && !l.sold && (exit || (now - l.bought >= 1000 && quote.bid >= l.target + 5))) {
            const price = exit ? quote.bid - 10 : l.target;
            const pnl = l.quantity * (price * (1 - this.fee) - l.buy * (1 + this.fee));
            l.sold = now; s.cash += price * l.quantity * (1 - this.fee); s.realized += pnl; s.trades++;
            this.store.event("shadow_fill_scenario", { variant, quantity: l.quantity, buy: l.buy, sell: price, pnl, model: "1s-delay-cross-through-no-queue", exit });
          }
        }
        if ((exit || now - s.active.at >= 10_000) && s.legs.every(l => !l.bought || l.sold)) {
          const pnl = s.realized - s.groupStart;
          if (s.legs.some(l => l.bought)) s.streak = pnl < 0 ? s.streak + 1 : 0;
          s.active = undefined; s.legs = []; s.firstFill = undefined; s.lastEnd = now;
        }
      } else if (Math.floor(s.lastEval / 60_000) !== Math.floor(now / 60_000) && now - s.lastEnd >= 60_000 && s.streak < 3 && s.boxes < 30 && s.realized - s.dayStart > -10_000) {
        s.lastEval = now;
        const box = makeBox(samples, now, variant, this.fee).box;
        if (box) {
          const key = `${box.low}:${box.high}`;
          if ((s.counts[key] ?? 0) < 2) {
            s.counts[key] = (s.counts[key] ?? 0) + 1; s.boxes++; s.groupStart = s.realized;
            s.active = box; s.legs = box.buys.map((buy, i) => ({ buy, target: box.targets[i], quantity: box.quantities[i] }));
          }
        }
      }
    }
    this.store.save("shadow", this.states);
  }
}
