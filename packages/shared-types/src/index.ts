export type DecimalString = string;
export type Leverage = 1 | 2 | 5 | 10;
export type RiskState = 'HEALTHY' | 'MARGIN_WARNING' | 'LIQUIDATION';
export type PriceAlertDirection = 'ABOVE' | 'BELOW';
export type PriceAlertStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED';
export type UserRole = 'TRADER' | 'ADMIN';

export interface HealthResponse {
  service: 'excess-api';
  status: 'ok';
  timestamp: string;
}

export interface ReadinessResponse {
  service: 'excess-api';
  status: 'ready' | 'not_ready';
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
    marketData: 'up' | 'down';
  };
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
export type OrderPurpose =
  'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type AccountStatus = 'ACTIVE' | 'RESTRICTED' | 'CLOSED';
export type LedgerEntryType =
  'DEMO_CREDIT' | 'REALIZED_PNL' | 'FEE' | 'ADJUSTMENT';

export interface UserProfileSummary {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
  role: UserRole;
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

interface OrderRequestBase {
  clientOrderId: string;
  symbol: 'BTC-USD';
  side: OrderSide;
  quantity: DecimalString;
  leverage?: Leverage;
  stopLossPrice?: DecimalString;
  takeProfitPrice?: DecimalString;
}

export interface MarketOrderRequest extends OrderRequestBase {
  type: 'MARKET';
}

export interface LimitOrderRequest extends OrderRequestBase {
  type: 'LIMIT';
  limitPrice: DecimalString;
}

export interface StopOrderRequest extends OrderRequestBase {
  type: 'STOP';
  stopPrice: DecimalString;
}

export type OrderPlacementRequest =
  MarketOrderRequest | LimitOrderRequest | StopOrderRequest;

export interface OrderSummary {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: DecimalString;
  leverage: Leverage;
  requestedPrice: DecimalString | null;
  stopPrice: DecimalString | null;
  stopLossPrice: DecimalString | null;
  takeProfitPrice: DecimalString | null;
  executedQuantity: DecimalString;
  averageFillPrice: DecimalString | null;
  status: OrderStatus;
  purpose: OrderPurpose;
  reduceOnly: boolean;
  parentOrderId: string | null;
  createdAt: string;
  updatedAt: string;
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
  leverage: Leverage;
  usedMargin: DecimalString;
  realizedPnl: DecimalString;
  unrealizedPnl: DecimalString;
  updatedAt: string;
}

export interface PortfolioSummary {
  account: DemoAccountSummary;
  equity: DecimalString;
  unrealizedPnl: DecimalString;
  usedMargin: DecimalString;
  freeMargin: DecimalString;
  marginLevel: DecimalString | null;
  riskState: RiskState;
  positions: PositionSummary[];
}

export interface OrderPlacementResponse {
  order: OrderSummary;
  trade: TradeSummary | null;
  relatedOrders: OrderSummary[];
  portfolio: PortfolioSummary;
}

export type MarketOrderResponse = Omit<OrderPlacementResponse, 'trade'> & {
  trade: TradeSummary;
};

export interface OpenOrdersResponse {
  items: OrderSummary[];
}

export interface CreatePriceAlertRequest {
  symbol: 'BTC-USD';
  direction: PriceAlertDirection;
  targetPrice: DecimalString;
}

export interface PriceAlertSummary {
  id: string;
  symbol: string;
  direction: PriceAlertDirection;
  targetPrice: DecimalString;
  status: PriceAlertStatus;
  deliveryStatus: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | null;
  triggeredPrice: DecimalString | null;
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceAlertsResponse {
  items: PriceAlertSummary[];
}

export interface NotificationSummary {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  items: NotificationSummary[];
  unreadCount: number;
}

export interface AdminDeliverySummary {
  id: string;
  aggregateId: string;
  eventType: string;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
}

export interface AdminAuditSummary {
  id: string;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
}

export interface AdminOverviewResponse {
  system: ReadinessResponse;
  totals: {
    users: number;
    activeUsers: number;
    demoAccounts: number;
    openOrders: number;
    openPositions: number;
    activePriceAlerts: number;
    unreadNotifications: number;
  };
  deliveries: {
    pending: number;
    processing: number;
    published: number;
    failed: number;
  };
  recentDeliveries: AdminDeliverySummary[];
  recentUsers: AdminUserSummary[];
  recentAuditEvents: AdminAuditSummary[];
  generatedAt: string;
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
