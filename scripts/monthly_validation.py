"""Research only: independent calendar months, fixed capital, liquidation and loss stop.

Reads market SQLite in read-only mode. Does not connect to a broker.
"""
import argparse
import hashlib
import json
import math
import sqlite3
from pathlib import Path


CANDIDATES = ("trend120", "momentum126", "momentum252", "target60", "hold60", "pullback5")


def simulate(bars, start, end, candidate, schedules, monthly_cost=0,
             multiplier=1, stop_mode="next_open", capital=1_000_000):
    if candidate not in CANDIDATES or stop_mode not in ("next_open", "low_stress"):
        raise ValueError("Unknown candidate or stop mode")
    if not 0 <= monthly_cost < capital or not 0 < start <= end < len(bars):
        raise ValueError("Invalid cost or window")
    cash, quantity, fills, stopped = capital - monthly_cost, 0, [], False
    min_equity, held_days = cash, 0
    floor = capital * .9

    def fee(side, price, size, date):
        schedule = next((s for s in reversed(schedules) if s["effectiveFrom"] <= date), None)
        if schedule is None:
            raise ValueError("Cost schedule does not cover date")
        price = max(5, (math.ceil((price + 5 * multiplier) / 5) if side == "buy"
                        else math.floor((price - 5 * multiplier) / 5)) * 5)
        gross = price * size
        costs = gross * (schedule["commissionRate"] * multiplier
                         + (schedule["sellTaxRate"] if side == "sell" else 0))
        return -(gross + costs) if side == "buy" else gross - costs

    def liquidation(price, date):
        return cash + (fee("sell", price, quantity, date) if quantity else 0)

    def sell(bar, price, reason):
        nonlocal cash, quantity
        if quantity:
            cash += fee("sell", price, quantity, bar["date"])
            fills.append({"date": bar["date"], "side": "sell", "quantity": quantity,
                          "referencePrice": price, "reason": reason})
            quantity = 0

    for i in range(start, end + 1):
        bar, history = bars[i], bars[:i]
        date = bar["date"]
        # Costs are reserved at entry. Once stopped, never re-enter this month.
        open_value = liquidation(bar["open"], date)
        min_equity = min(min_equity, open_value)
        if open_value <= floor:
            stopped = True
        if stopped:
            sell(bar, bar["open"], "loss_stop_next_open")
            continue

        closes = [b["adjusted_close"] for b in history[-253:]]
        close = closes[-1]
        trend = len(closes) >= 120 and close > sum(closes[-120:]) / 120
        want = False
        hold_quantity = False
        if candidate == "trend120":
            want = trend
        elif candidate.startswith("momentum"):
            n = int(candidate[8:])
            want = len(closes) > n and close > closes[-1-n]
        elif candidate in ("target60", "hold60"):
            want = True
            hold_quantity = candidate == "hold60" and quantity > 0
        elif candidate == "pullback5":
            # Fixed hypothesis, not tuned on this dataset. Maximum five sessions.
            want = (held_days < 5 and close <= sum(closes[-5:]) / 5) if quantity else (
                trend and len(closes) > 5 and close / closes[-6] - 1 <= -.03)
            hold_quantity = quantity > 0 and want

        target = quantity if hold_quantity else 0
        if want and not hold_quantity:
            buy_price = math.ceil((bar["open"] + 5 * multiplier) / 5) * 5
            schedule = next(s for s in reversed(schedules) if s["effectiveFrom"] <= date)
            target = math.floor((cash + quantity * bar["open"]) * .6 /
                                (buy_price * (1 + schedule["commissionRate"] * multiplier)))
        delta = target - quantity
        if delta:
            side = "buy" if delta > 0 else "sell"
            amount = fee(side, bar["open"], abs(delta), date)
            if cash + amount < -1e-6:
                raise ValueError("Unaffordable order")
            if quantity == 0 and delta > 0:
                held_days = 0
            cash += amount
            quantity += delta
            fills.append({"date": date, "side": side, "quantity": abs(delta),
                          "referencePrice": bar["open"], "reason": "prior_close_signal"})
        held_days = held_days + 1 if quantity else 0
        # No distributions are credited: input is rejected unless all values are zero.
        # Missing corporate-action data remains an explicit adoption blocker.
        low_value = liquidation(bar["low"], date)
        min_equity = min(min_equity, low_value)
        if stop_mode == "low_stress" and low_value <= floor:
            stopped = True
            sell(bar, bar["low"], "loss_stop_daily_low_stress")
        elif liquidation(bar["close"], date) <= floor:
            stopped = True
        if i == end:
            # Scheduled last-day close proxy, not a claimed executable closing auction.
            sell(bar, bar["close"], "month_end_close_proxy")
    if quantity:
        raise AssertionError("Month must finish flat")
    return {"start": bars[start]["date"], "end": bars[end]["date"],
            "net": cash - capital, "endingCash": cash, "endingQuantity": quantity,
            "stopped": stopped, "minReturn": min_equity / capital - 1,
            "trades": len(fills), "fills": fills}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--cost-schedule", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    costs = json.loads(Path(args.cost_schedule).read_text())
    schedules = sorted(costs["schedules"]["domestic_equity_etf"], key=lambda s: s["effectiveFrom"])
    for s in schedules:
        if not 0 <= s["commissionRate"] < .005 or not 0 <= s["sellTaxRate"] < .01:
            raise ValueError("Invalid rate")
    results, datasets = [], []
    with sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        for symbol in ("069500", "229200"):
            bars = [dict(r) for r in db.execute("SELECT * FROM bars WHERE symbol=? ORDER BY date", (symbol,))]
            if len(bars) < 254 or any(b["distribution"] != 0 for b in bars):
                raise ValueError("Requires sufficient history and current zero-distribution dataset")
            for b in bars:
                if not (0 < b["low"] <= min(b["open"], b["close"]) <= max(b["open"], b["close"]) <= b["high"]):
                    raise ValueError("Invalid OHLC")
            datasets.append({"symbol": symbol, "first": bars[0]["date"], "last": bars[-1]["date"],
                             "rows": len(bars), "sha256": hashlib.sha256(json.dumps(bars, sort_keys=True).encode()).hexdigest()})
            months = sorted({b["date"][:7] for b in bars if bars[253]["date"][:7] < b["date"][:7] < bars[-1]["date"][:7]})
            for candidate in CANDIDATES:
                for mode in ("next_open", "low_stress"):
                    for multiplier in (1, 2):
                        for operating in (0, 1000, 5000, 10000):
                            rows = []
                            for month in months:
                                indices = [i for i,b in enumerate(bars) if b["date"].startswith(month)]
                                row = simulate(bars, indices[0], indices[-1], candidate, schedules,
                                               operating, multiplier, mode)
                                rows.append(row)
                            results.append({"symbol": symbol, "candidate": candidate, "stopMode": mode,
                                            "costMultiplier": multiplier, "monthlyOperatingCost": operating,
                                            "months": len(rows), "positive": sum(r["net"] > 0 for r in rows),
                                            "zero": sum(abs(r["net"]) < 1e-8 for r in rows),
                                            "meanNet": sum(r["net"] for r in rows) / len(rows),
                                            "worstNet": min(r["net"] for r in rows),
                                            "stops": sum(r["stopped"] for r in rows),
                                            "lossLimitExceeded": sum(r["minReturn"] < -.1 for r in rows),
                                            "rows": rows})
    report = {"capital": 1000000, "lossLimit": .1, "datasets": datasets, "costModel": costs,
              "limitations": ["Exploratory previously viewed data; no untouched test remains",
                              "Calendar months, not arbitrary start dates; calendar completeness unverified",
                              "Distributions and adjustment semantics unverified; account commission unconfirmed",
                              "Operating costs are scenarios, not actual bills; full cost reserved at month start",
                              "next_open checks open and close; low_stress sells at the observed daily low as adverse stress only",
                              "Stops cannot guarantee 10% cap; intraday lows and opening gaps may exceed it",
                              "Month-end last-close liquidation proxy includes adverse tick rounding and commission",
                              "pullback5 is a new fixed hypothesis, not a published strategy reproduction"], "results": results}
    Path(args.output).write_text(json.dumps(report, indent=2))
    print(json.dumps({"output": args.output, "scenarios": len(results), "datasets": datasets}))


if __name__ == "__main__":
    main()
