"use client";

import { useEffect, useState } from "react";
import { DEFAULT_BUDGET_KRW, previewManualPrice, type ManualPricePreview } from "@/lib/manualPrice/validation";

const currency = new Intl.NumberFormat("ko-KR");
const won = (value: number) => `${currency.format(value)}원`;

export function ManualPricePanel() {
  const [buyPrice, setBuyPrice] = useState(0);
  const [sellPrice, setSellPrice] = useState(0);
  const [budget, setBudget] = useState(DEFAULT_BUDGET_KRW);
  const [preview, setPreview] = useState<ManualPricePreview | null>(null);
  const [message, setMessage] = useState("가격을 입력하면 비용을 먼저 검증합니다.");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<{ buy: number; sell: number; budget: number; version: number; createdAt: string } | null>(null);

  useEffect(() => {
    if (!buyPrice || !sellPrice || !budget) { setPreview(null); return; }
    try { setPreview(previewManualPrice({ buyPrice, sellPrice, budget })); setMessage("적용 가능한 가격입니다."); }
    catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : "가격을 확인할 수 없습니다."); }
  }, [buyPrice, sellPrice, budget]);

  useEffect(() => {
    let active = true;
    fetch("/api/manual-price", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) throw new Error(body.error ?? "저장된 설정을 조회하지 못했습니다.");
      const config = body.config;
      if (config) {
        setBuyPrice(config.buy_price_krw);
        setSellPrice(config.sell_price_krw);
        setBudget(config.budget_krw);
        setSaved({ buy: config.buy_price_krw, sell: config.sell_price_krw, budget: config.budget_krw, version: config.version, createdAt: config.created_at });
        setMessage("저장된 가격을 불러왔습니다.");
      }
    }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "저장된 설정을 조회하지 못했습니다."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function apply() {
    if (!preview || saving) return;
    setSaving(true); setMessage("저장 중입니다.");
    try {
      const response = await fetch("/api/manual-price", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyPrice, sellPrice, budget }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "저장에 실패했습니다.");
      setSaved({ buy: body.config.buy_price_krw, sell: body.config.sell_price_krw, budget: body.config.budget_krw, version: body.config.version, createdAt: body.config.created_at });
      setMessage(`적용 요청이 저장되었습니다. ${body.config?.version ? `버전 ${body.config.version}` : "실행기 확인 대기"}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "저장에 실패했습니다."); }
    finally { setSaving(false); }
  }

  return <div className="manual-price-panel">
    <div className="manual-price-saved"><strong>현재 저장된 설정</strong>{loading ? <span>조회 중…</span> : saved ? <span>매수 {won(saved.buy)} · 매도 {won(saved.sell)} · 예산 {won(saved.budget)} · 버전 {saved.version}</span> : <span>아직 저장된 설정이 없습니다.</span>}</div>
    <div className="manual-price-fields">
      <div className="field"><label htmlFor="manual-buy">매수 지정가 (원)</label><input id="manual-buy" type="number" min="1" step="5" value={buyPrice || ""} onChange={(e) => setBuyPrice(Number(e.target.value))} /></div>
      <div className="field"><label htmlFor="manual-sell">매도 지정가 (원)</label><input id="manual-sell" type="number" min="1" step="5" value={sellPrice || ""} onChange={(e) => setSellPrice(Number(e.target.value))} /></div>
      <div className="field"><label htmlFor="manual-budget">회차 예산 (원)</label><input id="manual-budget" type="number" min="1" max={DEFAULT_BUDGET_KRW} step="1000" value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></div>
    </div>
    <div className="manual-price-summary"><strong>비용 검증</strong>{preview ? <div className="metric-grid"><div className="metric"><span>예상 수량</span><strong>{preview.quantity}주</strong></div><div className="metric"><span>예상 비용</span><strong>{won(preview.buyFee + preview.sellFee)}</strong></div><div className="metric"><span>예상 순이익</span><strong className="profit">{won(preview.netProfit)}</strong></div></div> : <p>{message}</p>}</div>
    <button className="primary-button" type="button" disabled={!preview || saving} onClick={apply}>{saving ? "저장 중…" : "적용"}</button>
    <p className={message.includes("적용") || message.includes("저장") ? "notice" : "error-notice"}>{message}</p>
    <small className="muted">대상: KODEX 코스닥150 (229200) · 모의투자 · 수수료율 0.0146527% 기준</small>
  </div>;
}
