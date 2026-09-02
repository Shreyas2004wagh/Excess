export type DecimalString = string;

export interface HealthResponse {
  service: 'excess-api';
  status: 'ok';
  timestamp: string;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type OrderStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type AccountStatus = 'ACTIVE' | 'RESTRICTED' | 'CLOSED';
export type LedgerEntryType =
  'DEMO_CREDIT' | 'REALIZED_PNL' | 'FEE' | 'ADJUSTMENT';

export interface UserProfileSummary {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
}

export interface DemoAccountSummary {
  id: string;
  type: 'DEMO';
  baseCurrency: string;
  balance: DecimalString;
  initialBalance: DecimalString;
  status: AccountStatus;
  createdAt: string;
}

export interface SessionBootstrapResponse {
  user: UserProfileSummary;
  account: DemoAccountSummary;
}

export interface LedgerEntrySummary {
  id: string;
  type: LedgerEntryType;
  amount: DecimalString;
  balanceAfter: DecimalString;
  referenceType: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntrySummary[];
  nextCursor: string | null;
}

export interface MarketOrderRequest {
  clientOrderId: string;
  symbol: 'BTC-USD';
  side: OrderSide;
  type: 'MARKET';
  quantity: DecimalString;
}

export interface OrderSummary {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: DecimalString;
  executedQuantity: DecimalString;
  averageFillPrice: DecimalString | null;
  status: OrderStatus;
  createdAt: string;
}

export interface TradeSummary {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: DecimalString;
  quantity: DecimalString;
  fee: DecimalString;
  spreadBps: DecimalString;
  slippageBps: DecimalString;
  executedAt: string;
}

export interface PositionSummary {
  id: string;
  symbol: string;
  signedQuantity: DecimalString;
  averageEntryPrice: DecimalString | null;
  markPrice: DecimalString;
  notional: DecimalString;
  realizedPnl: DecimalString;
  unrealizedPnl: DecimalString;
  updatedAt: string;
}

export interface PortfolioSummary {
  account: DemoAccountSummary;
  equity: DecimalString;
  unrealizedPnl: DecimalString;
  positions: PositionSummary[];
}

export interface MarketOrderResponse {
  order: OrderSummary;
  trade: TradeSummary;
  portfolio: PortfolioSummary;
}

export type MarketDataStatus = 'CONNECTING' | 'LIVE' | 'STALE' | 'OFFLINE';
export type MarketDataSource = 'COINBASE' | 'SIMULATED';

export interface MarketCandle {
  time: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
}

export interface MarketTicker {
  symbol: string;
  price: DecimalString;
  bid: DecimalString;
  ask: DecimalString;
  change24h: DecimalString;
  high24h: DecimalString;
  low24h: DecimalString;
  volume24h: DecimalString;
  status: MarketDataStatus;
  source: MarketDataSource;
  updatedAt: string;
}

export interface MarketInstrumentSummary {
  symbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: DecimalString;
  lotSize: DecimalString;
  minimumQuantity: DecimalString;
  status: 'ACTIVE' | 'HALTED' | 'DISABLED';
  ticker: MarketTicker;
}

export interface CandleHistoryResponse {
  symbol: string;
  granularity: 300;
  items: MarketCandle[];
  source: MarketDataSource;
  fetchedAt: string;
}

export type MarketStreamEvent =
  | { event: 'market:ticker'; data: MarketTicker }
  | {
      event: 'market:candle';
      data: { symbol: string; candle: MarketCandle };
    }
  | {
      event: 'market:status';
      data: { symbol: string; status: MarketDataStatus };
    };
