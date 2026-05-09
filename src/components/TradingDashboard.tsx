"use client";

import { useState } from "react";
import { BacktestPanel } from "@/components/BacktestPanel";
import { SimulationForm } from "@/components/SimulationForm";
import type { BrokerStatus } from "@/lib/broker/broker";
import type { AccountSummary } from "@/lib/types/trading";

type DashboardTab = "account" | "strategy" | "backtest";

type TradingDashboardProps = {
  account: AccountSummary;
  status: BrokerStatus;
};

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function TradingDashboard({ account, status }: TradingDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("account");

  return (
    <section className="dashboard">
      <nav className="tabs" aria-label="Dashboard views">
        <button
          aria-pressed={activeTab === "account"}
          className="tab-button"
          onClick={() => setActiveTab("account")}
          type="button"
        >
          계좌
        </button>
        <button
          aria-pressed={activeTab === "strategy"}
          className="tab-button"
          onClick={() => setActiveTab("strategy")}
          type="button"
        >
          전략
        </button>
        <button
          aria-pressed={activeTab === "backtest"}
          className="tab-button"
          onClick={() => setActiveTab("backtest")}
          type="button"
        >
          백테스트
        </button>
      </nav>

      {activeTab === "account" ? <AccountView account={account} status={status} /> : null}
      {activeTab === "strategy" ? <StrategyView /> : null}
      {activeTab === "backtest" ? <BacktestView /> : null}
    </section>
  );
}

function AccountView({ account, status }: TradingDashboardProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>계좌 요약</h2>
        <span>{account.accountNo}</span>
      </div>
      <div className="panel-body">
        <div className="metric-grid">
          <div className="metric">
            <span>브로커</span>
            <strong>{status.provider.toUpperCase()}</strong>
          </div>
          <div className="metric">
            <span>모드</span>
            <strong>{status.mode.toUpperCase()}</strong>
          </div>
          <div className="metric">
            <span>연결</span>
            <strong>{status.connected ? "정상" : "확인 필요"}</strong>
          </div>
          <div className="metric">
            <span>예수금</span>
            <strong>{formatCurrency(account.cash, account.currency)}</strong>
          </div>
          <div className="metric">
            <span>평가 금액</span>
            <strong>{formatCurrency(account.totalMarketValue, account.currency)}</strong>
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
            {account.positions.length > 0 ? (
              account.positions.map((position) => (
                <tr key={position.symbol}>
                  <td>
                    {position.name} ({position.symbol})
                  </td>
                  <td>{position.quantity}</td>
                  <td>{formatCurrency(position.averagePrice, position.currency)}</td>
                  <td>{formatCurrency(position.currentPrice, position.currency)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>보유 종목이 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="notice">{status.message}</div>
      </div>
    </div>
  );
}

function StrategyView() {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>전략 시뮬레이션</h2>
        <span>sample-momentum</span>
      </div>
      <div className="panel-body">
        <SimulationForm />
      </div>
    </div>
  );
}

function BacktestView() {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>샘플 백테스트</h2>
        <span>005930</span>
      </div>
      <div className="panel-body">
        <BacktestPanel />
      </div>
    </div>
  );
}
