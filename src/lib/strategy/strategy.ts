import type {
  AccountSummary,
  OrderHistoryItem,
  Position,
  Quote,
  TradingSignal,
} from "@/lib/types/trading";

export type StrategyContext = {
  account: AccountSummary;
  quote: Quote;
  quoteHistory: Quote[];
  positions: Position[];
  orderHistory: OrderHistoryItem[];
  cashRatio: number;
};

export interface TradingStrategy {
  name: string;
  description: string;
  evaluate(context: StrategyContext): Promise<TradingSignal>;
}
