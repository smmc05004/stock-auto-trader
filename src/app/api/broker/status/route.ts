import { NextResponse } from "next/server";
import { createBrokerClient } from "@/lib/broker";

export async function GET() {
  const broker = createBrokerClient();
  const status = await broker.getStatus();
  const account = await broker.getAccountSummary().catch((error) => ({
    accountNo: "",
    cash: 0,
    currency: "KRW",
    totalMarketValue: 0,
    positions: [],
    error: error instanceof Error ? error.message : "Failed to load account summary.",
  }));

  return NextResponse.json({
    status,
    account,
  });
}
