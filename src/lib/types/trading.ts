export type Market = "KR" | "US";

export type TradingMode = "paper" | "live";

export type OrderSide = "buy" | "sell";

export type OrderType = "market" | "limit";

export type SignalAction = "buy" | "sell" | "hold";

export type BrokerProvider = "mock" | "kis";

export type Quote = {
  symbol: string;
  name: string;
  market: Market;
  price: number;
  changeRate: number;
  currency: string;
  timestamp: string;
};

export type Position = {
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  currency: string;
};

export type AccountSummary = {
  accountNo: string;
  cash: number;
  currency: string;
  totalMarketValue: number;
  positions: Position[];
};

export type OrderRequest = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
};

export type OrderResult = {
  orderId: string;
  accepted: boolean;
  mode: TradingMode;
  message: string;
  requestedAt: string;
};

export type OrderSafetyCheck = {
  allowed: boolean;
  reasons: string[];
  estimatedOrderValue: number;
  maxOrderValue: number;
  maxOrderQuantity: number;
};

export type TradingSignal = {
  symbol: string;
  action: SignalAction;
  confidence: number;
  reason: string;
  suggestedOrder?: OrderRequest;
};

export type TradingDecision = {
  strategyName: string;
  signal: TradingSignal;
  safetyCheck?: OrderSafetyCheck;
  order?: OrderResult;
};
