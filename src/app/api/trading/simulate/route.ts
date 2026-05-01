import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBrokerClient } from "@/lib/broker";
import { runStrategy } from "@/lib/engine/tradingEngine";
import { loadMomentumStrategyConfig } from "@/lib/strategy/config";
import { createSampleMomentumStrategy } from "@/lib/strategy/samples/momentumStrategy";

const requestSchema = z.object({
  symbol: z.string().min(1).default("005930"),
  executeOrder: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const broker = createBrokerClient();
    const strategy = createSampleMomentumStrategy(loadMomentumStrategyConfig());

    const decision = await runStrategy({
      broker,
      strategy,
      symbol: input.symbol,
      executeOrder: input.executeOrder,
    });

    return NextResponse.json(decision);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Invalid simulation request.",
          details: error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to run trading simulation.",
      },
      { status: 500 },
    );
  }
}
