import { env } from "../src/lib/config/env";
import { createBrokerClient } from "../src/lib/broker";
import { MANUAL_SYMBOL } from "../src/lib/manualPrice/validation";

type Config = { id: string; buy_price_krw: number; sell_price_krw: number; planned_quantity: number; status: string; expires_at: string };

function assertPaper() {
  if (env.TRADING_MODE !== "paper" || env.ALLOW_LIVE_TRADING) throw new Error("Manual price runner is paper-only.");
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

async function main() {
  assertPaper();
  const configs = await db(`manual_price_configs?select=id,buy_price_krw,sell_price_krw,planned_quantity,status,expires_at&account_ref=eq.${encodeURIComponent(env.BROKER_ACCOUNT_NO)}&status=eq.pending&order=created_at.desc&limit=1`) as Config[];
  const config = configs[0];
  if (!config) { console.log(JSON.stringify({ event: "no_pending_manual_price" })); return; }
  if (Date.parse(config.expires_at) <= Date.now()) { await db(`manual_price_configs?id=eq.${config.id}`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) }); console.log(JSON.stringify({ event: "manual_price_expired", id: config.id })); return; }
  const broker = createBrokerClient();
  const account = await broker.getAccountSummary();
  const quote = await broker.getQuote(MANUAL_SYMBOL);
  if (account.positions.some((position) => position.symbol === MANUAL_SYMBOL && position.quantity > 0)) { console.log(JSON.stringify({ event: "position_requires_reconciliation", id: config.id })); return; }
  if (quote.price > config.buy_price_krw) { console.log(JSON.stringify({ event: "waiting_for_buy_price", id: config.id, quote: quote.price })); return; }
  const value = config.buy_price_krw * config.planned_quantity;
  if (value > 1_000_000 || value > account.cash) { console.log(JSON.stringify({ event: "buy_budget_blocked", id: config.id })); return; }
  await db(`manual_price_configs?id=eq.${config.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const result = await broker.placeOrder({ symbol: MANUAL_SYMBOL, side: "buy", type: "limit", quantity: config.planned_quantity, limitPrice: config.buy_price_krw });
  console.log(JSON.stringify({ event: "buy_order_submitted", id: config.id, accepted: result.accepted, orderId: result.orderId }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
