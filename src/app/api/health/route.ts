import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "stock-auto-trader",
    timestamp: new Date().toISOString(),
  });
}
