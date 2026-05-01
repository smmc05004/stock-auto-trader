import type { TradingStrategy } from "@/lib/strategy/strategy";
import type {
  AccountSummary,
  OrderHistoryItem,
  Position,
  Quote,
  TradingSignal,
} from "@/lib/types/trading";

export type HistoricalPrice = {
  symbol: string;
  name: string;
  market: "KR" | "US";
  close: number;
  changeRate: number;
  currency: string;
  timestamp: string;
};

export type BacktestTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  timestamp: string;
  reason: string;
};

export type BacktestResult = {
  strategyName: string;
  initialCash: number;
  finalEquity: number;
  returnRate: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  trades: BacktestTrade[];
  signals: TradingSignal[];
};

type RunBacktestInput = {
  strategy: TradingStrategy;
  prices: HistoricalPrice[];
  initialCash: number;
  feeRate?: number;
};

function toQuote(price: HistoricalPrice): Quote {
  return {
    symbol: price.symbol,
    name: price.name,
    market: price.market,
    price: price.close,
    changeRate: price.changeRate,
    currency: price.currency,
    timestamp: price.timestamp,
  };
}

function getPositionValue(position: Position) {
  return position.quantity * position.currentPrice;
}

function getEquity(cash: number, positions: Position[]) {
  return cash + positions.reduce((total, position) => total + getPositionValue(position), 0);
}

function getCashRatio(cash: number, positions: Position[]) {
  const equity = getEquity(cash, positions);
  return equity > 0 ? cash / equity : 0;
}

function calculateMaxDrawdown(equityCurve: number[]) {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;

  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);

    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }

  return maxDrawdown;
}

function calculateWinRate(trades: BacktestTrade[]) {
  const closedProfits: number[] = [];
  const averageCostBySymbol = new Map<string, number>();
  const quantityBySymbol = new Map<string, number>();

  for (const trade of trades) {
    const currentQuantity = quantityBySymbol.get(trade.symbol) ?? 0;
    const currentAverageCost = averageCostBySymbol.get(trade.symbol) ?? 0;

    if (trade.side === "buy") {
      const nextQuantity = currentQuantity + trade.quantity;
      const nextAverageCost =
        nextQuantity > 0
          ? (currentAverageCost * currentQuantity + trade.value) / nextQuantity
          : 0;

      quantityBySymbol.set(trade.symbol, nextQuantity);
      averageCostBySymbol.set(trade.symbol, nextAverageCost);
      continue;
    }

    if (currentQuantity <= 0) {
      continue;
    }

    closedProfits.push((trade.price - currentAverageCost) * trade.quantity);
    quantityBySymbol.set(trade.symbol, Math.max(currentQuantity - trade.quantity, 0));
  }

  if (closedProfits.length === 0) {
    return 0;
  }

  return closedProfits.filter((profit) => profit > 0).length / closedProfits.length;
}

function updatePositionPrice(positions: Position[], quote: Quote) {
  return positions.map((position) =>
    position.symbol === quote.symbol
      ? {
          ...position,
          currentPrice: quote.price,
        }
      : position,
  );
}

function applyTrade(
  positions: Position[],
  trade: BacktestTrade,
) {
  const position = positions.find((item) => item.symbol === trade.symbol);

  if (trade.side === "buy") {
    if (!position) {
      return [
        ...positions,
        {
          symbol: trade.symbol,
          name: trade.symbol,
          quantity: trade.quantity,
          averagePrice: trade.price,
          currentPrice: trade.price,
          currency: "KRW",
        },
      ];
    }

    const nextQuantity = position.quantity + trade.quantity;
    const nextAveragePrice =
      (position.averagePrice * position.quantity + trade.value) / nextQuantity;

    return positions.map((item) =>
      item.symbol === trade.symbol
        ? {
            ...item,
            quantity: nextQuantity,
            averagePrice: nextAveragePrice,
            currentPrice: trade.price,
          }
        : item,
    );
  }

  if (!position) {
    return positions;
  }

  const nextQuantity = Math.max(position.quantity - trade.quantity, 0);

  return positions
    .map((item) =>
      item.symbol === trade.symbol
        ? {
            ...item,
            quantity: nextQuantity,
            currentPrice: trade.price,
          }
        : item,
    )
    .filter((item) => item.quantity > 0);
}

export async function runBacktest({
  strategy,
  prices,
  initialCash,
  feeRate = 0,
}: RunBacktestInput): Promise<BacktestResult> {
  let cash = initialCash;
  let positions: Position[] = [];
  const quoteHistory: Quote[] = [];
  const orderHistory: OrderHistoryItem[] = [];
  const trades: BacktestTrade[] = [];
  const signals: TradingSignal[] = [];
  const equityCurve: number[] = [initialCash];

  for (const price of prices) {
    const quote = toQuote(price);
    positions = updatePositionPrice(positions, quote);

    const account: AccountSummary = {
      accountNo: "BACKTEST",
      cash,
      currency: quote.currency,
      totalMarketValue: positions.reduce(
        (total, position) => total + getPositionValue(position),
        0,
      ),
      positions,
    };

    const signal = await strategy.evaluate({
      account,
      quote,
      quoteHistory: [...quoteHistory, quote],
      positions,
      orderHistory,
      cashRatio: getCashRatio(cash, positions),
    });
    signals.push(signal);

    const order = signal.suggestedOrder;

    if (order && signal.action !== "hold") {
      const value = order.quantity * quote.price;
      const fee = value * feeRate;
      const heldQuantity =
        positions.find((position) => position.symbol === order.symbol)?.quantity ?? 0;
      const canBuy = order.side === "buy" && cash >= value + fee;
      const canSell = order.side === "sell" && heldQuantity >= order.quantity;

      if (canBuy || canSell) {
        const trade: BacktestTrade = {
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          price: quote.price,
          value,
          timestamp: quote.timestamp,
          reason: signal.reason,
        };

        cash += order.side === "buy" ? -(value + fee) : value - fee;
        positions = applyTrade(positions, trade);
        trades.push(trade);
        orderHistory.push({
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          requestedAt: quote.timestamp,
          accepted: true,
        });
      }
    }

    quoteHistory.push(quote);
    equityCurve.push(getEquity(cash, positions));
  }

  const finalEquity = equityCurve[equityCurve.length - 1] ?? initialCash;

  return {
    strategyName: strategy.name,
    initialCash,
    finalEquity,
    returnRate: initialCash > 0 ? (finalEquity - initialCash) / initialCash : 0,
    maxDrawdown: calculateMaxDrawdown(equityCurve),
    tradeCount: trades.length,
    winRate: calculateWinRate(trades),
    trades,
    signals,
  };
}
