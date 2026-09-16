import { RangeStore } from "../src/lib/range/store";
import { RangeBroker } from "../src/lib/range/broker";
import { linkedCancellation, type State, type LocalOrder } from "../src/lib/range/engine";
import { korea } from "../src/lib/range/strategy";

// Explicit operator repair only; run with the normal runner stopped. Never submits orders.
async function main() {
  const store = new RangeStore(process.env.RANGE_DB_PATH ?? "/app/data/range.sqlite");
  store.claim();
  const heartbeat = setInterval(() => store.heartbeat(), 10_000);
  try {
    const state = store.get<State>("state")!;
    if (state.halted !== "preflight_failed_check_orders" || state.preflight?.status !== "failed" || state.preflight.pnl !== 0 || state.quantity !== 0 || state.active || state.orders.length) throw new Error("Not an eligible flat preflight failure");
    const events = store.db.prepare("SELECT kind,payload FROM events WHERE at>=? AND at<=? ORDER BY id").all(state.preflight.at, state.lastEnd + 60_000);
    const intents = events.filter(e => e.kind === "order_intent").map(e => JSON.parse(String(e.payload)) as LocalOrder);
    if (intents.length !== 1 || intents[0].side !== "buy" || intents[0].qty !== 1) throw new Error("Ambiguous diagnostic order history");
    const order = intents[0];
    const accepted = events.filter(e => e.kind === "order_accepted").map(e => JSON.parse(String(e.payload))).filter(e => e.key === order.key);
    const cancels = events.filter(e => e.kind === "cancel_intent").map(e => JSON.parse(String(e.payload))).filter(e => e.key === order.key);
    if (accepted.length !== 1 || cancels.length !== 1) throw new Error("Missing order/cancel provenance");
    Object.assign(order, accepted[0], { cancelAt: state.preflight.at, cancelId: state.preflight.cancelOrderId });
    const broker = new RangeBroker();
    const rows = await broker.orders(korea(order.at).date, korea(Date.now()).date);
    const original = rows.find(r => r.id === order.id && r.date === korea(order.at).date.replaceAll("-", ""));
    if (!original || original.filled !== 0 || !linkedCancellation(order, original, rows)) throw new Error("Broker cancellation proof incomplete");
    if (rows.some(r => r.remaining > 0 && !r.cancelled && r.rejected < r.qty) || (await broker.positions()).length) throw new Error("Account is not flat");
    store.assertOwner();
    store.db.prepare("VACUUM INTO ?").run(`${store.file}.before-preflight-repair-${Date.now()}.bak`);
    const before = structuredClone(state);
    state.preflight.status = "passed";
    state.halted = undefined;
    state.safeToStop = true;
    state.lastSync = Date.now();
    // Keep session/risk exits and all other state intact.
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.event("preflight_repaired", { before, original, cancellation: rows.find(r => r.id === order.cancelId), reason: "linked_cancel_record_verified", ordersSubmitted: 0 });
      store.save("state", state); store.db.exec("COMMIT");
    } catch (e) { store.db.exec("ROLLBACK"); throw e; }
    console.log(JSON.stringify({ status: "passed", order: order.id, cancellation: order.cancelId, quantity: 0, ordersSubmitted: 0 }));
  } finally { clearInterval(heartbeat); store.close(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Repair failed"); process.exitCode = 1; });
