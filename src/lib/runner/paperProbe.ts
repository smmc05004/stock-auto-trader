import type { BrokerClient } from "@/lib/broker/broker";

export function validatePaperProbeEnvironment(settings: Record<string, string | undefined>) {
  if (settings.BROKER_PROVIDER !== "kis" || settings.TRADING_MODE !== "paper") {
    throw new Error("The probe requires BROKER_PROVIDER=kis and TRADING_MODE=paper.");
  }
  if (settings.ALLOW_LIVE_TRADING !== "false" || settings.KIS_BASE_URL) {
    throw new Error("The probe requires ALLOW_LIVE_TRADING=false and no KIS_BASE_URL override.");
  }
  for (const key of ["KIS_PAPER_APP_KEY", "KIS_PAPER_APP_SECRET", "KIS_PAPER_ACCOUNT_NO"]) {
    if (!settings[key]?.trim()) {
      throw new Error(`Missing required paper setting: ${key}`);
    }
  }
  const symbol = settings.PAPER_SYMBOL ?? "005930";
  if (!/^\d{6}$/.test(symbol)) {
    throw new Error("PAPER_SYMBOL must be a six-digit Korean symbol.");
  }
  return symbol;
}

// Deliberately accepts only read methods: initial deployment cannot place orders.
export async function probePaperBroker(
  broker: Pick<BrokerClient, "getAccountSummary" | "getQuote">,
  symbol: string,
) {
  // Sequential calls avoid concurrent token issuance on a cold start.
  const account = await broker.getAccountSummary();
  const quote = await broker.getQuote(symbol);
  if (!Number.isFinite(account.cash) || !Number.isFinite(quote.price) || quote.price <= 0) {
    throw new Error("The broker returned invalid cash or price data.");
  }
  if (quote.symbol !== symbol) {
    throw new Error("The broker returned a different symbol.");
  }
  return {
    mode: "paper",
    ordersEnabled: false,
    cash: account.cash,
    positionCount: account.positions.length,
    symbol,
    price: quote.price,
    checkedAt: new Date().toISOString(),
  };
}
