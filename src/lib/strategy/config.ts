import { z } from "zod";

export const momentumStrategyConfigSchema = z.object({
  buyChangeRateThreshold: z.coerce.number().default(1),
  sellChangeRateThreshold: z.coerce.number().default(-1),
  orderQuantity: z.coerce.number().int().positive().default(1),
  confidence: z.coerce.number().min(0).max(1).default(0.35),
});

export type MomentumStrategyConfig = z.infer<typeof momentumStrategyConfigSchema>;
export type MomentumStrategyConfigInput = z.input<typeof momentumStrategyConfigSchema>;

export function loadMomentumStrategyConfig(overrides: Partial<MomentumStrategyConfigInput> = {}) {
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );

  return momentumStrategyConfigSchema.parse({
    buyChangeRateThreshold: process.env.STRATEGY_BUY_CHANGE_RATE_THRESHOLD,
    sellChangeRateThreshold: process.env.STRATEGY_SELL_CHANGE_RATE_THRESHOLD,
    orderQuantity: process.env.STRATEGY_ORDER_QUANTITY,
    confidence: process.env.STRATEGY_CONFIDENCE,
    ...definedOverrides,
  });
}
