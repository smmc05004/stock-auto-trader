import { executionSnapshot, koreaOrderDate, matchStoredOrder } from "../src/lib/manualPrice/recovery";
import type { PaperDailyOrder } from "../src/lib/broker/paperOrders";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { env } from "../src/lib/config/env";
import { createBrokerClient } from "../src/lib/broker";
import { KisBrokerClient } from "../src/lib/broker/kisBroker";
import { MANUAL_SYMBOL } from "../src/lib/manualPrice/validation";
import { onBuyStatus, onQuote, onSellStatus, type ManualEngineState, type ManualOrder } from "../src/lib/manualPrice/engine";

type Config = { id: string; buy_price_krw: number; sell_price_krw: number; planned_quantity: number; commission_rate: number; status: string };
type Cycle = { id: string; config_id: string; status: string; quantity: number };
type StoredOrder = { id: string; cycle_id: string; side: "buy" | "sell"; limit_price_krw: number; requested_quantity: number; broker_order_id: string | null; status: string; filled_quantity: number; submitted_at: string | null };

const POLL_MS = 2_000;
const CANCEL_AFTER_MS = 5 * 60_000;

function assertPaper() {
  if (env.TRADING_MODE !== "paper" || env.ALLOW_LIVE_TRADING) throw new Error("Manual price runner is paper-only.");
  if (!process.argv.includes("--check") && !env.MANUAL_PRICE_RUNNER_ENABLED) throw new Error("Manual price runner is disabled.");
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) throw new Error("Supabase API environment is not configured.");
}

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

async function getConfig(): Promise<Config | null> {
  const rows = await db(`manual_price_configs?select=id,buy_price_krw,sell_price_krw,planned_quantity,commission_rate,status&account_ref=eq.${encodeURIComponent(env.BROKER_ACCOUNT_NO)}&order=created_at.desc&limit=1`) as Config[];
  return rows[0] ?? null;
}

async function getCycle(configId: string): Promise<Cycle> {
  const rows = await db(`manual_price_cycles?select=id,config_id,status,quantity&account_ref=eq.${encodeURIComponent(env.BROKER_ACCOUNT_NO)}&status=neq.completed&order=started_at.desc&limit=1`) as Cycle[];
  if (rows[0]) {
    if (rows[0].config_id !== configId) throw new Error("Unfinished cycle uses a different configuration");
    return rows[0];
  }
  const rowsCreated = await db("manual_price_cycles", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ account_ref: env.BROKER_ACCOUNT_NO, config_id: configId, status: "waiting_buy", quantity: 0 }) }) as Cycle[];
  if (!rowsCreated[0]) throw new Error("Could not create manual price cycle.");
  return rowsCreated[0];
}

async function getOrder(cycleId: string, side: "buy" | "sell"): Promise<StoredOrder | null> {
  const rows = await db(`manual_price_orders?select=*&cycle_id=eq.${cycleId}&side=eq.${side}&order=updated_at.desc&limit=1`) as StoredOrder[];
  return rows[0] ?? null;
}

async function saveOrder(cycle: Cycle, order: ManualOrder, brokerOrderId: string | null, status: string, filledQuantity = 0) {
  const rows = await db("manual_price_orders", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ cycle_id: cycle.id, client_order_key: `${cycle.id}:${order.side}:${randomUUID()}`, side: order.side, limit_price_krw: order.limitPrice, requested_quantity: order.quantity, broker_order_id: brokerOrderId, status, filled_quantity: filledQuantity, submitted_at: brokerOrderId ? new Date().toISOString() : null }) }) as StoredOrder[];
  if (!rows[0]) throw new Error("Could not persist order intent.");
  return rows[0];
}

