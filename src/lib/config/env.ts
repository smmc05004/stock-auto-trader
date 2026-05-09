import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  BROKER_PROVIDER: z.enum(["mock", "kis"]).default("mock"),
  BROKER_APP_KEY: optionalString,
  BROKER_APP_SECRET: optionalString,
  BROKER_ACCOUNT_NO: z.string().default("PAPER-ACCOUNT"),
  KIS_ACCOUNT_PRODUCT_CODE: z.string().default("01"),
  KIS_PAPER_APP_KEY: optionalString,
  KIS_PAPER_APP_SECRET: optionalString,
  KIS_PAPER_ACCOUNT_NO: optionalString,
  KIS_PAPER_ACCOUNT_PRODUCT_CODE: optionalString,
  KIS_LIVE_APP_KEY: optionalString,
  KIS_LIVE_APP_SECRET: optionalString,
  KIS_LIVE_ACCOUNT_NO: optionalString,
  KIS_LIVE_ACCOUNT_PRODUCT_CODE: optionalString,
  KIS_BASE_URL: optionalUrl,
  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  TRADING_MARKET: z.enum(["KR", "US"]).default("KR"),
  TRADING_BASE_CURRENCY: z.string().default("KRW"),
  MAX_ORDER_VALUE: z.coerce.number().positive().default(1_000_000),
  MAX_ORDER_QUANTITY: z.coerce.number().int().positive().default(10),
  DUPLICATE_ORDER_WINDOW_MS: z.coerce.number().int().nonnegative().default(60_000),
  ORDER_EXECUTION_TOKEN: optionalString,
  ALLOW_LIVE_TRADING: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const env = envSchema.parse({
  BROKER_PROVIDER: process.env.BROKER_PROVIDER,
  BROKER_APP_KEY: process.env.BROKER_APP_KEY,
  BROKER_APP_SECRET: process.env.BROKER_APP_SECRET,
  BROKER_ACCOUNT_NO: process.env.BROKER_ACCOUNT_NO,
  KIS_ACCOUNT_PRODUCT_CODE: process.env.KIS_ACCOUNT_PRODUCT_CODE,
  KIS_PAPER_APP_KEY: process.env.KIS_PAPER_APP_KEY,
  KIS_PAPER_APP_SECRET: process.env.KIS_PAPER_APP_SECRET,
  KIS_PAPER_ACCOUNT_NO: process.env.KIS_PAPER_ACCOUNT_NO,
  KIS_PAPER_ACCOUNT_PRODUCT_CODE: process.env.KIS_PAPER_ACCOUNT_PRODUCT_CODE,
  KIS_LIVE_APP_KEY: process.env.KIS_LIVE_APP_KEY,
  KIS_LIVE_APP_SECRET: process.env.KIS_LIVE_APP_SECRET,
  KIS_LIVE_ACCOUNT_NO: process.env.KIS_LIVE_ACCOUNT_NO,
  KIS_LIVE_ACCOUNT_PRODUCT_CODE: process.env.KIS_LIVE_ACCOUNT_PRODUCT_CODE,
  KIS_BASE_URL: process.env.KIS_BASE_URL,
  TRADING_MODE: process.env.TRADING_MODE,
  TRADING_MARKET: process.env.TRADING_MARKET,
  TRADING_BASE_CURRENCY: process.env.TRADING_BASE_CURRENCY,
  MAX_ORDER_VALUE: process.env.MAX_ORDER_VALUE,
  MAX_ORDER_QUANTITY: process.env.MAX_ORDER_QUANTITY,
  DUPLICATE_ORDER_WINDOW_MS: process.env.DUPLICATE_ORDER_WINDOW_MS,
  ORDER_EXECUTION_TOKEN: process.env.ORDER_EXECUTION_TOKEN,
  ALLOW_LIVE_TRADING: process.env.ALLOW_LIVE_TRADING,
});
