import { z } from "zod";
import type { PaperDailyOrder } from "../broker/paperOrders";

const attemptSchema = z.object({
  date: z.string().regex(/^\d{8}$/),
  status: z.enum(["submitting", "accepted", "rejected", "unknown"]),
  orderId: z.string().optional(),
  price: z.number().finite().positive(),
});
export const cycleSchema = z.object({
  version: z.literal(1), accountHash: z.string(), symbol: z.string().regex(/^\d{6}$/),
  buy: attemptSchema.optional(), sell: attemptSchema.optional(), complete: z.boolean(),
});
export type PaperCycle = z.infer<typeof cycleSchema>;

export function seoulClock(now = new Date()) {
  const local = new Date(now.getTime() + 9 * 3600_000);
  return {
    date: local.toISOString().slice(0, 10).replaceAll("-", ""),
    hour: local.toISOString().slice(11, 19).replaceAll(":", ""),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

export function testSessionAllowed(testDate: string | undefined, now = new Date()) {
  const clock = seoulClock(now);
  return testDate?.replaceAll("-", "") === clock.date && clock.weekday > 0 && clock.weekday < 6
    && clock.minute >= 10 * 60 + 30 && clock.minute < 15 * 60 + 10;
}

export function isRecentBar(date: string, hour: string, now = new Date()) {
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(hour)) return false;
  const stamp = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${hour.slice(0, 2)}:${hour.slice(2, 4)}:${hour.slice(4)}+09:00`);
  const age = now.getTime() - stamp;
  return date === seoulClock(now).date && Number.isFinite(age) && age >= 0 && age <= 180_000;
}

export function planPaperCycle(state: PaperCycle, orders: PaperDailyOrder[], heldQuantity: number) {
  if (state.complete) return "complete";
  const find = (side: "buy" | "sell") => {
    const attempt = state[side];
    return orders.find((order) => order.date === attempt?.date && order.symbol === state.symbol
      && order.side === side && (attempt.orderId === order.orderId || attempt.orderId?.endsWith(`-${order.orderId}`)));
  };
  if (!state.buy) return heldQuantity === 0 && orders.length === 0 ? "buy" : "blocked_existing_activity";
  for (const side of ["buy", "sell"] as const) {
    const attempt = state[side];
    if (!attempt) continue;
    if (attempt.status !== "accepted" || !attempt.orderId) return "blocked_unconfirmed_submission";
    const order = find(side);
    if (!order) return "awaiting_broker_order";
    if (order.quantity !== 1 || order.cancelled || order.rejectedQuantity > 0) return "blocked_order_changed";
    if (order.filledQuantity !== 1 || order.remainingQuantity !== 0) return "awaiting_fill";
  }
  // No manual/other-bot activity may be mixed into this isolated one-cycle test.
  if (orders.some((order) => order !== find("buy") && order !== find("sell"))) return "blocked_existing_activity";
  if (state.sell) return heldQuantity === 0 ? "complete" : "awaiting_balance";
  return heldQuantity === 1 ? "sell" : "awaiting_balance";
}