async function updateOrder(order: StoredOrder, values: Record<string, unknown>) {
  await db(`manual_price_orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}

async function remoteOrder(broker: { getPaperDailyOrders: (start: string, end: string) => Promise<PaperDailyOrder[]> }, order: StoredOrder) {
  if (!order.submitted_at) throw new Error("Missing order submission date");
  const start = koreaOrderDate(order.submitted_at);
  const end = koreaOrderDate(new Date().toISOString());
  return matchStoredOrder(await broker.getPaperDailyOrders(start, end), order, MANUAL_SYMBOL);
}

async function tick() {
  const config = await getConfig();
  if (!config || config.status === "cancelled") return "no_config";
  const broker = createBrokerClient();
  const cycle = await getCycle(config.id);
  if (["blocked", "needs_reconciliation"].includes(cycle.status)) return cycle.status;
  const state: ManualEngineState = { phase: cycle.status === "buying" ? "buying" : cycle.status === "selling" ? "selling" : "waiting_buy", completedCycles: 0 };
  const buyOrder = await getOrder(cycle.id, "buy");
  const sellOrder = await getOrder(cycle.id, "sell");

  // An intent without a broker id may have crossed the broker boundary before a
  // response was lost. Never submit another order until a manual reconciliation
  // proves that the intent was not accepted.
  if (sellOrder?.status === "rejected" || buyOrder?.status === "rejected") return "order_rejected";
  if (sellOrder && !sellOrder.broker_order_id) return "sell_needs_reconciliation";
  if (buyOrder && !buyOrder.broker_order_id) return "buy_needs_reconciliation";

  const orderBroker = broker as unknown as Parameters<typeof remoteOrder>[0];
  if (sellOrder?.broker_order_id) {
    const remote = await remoteOrder(orderBroker, sellOrder);
    if (!remote) return "sell_reconcile_pending";
    await updateOrder(sellOrder, { ...executionSnapshot(remote, config.commission_rate), status: remote.remainingQuantity === 0 ? (remote.cancelled ? "cancelled" : "filled") : "partially_filled" });
    state.phase = "selling";
    state.sell = { side: "sell", limitPrice: sellOrder.limit_price_krw, quantity: sellOrder.requested_quantity, filledQuantity: sellOrder.filled_quantity };
    const action = onSellStatus(state, remote.filledQuantity, remote.remainingQuantity);
    if (action.type === "wait" && action.reason === "cycle_completed") {
      if (!buyOrder) throw new Error("Completed sell has no recorded buy");
      const buyRemote = await remoteOrder(orderBroker, buyOrder);
      if (!buyRemote || buyRemote.filledQuantity !== remote.filledQuantity) return "completion_needs_reconciliation";
      const buyTotals = executionSnapshot(buyRemote, config.commission_rate);
      const sellTotals = executionSnapshot(remote, config.commission_rate);
      const estimatedPnl = sellTotals.filled_amount_krw - buyTotals.filled_amount_krw - buyTotals.estimated_fee_krw - sellTotals.estimated_fee_krw;
      await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "completed", estimated_pnl_krw: estimatedPnl, quantity: remote.filledQuantity, completed_at: new Date().toISOString() }) });
      return "cycle_completed";
    }
    return action.type === "wait" || action.type === "reconcile" ? action.reason : action.type;
  }

  if (buyOrder?.broker_order_id) {
    const remote = await remoteOrder(orderBroker, buyOrder);
    if (!remote) return "buy_reconcile_pending";
    await updateOrder(buyOrder, { ...executionSnapshot(remote, config.commission_rate), status: remote.remainingQuantity > 0 && ["cancel_pending", "unknown"].includes(buyOrder.status) ? buyOrder.status : remote.remainingQuantity === 0 ? (remote.cancelled ? "cancelled" : "filled") : "partially_filled" });
    state.phase = "buying";
    state.buy = { side: "buy", limitPrice: buyOrder.limit_price_krw, quantity: buyOrder.requested_quantity, filledQuantity: buyOrder.filled_quantity };
    if (remote.remainingQuantity > 0 && buyOrder.status !== "cancel_pending" && buyOrder.status !== "unknown" && buyOrder.submitted_at && Date.now() - Date.parse(buyOrder.submitted_at) > CANCEL_AFTER_MS) {
      const cancellation = await broker.cancelOrder(buyOrder.broker_order_id, remote.remainingQuantity);
      await updateOrder(buyOrder, { status: cancellation.accepted ? "cancel_pending" : "unknown" });
      return cancellation.accepted ? "buy_cancel_pending" : "buy_cancel_unknown";
    }
    const action = onBuyStatus(state, { buyPrice: config.buy_price_krw, sellPrice: config.sell_price_krw, plannedQuantity: config.planned_quantity }, remote.filledQuantity, remote.remainingQuantity);
    if (action.type === "wait" && action.reason === "buy_cancelled_without_fill") {
      await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked", last_error: "Unfilled buy cancelled; reconciliation required before retry" }) });
    }
    if (action.type === "submit_sell") {
      await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "selling", quantity: action.quantity }) });
      const intent = await saveOrder(cycle, { side: "sell", limitPrice: action.price, quantity: action.quantity, filledQuantity: 0 }, null, "intent");
      const result = await broker.placeOrder({ symbol: MANUAL_SYMBOL, side: "sell", type: "limit", quantity: action.quantity, limitPrice: action.price });
      await updateOrder(intent, { broker_order_id: result.accepted ? result.orderId : null, status: result.accepted ? "accepted" : "rejected", submitted_at: result.requestedAt });
      if (!result.accepted) await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked", last_error: result.message }) });
      return result.accepted ? "sell_submitted" : "sell_rejected";
    }
    return action.type === "wait" || action.type === "reconcile" ? action.reason : action.type;
  }

  const quote = await broker.getQuote(MANUAL_SYMBOL);
  const action = onQuote(state, { buyPrice: config.buy_price_krw, sellPrice: config.sell_price_krw, plannedQuantity: config.planned_quantity }, quote);
  if (action.type !== "submit_buy") return action.type === "wait" || action.type === "reconcile" ? action.reason : action.type;
  await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "buying" }) });
  const intent = await saveOrder(cycle, { side: "buy", limitPrice: action.price, quantity: action.quantity, filledQuantity: 0 }, null, "intent");
  const result = await broker.placeOrder({ symbol: MANUAL_SYMBOL, side: "buy", type: "limit", quantity: action.quantity, limitPrice: action.price });
  await updateOrder(intent, { broker_order_id: result.accepted ? result.orderId : null, status: result.accepted ? "accepted" : "rejected", submitted_at: result.requestedAt });
  if (!result.accepted) await db(`manual_price_cycles?id=eq.${cycle.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked", last_error: result.message }) });
  return result.accepted ? "buy_submitted" : "buy_rejected";
}

async function main() {
  assertPaper();
  if (process.argv.includes("--check")) {
    if (env.BROKER_PROVIDER !== "kis") throw new Error("Preflight requires KIS paper broker");
    const config = await getConfig();
    if (!config || config.status === "cancelled") throw new Error("No usable saved configuration");
    // Read column names explicitly so a missing migration fails before trading.
    await db("manual_price_orders?select=id,filled_amount_krw,estimated_fee_krw,costs_confirmed&limit=1");
    await db("manual_price_cycles?select=id,estimated_pnl_krw&limit=1");
    const cycles = await db(`manual_price_cycles?select=id,status&account_ref=eq.${encodeURIComponent(env.BROKER_ACCOUNT_NO)}&status=neq.completed&limit=2`) as Cycle[];
    const broker = new KisBrokerClient();
    const account = await broker.getAccountSummary();
    const today = koreaOrderDate(new Date().toISOString());
    const orders = await broker.getPaperDailyOrders(today, today);
    const held = account.positions.reduce((total, item) => total + item.quantity, 0);
    const open = orders.filter(order => order.remainingQuantity > 0 && !order.cancelled);
    console.log(JSON.stringify({ event: "manual_price_preflight", ordersSubmitted: 0,
      buyPrice: config.buy_price_krw, sellPrice: config.sell_price_krw,
      plannedQuantity: config.planned_quantity, holdings: held,
      todayOpenOrders: open.length, unfinishedCycles: cycles.length,
      flat: held === 0 && open.length === 0,
      note: "Read-only diagnostic; not authorization to trade. Historical unknown orders and market data still require verification." }));
    if (held !== 0 || open.length || cycles.length) process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ event: "manual_price_runner_started", pollMs: POLL_MS }));
  while (true) {
    try { const result = await tick(); if (result !== "no_config") console.log(JSON.stringify({ event: "manual_price_tick", result })); }
    catch (error) { console.error(JSON.stringify({ event: "manual_price_tick_error", message: error instanceof Error ? error.message : String(error) })); }
    await delay(POLL_MS);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
