import { loadMomentumStrategyConfig } from "@/lib/strategy/config";
import { createSampleMomentumStrategy } from "@/lib/strategy/samples/momentumStrategy";

export const sampleMomentumStrategy = createSampleMomentumStrategy(
  loadMomentumStrategyConfig(),
);
