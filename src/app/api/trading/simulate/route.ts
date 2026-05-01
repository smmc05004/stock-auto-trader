import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBrokerClient } from "@/lib/broker";
import { runStrategy } from "@/lib/engine/tradingEngine";
import { sampleMomentumStrategy } from "@/lib/strategy/sampleStrategy";

const requestSchema = z.object({
  symbol: z.string().min(1).default("005930"),
  executeOrder: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const input = requestSchema.parse(body);
  const broker = createBrokerClient();

  const decision = await runStrategy({
    broker,
    strategy: sampleMomentumStrategy,
    symbol: input.symbol,
    executeOrder: input.executeOrder,
  });

  return NextResponse.json(decision);
}
