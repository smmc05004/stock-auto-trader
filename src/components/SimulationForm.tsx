"use client";

import { FormEvent, useState } from "react";
import type { TradingDecision } from "@/lib/types/trading";

type SimulationResult =
  | {
      ok: true;
      data: TradingDecision;
    }
  | {
      ok: false;
      error: string;
    };

export function SimulationForm() {
  const [symbol, setSymbol] = useState("005930");
  const [executeOrder, setExecuteOrder] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);

    try {
      const response = await fetch("/api/trading/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ symbol, executeOrder }),
      });
      const data = await response.json();

      if (!response.ok) {
        setResult({
          ok: false,
          error: data.error ?? "전략 평가에 실패했습니다.",
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
        <label htmlFor="symbol">종목 코드</label>
        <input
          id="symbol"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="005930"
        />
      </div>
      <label className="field">
        <span>주문 실행</span>
        <input
          type="checkbox"
          checked={executeOrder}
          onChange={(event) => setExecuteOrder(event.target.checked)}
        />
      </label>
      <div className="actions">
        <button className="button" disabled={isLoading} type="submit">
          {isLoading ? "실행 중" : "전략 평가"}
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            setSymbol("005930");
            setExecuteOrder(false);
            setResult(null);
          }}
        >
          초기화
        </button>
      </div>
      <SimulationResultView result={result} />
    </form>
  );
}

function SimulationResultView({ result }: { result: SimulationResult | null }) {
  if (!result) {
    return <div className="empty-state">아직 실행된 시뮬레이션이 없습니다.</div>;
  }

  if (!result.ok) {
    return (
      <div className="result-box danger">
        <strong>실행 실패</strong>
        <p>{result.error}</p>
      </div>
    );
  }

  const { signal, safetyCheck, order } = result.data;
  const statusClass = signal.action === "hold" ? "neutral" : signal.action;

  return (
    <div className="result-stack">
      <div className={`result-box ${statusClass}`}>
        <span>전략 판단</span>
        <strong>{signal.action.toUpperCase()}</strong>
        <p>{signal.reason}</p>
        <dl className="result-meta">
          <div>
            <dt>종목</dt>
            <dd>{signal.symbol}</dd>
          </div>
          <div>
            <dt>신뢰도</dt>
            <dd>{Math.round(signal.confidence * 100)}%</dd>
          </div>
        </dl>
      </div>

      {safetyCheck ? (
        <div className={`result-box ${safetyCheck.allowed ? "success" : "warning"}`}>
          <span>주문 안전장치</span>
          <strong>{safetyCheck.allowed ? "통과" : "차단"}</strong>
          <dl className="result-meta">
            <div>
              <dt>예상 주문금액</dt>
              <dd>{safetyCheck.estimatedOrderValue.toLocaleString("ko-KR")}원</dd>
            </div>
            <div>
              <dt>최대 주문금액</dt>
              <dd>{safetyCheck.maxOrderValue.toLocaleString("ko-KR")}원</dd>
            </div>
          </dl>
          {safetyCheck.reasons.length > 0 ? (
            <ul className="reason-list">
              {safetyCheck.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {order ? (
        <div className={`result-box ${order.accepted ? "success" : "danger"}`}>
          <span>주문 결과</span>
          <strong>{order.accepted ? "접수" : "거절"}</strong>
          <p>{order.message}</p>
          <dl className="result-meta">
            <div>
              <dt>주문 ID</dt>
              <dd>{order.orderId}</dd>
            </div>
            <div>
              <dt>모드</dt>
              <dd>{order.mode.toUpperCase()}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
