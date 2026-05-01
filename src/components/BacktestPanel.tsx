"use client";

import { FormEvent, useState } from "react";
import type { BacktestResult } from "@/lib/backtest/backtest";

type BacktestResponse = BacktestResult & {
  dataPoints: number;
};

type BacktestState =
  | {
      ok: true;
      data: BacktestResponse;
    }
  | {
      ok: false;
      error: string;
    };

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

export function BacktestPanel() {
  const [initialCash, setInitialCash] = useState("1000000");
  const [feeRate, setFeeRate] = useState("0.00015");
  const [result, setResult] = useState<BacktestState | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);

    try {
      const response = await fetch("/api/backtest/sample", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          initialCash: Number(initialCash),
          feeRate: Number(feeRate),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setResult({
          ok: false,
          error: data.error ?? "백테스트 실행에 실패했습니다.",
        });
        return;
      }

      setResult({
        ok: true,
        data,
      });
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="initialCash">초기 현금</label>
        <input
          id="initialCash"
          inputMode="numeric"
          value={initialCash}
          onChange={(event) => setInitialCash(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="feeRate">수수료율</label>
        <input
          id="feeRate"
          inputMode="decimal"
          value={feeRate}
          onChange={(event) => setFeeRate(event.target.value)}
        />
      </div>
      <div className="actions">
        <button className="button" disabled={isLoading} type="submit">
          {isLoading ? "실행 중" : "백테스트 실행"}
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            setInitialCash("1000000");
            setFeeRate("0.00015");
            setResult(null);
          }}
        >
          초기화
        </button>
      </div>
      <BacktestResultView result={result} />
    </form>
  );
}

function BacktestResultView({ result }: { result: BacktestState | null }) {
  if (!result) {
    return <div className="empty-state">아직 실행된 백테스트가 없습니다.</div>;
  }

  if (!result.ok) {
    return (
      <div className="result-box danger">
        <strong>실행 실패</strong>
        <p>{result.error}</p>
      </div>
    );
  }

  const { data } = result;

  return (
    <div className="result-stack">
      <div className={data.returnRate >= 0 ? "result-box success" : "result-box danger"}>
        <span>백테스트 요약</span>
        <strong>{formatPercent(data.returnRate)}</strong>
        <dl className="result-meta">
          <div>
            <dt>초기 현금</dt>
            <dd>{formatCurrency(data.initialCash)}</dd>
          </div>
          <div>
            <dt>최종 평가금</dt>
            <dd>{formatCurrency(data.finalEquity)}</dd>
          </div>
          <div>
            <dt>최대 낙폭</dt>
            <dd>{formatPercent(data.maxDrawdown)}</dd>
          </div>
          <div>
            <dt>승률</dt>
            <dd>{formatPercent(data.winRate)}</dd>
          </div>
          <div>
            <dt>거래 횟수</dt>
            <dd>{data.tradeCount}</dd>
          </div>
          <div>
            <dt>데이터 수</dt>
            <dd>{data.dataPoints}</dd>
          </div>
        </dl>
      </div>

      <div className="result-box neutral">
        <span>최근 거래</span>
        {data.trades.length > 0 ? (
          <table className="compact-table">
            <thead>
              <tr>
                <th>일시</th>
                <th>구분</th>
                <th>수량</th>
                <th>가격</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.slice(-4).map((trade) => (
                <tr key={`${trade.timestamp}-${trade.side}-${trade.price}`}>
                  <td>{trade.timestamp.slice(0, 10)}</td>
                  <td>{trade.side.toUpperCase()}</td>
                  <td>{trade.quantity}</td>
                  <td>{formatCurrency(trade.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>체결된 거래가 없습니다.</p>
        )}
      </div>
    </div>
  );
}
