import unittest
from datetime import date, timedelta
from monthly_validation import simulate


SCHEDULE = [{"effectiveFrom": "2000-01-01", "commissionRate": .000146527, "sellTaxRate": 0}]


def bars(prices):
    return [{"date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(), "open": p, "high": p,
             "low": p, "close": p, "adjusted_close": p, "distribution": 0}
            for i, p in enumerate(prices)]


class MonthlyValidationTests(unittest.TestCase):
    def test_flat_prices_still_lose_roundtrip_costs(self):
        result = simulate(bars([10000]*4), 1, 3, "hold60", SCHEDULE)
        self.assertLess(result["net"], 0)
        self.assertEqual(result["endingQuantity"], 0)
        self.assertEqual([f["side"] for f in result["fills"]], ["buy", "sell"])
        self.assertEqual(result["fills"][-1]["reason"], "month_end_close_proxy")

    def test_gap_stop_can_exceed_limit_and_never_reenter(self):
        result = simulate(bars([10000, 10000, 7000, 11000]), 1, 3, "hold60", SCHEDULE)
        self.assertTrue(result["stopped"])
        self.assertLess(result["net"], -100000)
        self.assertEqual(len(result["fills"]), 2)
        self.assertEqual(result["fills"][-1]["date"], "2026-01-03")

    def test_close_breach_exits_next_open_not_known_close(self):
        data = bars([10000, 10000, 10000, 6000])
        data[2].update(low=8000, close=8000, adjusted_close=8000)
        result = simulate(data, 1, 3, "hold60", SCHEDULE)
        self.assertEqual(result["fills"][-1]["date"], "2026-01-04")
        self.assertEqual(result["fills"][-1]["referencePrice"], 6000)

    def test_low_stress_exits_even_when_close_recovers(self):
        data = bars([10000]*4)
        data[2]["low"] = 7000
        result = simulate(data, 1, 3, "hold60", SCHEDULE, stop_mode="low_stress")
        self.assertTrue(result["stopped"])
        self.assertEqual(result["fills"][-1]["referencePrice"], 7000)

    def test_no_trade_month_still_pays_operating_cost(self):
        result = simulate(bars([10000]*4), 1, 3, "trend120", SCHEDULE, monthly_cost=5000)
        self.assertEqual(result["net"], -5000)
        self.assertEqual(result["trades"], 0)

    def test_future_signal_cannot_buy_at_same_open(self):
        data = bars([10000]*127 + [12000, 12000, 12000])
        result = simulate(data, 127, 129, "momentum126", SCHEDULE)
        self.assertEqual(result["fills"][0]["date"], data[128]["date"])

    def test_stress_costs_reduce_constant_price_wealth(self):
        data = bars([10000]*4)
        base = simulate(data, 1, 3, "hold60", SCHEDULE)
        stress = simulate(data, 1, 3, "hold60", SCHEDULE, multiplier=2)
        self.assertLess(stress["net"], base["net"])

    def test_each_month_resets_capital_and_stop(self):
        data = bars([10000, 10000, 7000, 11000, 11000])
        first = simulate(data, 1, 2, "hold60", SCHEDULE)
        second = simulate(data, 3, 4, "hold60", SCHEDULE)
        self.assertTrue(first["stopped"])
        self.assertFalse(second["stopped"])
        self.assertEqual(second["fills"][0]["side"], "buy")


if __name__ == "__main__":
    unittest.main()
