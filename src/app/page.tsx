import { createBrokerClient } from "@/lib/broker";
import { BacktestPanel } from "@/components/BacktestPanel";
import { SimulationForm } from "@/components/SimulationForm";

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function Home() {
  const broker = createBrokerClient();
  const [status, account] = await Promise.all([
    broker.getStatus(),
    broker.getAccountSummary(),
  ]);

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
            {status.provider.toUpperCase()} · {status.mode.toUpperCase()}
          </div>
        </header>

        <section className="grid">
          <div className="panel">
            <div className="panel-header">
              <h2>계좌 요약</h2>
              <span>{account.accountNo}</span>
            </div>
            <div className="panel-body">
              <div className="metric-grid">
                <div className="metric">
                  <span>예수금</span>
                  <strong>{formatCurrency(account.cash, account.currency)}</strong>
                </div>
                <div className="metric">
                  <span>평가 금액</span>
                  <strong>
                    {formatCurrency(account.totalMarketValue, account.currency)}
                  </strong>
                </div>
                <div className="metric">
                  <span>보유 종목</span>
                  <strong>{account.positions.length}</strong>
                </div>
              </div>

              <table className="table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>수량</th>
                    <th>평단</th>
                    <th>현재가</th>
                  </tr>
                </thead>
                <tbody>
                  {account.positions.map((position) => (
                    <tr key={position.symbol}>
                      <td>
                        {position.name} ({position.symbol})
                      </td>
                      <td>{position.quantity}</td>
                      <td>
                        {formatCurrency(position.averagePrice, position.currency)}
                      </td>
                      <td>
                        {formatCurrency(position.currentPrice, position.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="notice">
                현재 주문은 mock 브로커로 처리됩니다. 실제 증권사 API 키를 넣기 전까지
                실거래 주문은 발생하지 않습니다.
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>전략 시뮬레이션</h2>
            </div>
            <div className="panel-body">
              <SimulationForm />
            </div>
          </div>
        </section>

        <section className="section">
          <div className="panel">
            <div className="panel-header">
              <h2>샘플 백테스트</h2>
              <span>005930</span>
            </div>
            <div className="panel-body">
              <BacktestPanel />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
