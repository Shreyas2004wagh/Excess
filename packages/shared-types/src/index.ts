export type DecimalString = string;
export const MARKET_SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];
export type Leverage = 1 | 2 | 5 | 10;
export type RiskState = 'HEALTHY' | 'MARGIN_WARNING' | 'LIQUIDATION';
export type PriceAlertDirection = 'ABOVE' | 'BELOW';
export type PriceAlertStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED';
export type UserRole = 'TRADER' | 'ADMIN';
export type EmailDeliveryStatus = 'DISABLED' | 'PENDING' | 'SENT' | 'FAILED';

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
  symbol: MarketSymbol;
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

export interface TradeHistoryItem extends TradeSummary {
  orderType: OrderType;
  purpose: OrderPurpose;
  leverage: Leverage;
  realizedPnl: DecimalString | null;
}

export interface TradeHistoryPage {
  items: TradeHistoryItem[];
  nextCursor: string | null;
}

export interface TradingReportFilters {
  /** Inclusive UTC calendar dates; at most 366 days. */
  from: string;
  to: string;
  symbol: MarketSymbol | null;
  /** Execution-time cutoff, reused for pagination and export. */
  asOf: string;
}

export interface TradingReportTotals {
  executions: number;
  tradedNotional: DecimalString;
  fees: DecimalString;
  /** Applied REALIZED_PNL ledger amounts, including negative-balance protection. */
  creditedRealizedPnl: DecimalString;
}

export interface TradingReportDay extends TradingReportTotals {
  date: string;
  cumulativeRealizedPnl: DecimalString;
}

export interface TradingReport {
  filters: TradingReportFilters;
  summary: TradingReportTotals;
  days: TradingReportDay[];
  trades: TradeHistoryPage;
}

export interface TradingReportQuery {
  from?: string;
  to?: string;
  symbol?: MarketSymbol;
  asOf?: string;
  cursor?: string;
  limit?: number;
}

export interface TradingPerformanceSummary {
  totalTrades: number;
  activePositions: number;
  realizedEvents: number;
  winningTrades: number;
  losingTrades: number;
  winRate: DecimalString | null;
  grossProfit: DecimalString;
  grossLoss: DecimalString;
  netRealizedPnl: DecimalString;
  tradedNotional: DecimalString;
  averageTradeNotional: DecimalString;
  largestWin: DecimalString | null;
  largestLoss: DecimalString | null;
  generatedAt: string;
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
  symbol: MarketSymbol;
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
  emailStatus: EmailDeliveryStatus;
  emailSentAt: string | null;
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
  emailStatus: EmailDeliveryStatus | null;
  emailAttempts: number;
  emailLastError: string | null;
  emailSentAt: string | null;
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

export interface AdminAuditEntry extends AdminAuditSummary {
  actorUserId: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
}

export interface AdminAuditQuery {
  from?: string;
  to?: string;
  action?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  asOf?: string;
  cursor?: string;
  limit?: number;
}

export interface AdminAuditPage {
  items: AdminAuditEntry[];
  nextCursor: string | null;
  filters: {
    from: string;
    to: string;
    action: string | null;
    actorUserId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    asOf: string;
  };
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
  emailDeliveries: {
    disabled: number;
    pending: number;
    sent: number;
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
  symbol: MarketSymbol;
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
  symbol: MarketSymbol;
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

export interface MarketInstrumentsResponse {
  items: MarketInstrumentSummary[];
}

export interface CandleHistoryResponse {
  symbol: MarketSymbol;
  granularity: 300;
  items: MarketCandle[];
  source: MarketDataSource;
  fetchedAt: string;
}

export type MarketStreamEvent =
  | { event: 'market:ticker'; data: MarketTicker }
  | {
      event: 'market:candle';
      data: { symbol: MarketSymbol; candle: MarketCandle };
    }
  | {
      event: 'market:status';
      data: { symbol: MarketSymbol; status: MarketDataStatus };
    };
