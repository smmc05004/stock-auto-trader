import { NextResponse } from "next/server";
import { createBrokerClient } from "@/lib/broker";

export async function GET() {
  const broker = createBrokerClient();
  const [status, account] = await Promise.all([
    broker.getStatus(),
    broker.getAccountSummary(),
  ]);

  return NextResponse.json({
    status,
    account,
  });
}
