import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { previewManualPrice, MANUAL_SYMBOL, DEFAULT_BUDGET_KRW } from "@/lib/manualPrice/validation";

const inputSchema = z.object({
  buyPrice: z.coerce.number(),
  sellPrice: z.coerce.number(),
  budget: z.coerce.number().default(DEFAULT_BUDGET_KRW),
});

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("manual_price_configs")
      .select("*")
      .eq("account_ref", env.BROKER_ACCOUNT_NO)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ config: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "가격 설정을 조회하지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (env.TRADING_MODE !== "paper" || env.ALLOW_LIVE_TRADING) {
      return NextResponse.json({ error: "수동 가격 기능은 모의투자 모드에서만 사용할 수 있습니다." }, { status: 403 });
    }
    const input = inputSchema.parse(await request.json());
    const preview = previewManualPrice({ buyPrice: input.buyPrice, sellPrice: input.sellPrice, budget: input.budget });
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from("manual_price_configs").insert({
      account_ref: env.BROKER_ACCOUNT_NO,
      mode: "paper",
      symbol: MANUAL_SYMBOL,
      buy_price_krw: input.buyPrice,
      sell_price_krw: input.sellPrice,
      budget_krw: input.budget,
      planned_quantity: preview.quantity,
      buy_fee_krw: preview.buyFee,
      sell_fee_krw: preview.sellFee,
      tax_krw: preview.tax,
      expected_net_profit_krw: preview.netProfit,
      commission_rate: preview.commissionRate,
      status: "pending",
    }).select().single();
    if (error) throw error;
    return NextResponse.json({ config: data, preview }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "가격 입력값이 올바르지 않습니다.", details: error.flatten().fieldErrors }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "가격 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
