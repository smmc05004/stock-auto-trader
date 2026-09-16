import { validatePaperProbeEnvironment } from "../src/lib/runner/paperProbe";
import { seoulClock } from "../src/lib/runner/paperCycle";
import { setTimeout as delay } from "node:timers/promises";

const timer = setTimeout(() => process.exit(1), 60_000);
async function main() {
  const symbol = validatePaperProbeEnvironment(process.env);
  const { KisBrokerClient } = await import("../src/lib/broker/kisBroker");
  const broker = new KisBrokerClient();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
  const orders = await broker.getPaperDailyOrders(today, today);
  console.log(JSON.stringify({ event: "paper_orders", date: today, orders }));
  await delay(1100);
  const quote = await broker.getQuote(symbol);
  const power = await broker.getPaperBuyingPower(symbol, quote.price);
  console.log(JSON.stringify({ event: "paper_buying_power", symbol, price: quote.price, ...power }));
  try {
    console.log(JSON.stringify({ event: "paper_latest_bar", bar: await broker.getPaperLatestBar(symbol, seoulClock().hour) }));
  } catch (error) {
    console.log(JSON.stringify({ event: "paper_bar_unavailable", message: error instanceof Error ? error.message : "unknown" }));
  }
}
main().catch(() => { console.error("Paper status query failed."); process.exitCode = 1; }).finally(() => clearTimeout(timer));
