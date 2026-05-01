import { env } from "@/lib/config/env";
import type { BrokerClient, BrokerStatus } from "@/lib/broker/broker";
import type {
  AccountSummary,
  OrderRequest,
  OrderResult,
  Quote,
} from "@/lib/types/trading";

const quotes: Record<string, Quote> = {
  "005930": {
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    price: 73500,
    changeRate: 1.21,
    currency: "KRW",
    timestamp: new Date().toISOString(),
  },
  "000660": {
    symbol: "000660",
    name: "SK하이닉스",
    market: "KR",
    price: 182000,
    changeRate: -0.42,
    currency: "KRW",
    timestamp: new Date().toISOString(),
  },
};

export class MockBrokerClient implements BrokerClient {
  async getStatus(): Promise<BrokerStatus> {
    return {
      provider: env.BROKER_PROVIDER,
      connected: true,
      mode: env.TRADING_MODE,
      message: "Mock broker is ready. No real orders will be sent.",
    };
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return {
      accountNo: env.BROKER_ACCOUNT_NO,
      cash: 10_000_000,
      currency: env.TRADING_BASE_CURRENCY,
      totalMarketValue: 13_675_000,
      positions: [
        {
          symbol: "005930",
          name: "삼성전자",
          quantity: 50,
          averagePrice: 70000,
          currentPrice: quotes["005930"].price,
          currency: "KRW",
        },
      ],
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    return quotes[symbol] ?? {
      symbol,
      name: "Unknown",
      market: env.TRADING_MARKET,
      price: 100000,
      changeRate: 0,
      currency: env.TRADING_BASE_CURRENCY,
      timestamp: new Date().toISOString(),
    };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    return {
      orderId: `mock-${Date.now()}`,
      accepted: true,
      mode: env.TRADING_MODE,
      message: `${order.side.toUpperCase()} ${order.quantity} ${order.symbol} accepted in ${env.TRADING_MODE} mode.`,
      requestedAt: new Date().toISOString(),
    };
  }
}
