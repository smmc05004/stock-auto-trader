import { z } from "zod";

const amount = z.union([z.string().min(1), z.number()]).transform(Number).pipe(z.number().finite().nonnegative());
const count = amount.pipe(z.number().int());
export const dailyOrderSchema = z.object({
  ord_dt: z.string().regex(/^\d{8}$/), odno: z.string().min(1),
  pdno: z.string().regex(/^\d{6}$/), sll_buy_dvsn_cd: z.enum(["01", "02"]),
  ord_qty: count, tot_ccld_qty: count, rmn_qty: count,
  avg_prvs: amount, cncl_yn: z.enum(["Y", "N"]),
  rjct_qty: count,
}).transform((row) => ({
  date: row.ord_dt, orderId: row.odno, symbol: row.pdno,
  side: row.sll_buy_dvsn_cd === "02" ? "buy" as const : "sell" as const,
  quantity: row.ord_qty, filledQuantity: row.tot_ccld_qty,
  remainingQuantity: row.rmn_qty, averagePrice: row.avg_prvs,
  cancelled: row.cncl_yn === "Y", rejectedQuantity: row.rjct_qty,
}));
export type PaperDailyOrder = z.output<typeof dailyOrderSchema>;
export const buyingPowerSchema = z.object({ nrcvb_buy_amt: amount, nrcvb_buy_qty: count });
export const minuteBarSchema = z.object({
  stck_bsop_date: z.string().regex(/^\d{8}$/),
  stck_cntg_hour: z.string().regex(/^\d{6}$/),
  stck_prpr: amount.pipe(z.number().positive()),
  cntg_vol: count,
});
