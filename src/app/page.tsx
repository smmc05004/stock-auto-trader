import { createBrokerClient } from "@/lib/broker";
import type { BrokerClient } from "@/lib/broker/broker";
import { TradingDashboard } from "@/components/TradingDashboard";
import type { AccountSummary } from "@/lib/types/trading";

type AccountLoadResult = {
  account: AccountSummary;
  accountError?: string;
};

function createUnavailableAccount(): AccountSummary {
  return {
    accountNo: "UNAVAILABLE",
    cash: 0,
    currency: "KRW",
    totalMarketValue: 0,
    positions: [],
  };
}

async function loadAccountSummarySafely(broker: BrokerClient): Promise<AccountLoadResult> {
  try {
    return {
      account: await broker.getAccountSummary(),
    };
  } catch (error) {
    return {
      account: createUnavailableAccount(),
      accountError: error instanceof Error ? error.message : "Failed to load account summary.",
    };
  }
}

export default async function Home() {
  const broker = createBrokerClient();
  const [status, accountResult] = await Promise.all([
    broker.getStatus(),
    loadAccountSummarySafely(broker),
  ]);
  const statusWithAccountError = accountResult.accountError
    ? {
        ...status,
        connected: false,
        message: `${status.message} Account summary failed: ${accountResult.accountError}`,
      }
    : status;

  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <h1>Stock Auto Trader</h1>
            <p>증권사 연동과 전략 구현 전 단계의 자동매매 기본 구조</p>
          </div>
          <div className="status-pill">
            <span className="status-dot" />
            {statusWithAccountError.provider.toUpperCase()} · {statusWithAccountError.mode.toUpperCase()}
          </div>
        </header>

        <TradingDashboard account={accountResult.account} status={statusWithAccountError} />
      </div>
    </main>
  );
}
