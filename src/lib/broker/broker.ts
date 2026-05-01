import type {
  AccountSummary,
  OrderRequest,
  OrderResult,
  Quote,
} from "@/lib/types/trading";

export type BrokerStatus = {
  provider: string;
  connected: boolean;
  mode: "paper" | "live";
  message: string;
};

export interface BrokerClient {
  getStatus(): Promise<BrokerStatus>;
  getAccountSummary(): Promise<AccountSummary>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
}
