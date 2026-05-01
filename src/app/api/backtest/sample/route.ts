import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runBacktest, type HistoricalPrice } from "@/lib/backtest/backtest";
import { loadMomentumStrategyConfig } from "@/lib/strategy/config";
import { createSampleMomentumStrategy } from "@/lib/strategy/samples/momentumStrategy";

const requestSchema = z.object({
  initialCash: z.coerce.number().positive().default(1_000_000),
  feeRate: z.coerce.number().min(0).max(0.1).default(0.00015),
});

const samplePrices: HistoricalPrice[] = [
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 72_000,
    changeRate: 1.1,
    currency: "KRW",
    timestamp: "2026-04-20T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 73_500,
    changeRate: 0.6,
    currency: "KRW",
    timestamp: "2026-04-21T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 74_200,
    changeRate: 0.3,
    currency: "KRW",
    timestamp: "2026-04-22T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 71_900,
    changeRate: -1.3,
    currency: "KRW",
    timestamp: "2026-04-23T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 72_400,
    changeRate: 0.7,
    currency: "KRW",
    timestamp: "2026-04-24T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 73_300,
    changeRate: 1.2,
    currency: "KRW",
    timestamp: "2026-04-27T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 75_100,
    changeRate: 0.5,
    currency: "KRW",
    timestamp: "2026-04-28T00:00:00.000Z",
  },
  {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    close: 73_000,
    changeRate: -1.4,
    currency: "KRW",
    timestamp: "2026-04-29T00:00:00.000Z",
  },
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const strategy = createSampleMomentumStrategy(loadMomentumStrategyConfig());
    const result = await runBacktest({
      strategy,
      prices: samplePrices,
      initialCash: input.initialCash,
      feeRate: input.feeRate,
    });

    return NextResponse.json({
      ...result,
      dataPoints: samplePrices.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Invalid backtest request.",
          details: error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to run backtest.",
      },
      { status: 500 },
    );
  }
}
