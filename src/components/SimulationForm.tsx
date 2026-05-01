"use client";

import { FormEvent, useState } from "react";

export function SimulationForm() {
  const [symbol, setSymbol] = useState("005930");
  const [executeOrder, setExecuteOrder] = useState(false);
  const [result, setResult] = useState<string>("아직 실행된 시뮬레이션이 없습니다.");
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
      setResult(JSON.stringify(data, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Unknown error");
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
            setResult("아직 실행된 시뮬레이션이 없습니다.");
          }}
        >
          초기화
        </button>
      </div>
      <pre className="code">{result}</pre>
    </form>
  );
}
