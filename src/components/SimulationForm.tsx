"use client";

import { FormEvent, useState } from "react";
import type { OrderRequest, TradingDecision } from "@/lib/types/trading";

const defaultStrategyConfig = {
  buyChangeRateThreshold: "1",
  sellChangeRateThreshold: "-1",
  orderQuantity: "1",
  confidence: "0.35",
};

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
  const [executionToken, setExecutionToken] = useState("");
  const [strategyConfig, setStrategyConfig] = useState(defaultStrategyConfig);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<TradingDecision | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmingOrder, setIsConfirmingOrder] = useState(false);

  const requestStrategyConfig = {
    buyChangeRateThreshold: Number(strategyConfig.buyChangeRateThreshold),
    sellChangeRateThreshold: Number(strategyConfig.sellChangeRateThreshold),
    orderQuantity: Number(strategyConfig.orderQuantity),
    confidence: Number(strategyConfig.confidence),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setPendingConfirmation(null);

    try {
      const response = await fetch("/api/trading/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbol,
          executeOrder: false,
          strategyConfig: requestStrategyConfig,
        }),
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

      if (executeOrder && hasExecutableSuggestedOrder(data)) {
        setPendingConfirmation(data);
      }
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmOrder() {
    const orderSymbol = pendingConfirmation?.signal.suggestedOrder?.symbol ?? symbol;
    setIsConfirmingOrder(true);

    try {
      const response = await fetch("/api/trading/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbol: orderSymbol,
          executeOrder: true,
          executionToken,
          strategyConfig: requestStrategyConfig,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setResult({
          ok: false,
          error: data.error ?? "주문 실행에 실패했습니다.",
        });
        return;
      }

      setResult({
        ok: true,
        data,
      });
      setPendingConfirmation(null);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsConfirmingOrder(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="symbol">종목 코드</label>
        <input
          id="symbol"
          value={symbol}
          onChange={(event) => {
            setSymbol(event.target.value);
            setPendingConfirmation(null);
          }}
          placeholder="005930"
        />
      </div>
      <label className="field">
        <span>주문 실행</span>
        <input
          type="checkbox"
          checked={executeOrder}
          onChange={(event) => {
            setExecuteOrder(event.target.checked);
            setPendingConfirmation(null);
          }}
        />
      </label>
      {executeOrder ? (
        <div className="field">
          <label htmlFor="execution-token">실행 토큰</label>
          <input
            id="execution-token"
            value={executionToken}
            onChange={(event) => setExecutionToken(event.target.value)}
            placeholder="ORDER_EXECUTION_TOKEN"
            type="password"
          />
        </div>
      ) : null}
      <fieldset className="strategy-settings">
        <legend>전략 설정</legend>
        <div className="settings-grid">
          <div className="field">
            <label htmlFor="buy-threshold">매수 기준 변동률</label>
            <input
              id="buy-threshold"
              inputMode="decimal"
              value={strategyConfig.buyChangeRateThreshold}
              onChange={(event) => {
                setStrategyConfig((current) => ({
                  ...current,
                  buyChangeRateThreshold: event.target.value,
                }));
                setPendingConfirmation(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="sell-threshold">매도 기준 변동률</label>
            <input
              id="sell-threshold"
              inputMode="decimal"
              value={strategyConfig.sellChangeRateThreshold}
              onChange={(event) => {
                setStrategyConfig((current) => ({
                  ...current,
                  sellChangeRateThreshold: event.target.value,
                }));
                setPendingConfirmation(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="order-quantity">주문 수량</label>
            <input
              id="order-quantity"
              inputMode="numeric"
              value={strategyConfig.orderQuantity}
              onChange={(event) => {
                setStrategyConfig((current) => ({
                  ...current,
                  orderQuantity: event.target.value,
                }));
                setPendingConfirmation(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="strategy-confidence">신뢰도</label>
            <input
              id="strategy-confidence"
              inputMode="decimal"
              value={strategyConfig.confidence}
              onChange={(event) => {
                setStrategyConfig((current) => ({
                  ...current,
                  confidence: event.target.value,
                }));
                setPendingConfirmation(null);
              }}
            />
          </div>
        </div>
      </fieldset>
      <div className="actions">
        <button className="button" disabled={isLoading} type="submit">
          {isLoading ? "실행 중" : executeOrder ? "주문 검토" : "전략 평가"}
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            setSymbol("005930");
            setExecuteOrder(false);
            setExecutionToken("");
            setStrategyConfig(defaultStrategyConfig);
            setResult(null);
            setPendingConfirmation(null);
          }}
        >
          초기화
        </button>
      </div>
      <OrderConfirmation
        decision={pendingConfirmation}
        disabled={isConfirmingOrder}
        onCancel={() => setPendingConfirmation(null)}
        onConfirm={confirmOrder}
      />
      <SimulationResultView result={result} />
    </form>
  );
}

function hasExecutableSuggestedOrder(decision: TradingDecision): decision is TradingDecision & {
  signal: TradingDecision["signal"] & { suggestedOrder: OrderRequest };
} {
  return decision.signal.action !== "hold" && Boolean(decision.signal.suggestedOrder);
}

function formatOrderSide(side: OrderRequest["side"]) {
  return side === "buy" ? "매수" : "매도";
}

function formatOrderType(type: OrderRequest["type"]) {
  return type === "market" ? "시장가" : "지정가";
}

function formatEstimatedOrderValue(order: OrderRequest) {
  if (order.type === "limit" && order.limitPrice) {
    return `${(order.quantity * order.limitPrice).toLocaleString("ko-KR")}원`;
  }

  return "시장가 주문으로 접수 시점 가격 기준";
}

function OrderConfirmation({
  decision,
  disabled,
  onCancel,
  onConfirm,
}: {
  decision: TradingDecision | null;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!decision || !decision.signal.suggestedOrder) {
    return null;
  }

  const order = decision.signal.suggestedOrder;

  return (
    <div className="confirmation-box">
      <div className="confirmation-header">
        <span>주문 확인</span>
        <strong>{formatOrderSide(order.side)} 실행 전 확인</strong>
      </div>
      <dl className="result-meta">
        <div>
          <dt>종목</dt>
          <dd>{order.symbol}</dd>
        </div>
        <div>
          <dt>주문 타입</dt>
          <dd>{formatOrderType(order.type)}</dd>
        </div>
        <div>
          <dt>수량</dt>
          <dd>{order.quantity.toLocaleString("ko-KR")}주</dd>
        </div>
        <div>
          <dt>예상 주문금액</dt>
          <dd>{formatEstimatedOrderValue(order)}</dd>
        </div>
      </dl>
      <p>{decision.signal.reason}</p>
      <div className="actions">
        <button className="button danger" disabled={disabled} type="button" onClick={onConfirm}>
          {disabled ? "주문 실행 중" : "확인 후 주문 실행"}
        </button>
        <button className="button secondary" disabled={disabled} type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
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
