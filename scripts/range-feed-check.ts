import { RangeBroker } from "../src/lib/range/broker";
async function main() {
  const broker = new RangeBroker();
  let quotes = 0, trades = 0;
  const acknowledgements: Record<string, boolean> = {};
  const ws = await broker.connect(() => quotes++, () => trades++, () => undefined,
    (tr, ok, code) => { acknowledgements[tr] = ok; console.log(JSON.stringify({ event: "subscription_ack", tr, ok, code })); });
  await new Promise(r => setTimeout(r, 15_000));
  ws.close();
  const accepted = acknowledgements.H0STASP0 === true && acknowledgements.H0STCNT0 === true;
  console.log(JSON.stringify({ event: "feed_check", accepted, quotes, trades, freshMarketVerified: quotes > 0 && trades > 0, ordersSubmitted: 0 }));
  if (!accepted) process.exitCode = 1;
}
const timeout = setTimeout(() => process.exit(1), 35_000);
main().catch(() => { console.error("Feed check failed; no orders submitted"); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
