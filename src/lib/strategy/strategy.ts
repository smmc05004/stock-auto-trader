import type { AccountSummary, Quote, TradingSignal } from "@/lib/types/trading";

export type StrategyContext = {
  account: AccountSummary;
  quote: Quote;
};

export interface TradingStrategy {
  name: string;
  description: string;
  evaluate(context: StrategyContext): Promise<TradingSignal>;
}
