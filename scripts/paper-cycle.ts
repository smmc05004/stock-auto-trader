import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { validatePaperProbeEnvironment } from "../src/lib/runner/paperProbe";
import { isRecentBar, planPaperCycle, seoulClock, testSessionAllowed, type PaperCycle } from "../src/lib/runner/paperCycle";
import { readCycle, saveCycle, withPaperLock } from "../src/lib/runner/paperJournal";

const directory = process.env.PAPER_STATE_DIR ?? "/app/data";
async function report(event: string, detail: Record<string, unknown> = {}) {
  const line = JSON.stringify({ event, ...detail, at: new Date().toISOString() });
  await appendFile(path.join(directory, "paper-events.jsonl"), `${line}\n`, { mode: 0o600 });
  console.log(line);
}

async function main() {
  const symbol = validatePaperProbeEnvironment(process.env);
  await withPaperLock(directory, async () => {
    const accountHash = createHash("sha256").update(`${process.env.KIS_PAPER_ACCOUNT_NO}:${process.env.KIS_PAPER_ACCOUNT_PRODUCT_CODE ?? "01"}`).digest("hex");
    const state: PaperCycle = await readCycle(directory) ?? { version: 1, accountHash, symbol, complete: false };
    if (state.accountHash !== accountHash || state.symbol !== symbol) throw new Error("Stored cycle belongs to a different account or symbol.");
    if (state.complete) { await report("cycle_complete"); return; }
    const now = new Date();
    const clock = seoulClock(now);
    if (!state.buy && !testSessionAllowed(process.env.PAPER_TEST_DATE, now)) {
      await report("outside_test_session"); return;
    }
    const { KisBrokerClient } = await import("../src/lib/broker/kisBroker");
    const broker = new KisBrokerClient();
    const start = state.buy?.date ?? clock.date;
    if ((Date.now() - Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6)}T00:00:00+09:00`)) > 80 * 86400_000) {
      throw new Error("Cycle is too old; manual reconciliation required.");
    }
    const orders = await broker.getPaperDailyOrders(start, clock.date);
    await delay(1100);
    const account = await broker.getAccountSummary();
    const held = account.positions.find((position) => position.symbol === symbol)?.quantity ?? 0;
    const action = planPaperCycle(state, orders, held);
    await report("cycle_checked", { action, symbol, heldQuantity: held, orders });
    if (action === "complete") { state.complete = true; await saveCycle(directory, state); return; }
    if (action !== "buy" && action !== "sell") return;
    if (process.env.PAPER_AUTO_ORDER_ENABLED !== "true" || !testSessionAllowed(process.env.PAPER_TEST_DATE)) {
      await report("orders_disabled_or_session_closed", { action }); return;
    }
    // Paper does not support the holiday endpoint. Require an explicit one-day window AND
    // a recent same-day KRX bar, so stale holiday/closed-market prices cannot enable an order.
    const bar = await broker.getPaperLatestBar(symbol, seoulClock().hour);
    if (!isRecentBar(bar.stck_bsop_date, bar.stck_cntg_hour)) { await report("stale_market_data"); return; }
    await delay(1100);
    const quote = await broker.getQuote(symbol);
    const price = quote.price;
    const exposure = account.positions.reduce((total, position) => total + position.quantity * position.currentPrice, 0);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(exposure)) throw new Error("Invalid price or account value.");
    if (action === "buy") {
      if (account.positions.length || price > 300_000 || price * 1.01 > 1_000_000 || price * 1.01 > account.cash) {
        await report("buy_budget_or_existing_position_block"); return;
      }
      const power = await broker.getPaperBuyingPower(symbol, price);
      if (power.nrcvb_buy_qty < 1 || power.nrcvb_buy_amt < price * 1.01) { await report("insufficient_buying_power"); return; }
    }
    if (!testSessionAllowed(process.env.PAPER_TEST_DATE) || !isRecentBar(bar.stck_bsop_date, bar.stck_cntg_hour)) return;
    // Persist BEFORE crossing the broker boundary. A crash/timeout never permits resubmission.
    state[action] = { date: clock.date, status: "submitting", price };
    await saveCycle(directory, state);
    await report("order_submitting", { side: action, symbol, quantity: 1, limitPrice: price });
    try {
      const result = await broker.placeOrder({ symbol, side: action, type: "limit", quantity: 1, limitPrice: price });
      state[action] = { date: clock.date, status: result.accepted ? "accepted" : "rejected", price, orderId: result.orderId };
      await saveCycle(directory, state);
      await report("order_result", { side: action, accepted: result.accepted, orderId: result.orderId, message: result.message });
    } catch (error) {
      state[action] = { date: clock.date, status: "unknown", price };
      await saveCycle(directory, state);
      await report("order_unknown_manual_check_required", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exitCode = 1;
    }
  });
}

const timeout = setTimeout(() => { console.error("Paper run timed out; check lock and broker orders before recovery."); process.exit(1); }, 90_000);
main().catch((error) => {
  console.error(
    "Paper run blocked or failed:",
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
}).finally(() => clearTimeout(timeout));
