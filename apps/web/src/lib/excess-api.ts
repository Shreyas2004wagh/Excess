import type {
  CandleHistoryResponse,
  AdminDeliverySummary,
  AdminOverviewResponse,
  CreatePriceAlertRequest,
  LedgerPage,
  MarketOrderRequest,
  MarketOrderResponse,
  MarketInstrumentSummary,
  MarketInstrumentsResponse,
  MarketSymbol,
  NotificationSummary,
  NotificationsResponse,
  OpenOrdersResponse,
  OrderPlacementRequest,
  OrderPlacementResponse,
  OrderSummary,
  PortfolioSummary,
  PriceAlertsResponse,
  PriceAlertSummary,
  SessionBootstrapResponse,
} from '@excess/shared-types';

export class ExcessApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExcessApiError';
  }
}

const apiBaseUrl =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:4000/api/v1';

async function request<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string | { code?: string; message?: string };
    } | null;
    const nestedMessage =
      typeof payload?.message === 'object' ? payload.message : null;
    throw new ExcessApiError(
      response.status,
      payload?.code ?? nestedMessage?.code ?? 'EXCESS_API_ERROR',
      (typeof payload?.message === 'string' ? payload.message : undefined) ??
        nestedMessage?.message ??
        'The Excess API request failed',
    );
  }

  return response.json() as Promise<T>;
}

export function bootstrapSession(token: string) {
  return request<SessionBootstrapResponse>('/session/bootstrap', token, {
    method: 'POST',
  });
}

export function getLedger(token: string) {
  return request<LedgerPage>('/accounts/demo/ledger?limit=20', token);
}

export function getMarketInstruments(token: string) {
  return request<MarketInstrumentsResponse>('/market-data/instruments', token);
}

export function getMarketInstrument(
  token: string,
  symbol: MarketSymbol = 'BTC-USD',
) {
  return request<MarketInstrumentSummary>(
    `/market-data/instruments/${symbol}`,
    token,
  );
}

export function getMarketCandles(
  token: string,
  symbol: MarketSymbol = 'BTC-USD',
) {
  return request<CandleHistoryResponse>(
    `/market-data/instruments/${symbol}/candles?granularity=300&limit=300`,
    token,
  );
}

export function getPortfolio(token: string) {
  return request<PortfolioSummary>('/trading/portfolio', token);
}

export function placeMarketOrder(token: string, order: MarketOrderRequest) {
  return request<MarketOrderResponse>('/trading/orders', token, {
    method: 'POST',
    body: JSON.stringify(order),
  });
}

export function placeOrder(token: string, order: OrderPlacementRequest) {
  return request<OrderPlacementResponse>('/trading/orders', token, {
    method: 'POST',
    body: JSON.stringify(order),
  });
}

export function getOpenOrders(token: string) {
  return request<OpenOrdersResponse>('/trading/orders/open', token);
}

export function cancelOrder(token: string, orderId: string) {
  return request<OrderSummary>(`/trading/orders/${orderId}`, token, {
    method: 'DELETE',
  });
}

export function getPriceAlerts(token: string) {
  return request<PriceAlertsResponse>('/alerts', token);
}

export function createPriceAlert(
  token: string,
  alert: CreatePriceAlertRequest,
) {
  return request<PriceAlertSummary>('/alerts', token, {
    method: 'POST',
    body: JSON.stringify(alert),
  });
}

export function cancelPriceAlert(token: string, alertId: string) {
  return request<PriceAlertSummary>(`/alerts/${alertId}`, token, {
    method: 'DELETE',
  });
}

export function getNotifications(token: string) {
  return request<NotificationsResponse>('/notifications', token);
}

export function markNotificationRead(token: string, notificationId: string) {
  return request<NotificationSummary>(
    `/notifications/${notificationId}/read`,
    token,
    { method: 'PATCH' },
  );
}

export function markAllNotificationsRead(token: string) {
  return request<NotificationsResponse>('/notifications/read-all', token, {
    method: 'POST',
  });
}

export function getAdminOverview(token: string) {
  return request<AdminOverviewResponse>('/admin/overview', token);
}

export function retryAdminDelivery(token: string, eventId: string) {
  return request<AdminDeliverySummary>(
    `/admin/deliveries/${eventId}/retry`,
    token,
    { method: 'POST' },
  );
}
