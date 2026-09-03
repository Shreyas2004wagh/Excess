'use client';

import { UserButton, useAuth } from '@clerk/nextjs';
import type {
  CandleHistoryResponse,
  MarketCandle,
  MarketDataStatus,
  MarketInstrumentSummary,
  MarketTicker,
  OrderPlacementRequest,
  OrderPlacementResponse,
  OrderSide,
  OrderSummary,
  OrderType,
  PortfolioSummary,
  UserProfileSummary,
} from '@excess/shared-types';
import type {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

import {
  cancelOrder,
  ExcessApiError,
  getOpenOrders,
  getPortfolio,
  placeOrder,
} from '../../lib/excess-api';
import { formatCurrency } from '../../lib/format';

const websocketUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:4000';

function chartCandle(candle: MarketCandle): CandlestickData<UTCTimestamp> {
  return {
    time: candle.time as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
}

function decimal(value: string, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
    minimumFractionDigits: maximumFractionDigits,
  }).format(Number(value));
}

function statusTone(status: MarketDataStatus) {
  if (status === 'LIVE') return 'text-[var(--accent)]';
  if (status === 'CONNECTING') return 'text-sky-300';
  if (status === 'STALE') return 'text-amber-300';
  return 'text-rose-300';
}

function orderLabel(order: OrderSummary) {
  if (order.purpose === 'STOP_LOSS') return 'Stop loss';
  if (order.purpose === 'TAKE_PROFIT') return 'Take profit';
  return order.type === 'LIMIT' ? 'Limit' : 'Stop';
}

function suggestedPrice(
  type: OrderType,
  side: OrderSide,
  ticker: MarketTicker,
) {
  const executable = Number(side === 'BUY' ? ticker.ask : ticker.bid);
  const offset = type === 'LIMIT' ? -100 : 100;
  const direction = side === 'BUY' ? 1 : -1;
  return (executable + offset * direction).toFixed(2);
}

function portfolioAtMark(
  portfolio: PortfolioSummary,
  markPrice: string,
): PortfolioSummary {
  const mark = Number(markPrice);
  const positions = portfolio.positions.map((position) => {
    const quantity = Number(position.signedQuantity);
    const entry = Number(position.averageEntryPrice ?? markPrice);
    return {
      ...position,
      markPrice,
      notional: String(Math.abs(quantity) * mark),
      unrealizedPnl: String((mark - entry) * quantity),
    };
  });
  const unrealizedPnl = positions.reduce(
    (total, position) => total + Number(position.unrealizedPnl),
    0,
  );

  return {
    ...portfolio,
    equity: String(Number(portfolio.account.balance) + unrealizedPnl),
    unrealizedPnl: String(unrealizedPnl),
    positions,
  };
}

export function MarketTerminal({
  candles,
  instrument,
  openOrders: initialOpenOrders,
  portfolio: initialPortfolio,
  user,
}: {
  candles: CandleHistoryResponse;
  instrument: MarketInstrumentSummary;
  openOrders: OrderSummary[];
  portfolio: PortfolioSummary;
  user: UserProfileSummary;
}) {
  const { getToken } = useAuth();
  const chartContainer = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const pendingCandle = useRef<MarketCandle | null>(null);
  const [ticker, setTicker] = useState<MarketTicker>(instrument.ticker);
  const [feedStatus, setFeedStatus] = useState<MarketDataStatus>(
    instrument.ticker.status,
  );
  const [streamError, setStreamError] = useState<string | null>(null);
  const [portfolio, setPortfolio] =
    useState<PortfolioSummary>(initialPortfolio);
  const [side, setSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [quantity, setQuantity] = useState('0.01');
  const [orderPrice, setOrderPrice] = useState(instrument.ticker.price);
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [openOrders, setOpenOrders] =
    useState<OrderSummary[]>(initialOpenOrders);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(
    null,
  );
  const [orderError, setOrderError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<OrderPlacementResponse | null>(
    null,
  );

  useEffect(() => {
    const container = chartContainer.current;
    if (!container) return;

    let disposed = false;

    void import('lightweight-charts').then(
      ({ CandlestickSeries, ColorType, CrosshairMode, createChart }) => {
        if (disposed) return;
        const nextChart = createChart(container, {
          autoSize: true,
          layout: {
            background: { type: ColorType.Solid, color: '#0b0f14' },
            textColor: '#82909f',
            attributionLogo: false,
          },
          grid: {
            vertLines: { color: 'rgba(130, 144, 159, 0.08)' },
            horzLines: { color: 'rgba(130, 144, 159, 0.08)' },
          },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: 'rgba(130, 144, 159, 0.16)' },
          timeScale: {
            borderColor: 'rgba(130, 144, 159, 0.16)',
            timeVisible: true,
            secondsVisible: false,
          },
        });
        const nextSeries = nextChart.addSeries(CandlestickSeries, {
          upColor: '#9dff5b',
          downColor: '#ff647c',
          borderVisible: false,
          wickUpColor: '#9dff5b',
          wickDownColor: '#ff647c',
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        nextSeries.setData(candles.items.map(chartCandle));
        if (pendingCandle.current) {
          nextSeries.update(chartCandle(pendingCandle.current));
          pendingCandle.current = null;
        }
        nextChart.timeScale().fitContent();
        chart.current = nextChart;
        candleSeries.current = nextSeries;
      },
    );

    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      candleSeries.current = null;
    };
  }, [candles.items]);

  useEffect(() => {
    let disposed = false;
    let socket: ReturnType<typeof io> | null = null;

    void getToken().then((token) => {
      if (disposed || !token) {
        setFeedStatus('OFFLINE');
        setStreamError('A valid session is required for live prices.');
        return;
      }

      socket = io(`${websocketUrl}/market-data`, {
        transports: ['websocket'],
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
      });
      setFeedStatus('CONNECTING');

      socket.on('connect', () => setStreamError(null));
      socket.on('connect_error', () => {
        setFeedStatus('OFFLINE');
        setStreamError('Reconnecting to the market stream…');
      });
      socket.on('market:ticker', (nextTicker: MarketTicker) => {
        setTicker(nextTicker);
        setFeedStatus(nextTicker.status);
      });
      socket.on(
        'market:candle',
        (message: { symbol: string; candle: MarketCandle }) => {
          if (message.symbol !== instrument.symbol) return;
          if (candleSeries.current) {
            candleSeries.current.update(chartCandle(message.candle));
          } else {
            pendingCandle.current = message.candle;
          }
        },
      );
      socket.on(
        'market:status',
        (message: { symbol: string; status: MarketDataStatus }) => {
          if (message.symbol === instrument.symbol) {
            setFeedStatus(message.status);
          }
        },
      );
      socket.on('market:error', (message: { message?: string }) => {
        setStreamError(message.message ?? 'The market stream is unavailable.');
      });
    });

    return () => {
      disposed = true;
      socket?.disconnect();
    };
  }, [getToken, instrument.symbol]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const token = await getToken();
      if (!token) return;
      const [nextPortfolio, nextOrders] = await Promise.all([
        getPortfolio(token),
        getOpenOrders(token),
      ]);
      if (!disposed) {
        setPortfolio(nextPortfolio);
        setOpenOrders(nextOrders.items);
      }
    };
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [getToken]);

  const change = Number(ticker.change24h);
  const positive = change >= 0;
  const livePortfolio = portfolioAtMark(portfolio, ticker.price);
  const openPosition = livePortfolio.positions[0];
  const estimatedPrice =
    orderType === 'MARKET'
      ? side === 'BUY'
        ? ticker.ask
        : ticker.bid
      : orderPrice;
  const parsedQuantity = Number(quantity);
  const parsedOrderPrice = Number(orderPrice);
  const orderIsValid =
    Number.isFinite(parsedQuantity) &&
    parsedQuantity >= Number(instrument.minimumQuantity) &&
    (orderType === 'MARKET' ||
      (Number.isFinite(parsedOrderPrice) && parsedOrderPrice > 0));

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orderIsValid || feedStatus !== 'LIVE') return;

    setIsSubmitting(true);
    setOrderError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error('Your session expired. Sign in and try again.');
      }
      const protection = {
        ...(stopLossPrice ? { stopLossPrice } : {}),
        ...(takeProfitPrice ? { takeProfitPrice } : {}),
      };
      const base = {
        clientOrderId: crypto.randomUUID(),
        symbol: 'BTC-USD',
        side,
        quantity,
        ...protection,
      } as const;
      let request: OrderPlacementRequest;
      if (orderType === 'LIMIT') {
        request = { ...base, type: 'LIMIT', limitPrice: orderPrice };
      } else if (orderType === 'STOP') {
        request = { ...base, type: 'STOP', stopPrice: orderPrice };
      } else {
        request = { ...base, type: 'MARKET' };
      }
      const response = await placeOrder(token, request);
      setPortfolio(response.portfolio);
      setLastOrder(response);
      setOpenOrders((await getOpenOrders(token)).items);
    } catch (error) {
      setOrderError(
        error instanceof ExcessApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'The order could not be placed.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function changeSide(nextSide: OrderSide) {
    setSide(nextSide);
    if (orderType !== 'MARKET') {
      setOrderPrice(suggestedPrice(orderType, nextSide, ticker));
    }
  }

  function changeOrderType(nextType: OrderType) {
    setOrderType(nextType);
    if (nextType !== 'MARKET') {
      setOrderPrice(suggestedPrice(nextType, side, ticker));
    }
  }

  async function cancelPendingOrder(orderId: string) {
    setCancellingOrderId(orderId);
    setOrderError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Your session expired. Sign in again.');
      await cancelOrder(token, orderId);
      setOpenOrders((orders) => orders.filter((order) => order.id !== orderId));
    } catch (error) {
      setOrderError(
        error instanceof Error
          ? error.message
          : 'The order could not be cancelled.',
      );
    } finally {
      setCancellingOrderId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#080b0f] px-3 py-3 text-[var(--foreground)] sm:px-5 sm:py-4">
      <nav className="flex min-h-14 flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-3">
        <div className="flex items-center gap-6">
          <Link
            className="font-mono text-base font-semibold tracking-[0.18em]"
            href="/"
          >
            EXCESS
          </Link>
          <div className="hidden items-center gap-2 text-sm sm:flex">
            <span
              className={`font-mono text-xs ${statusTone(feedStatus)}`}
              data-testid="feed-status"
            >
              ● {feedStatus}
            </span>
            <span className="text-[var(--muted)]">
              {ticker.source === 'COINBASE' ? 'Coinbase' : 'Test feed'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden text-right text-xs sm:block">
            <p className="text-[var(--muted)]">Demo balance</p>
            <p className="mt-0.5 font-mono">
              {formatCurrency(
                livePortfolio.account.balance,
                livePortfolio.account.baseCurrency,
              )}
            </p>
          </div>
          <Link className="button button-secondary" href="/dashboard">
            Dashboard
          </Link>
          <UserButton />
        </div>
      </nav>

      {streamError ? (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-2 text-sm text-amber-200">
          {streamError}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
            Watchlist
          </p>
          <button
            className="mt-4 w-full rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-4 text-left"
            type="button"
          >
            <span className="flex items-start justify-between gap-2">
              <span>
                <span className="block font-semibold">BTC / USD</span>
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  Bitcoin · Demo CFD
                </span>
              </span>
              <span
                className={`font-mono text-xs ${positive ? 'text-[var(--accent)]' : 'text-rose-300'}`}
              >
                {positive ? '+' : ''}
                {decimal(ticker.change24h)}%
              </span>
            </span>
            <span className="mt-5 block font-mono text-lg">
              ${decimal(ticker.price)}
            </span>
          </button>
          <div className="mt-6 space-y-3 border-t border-[var(--border)] pt-5 text-xs">
            <div className="flex justify-between">
              <span className="text-[var(--muted)]">Tick size</span>
              <span className="font-mono">{instrument.tickSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--muted)]">Minimum size</span>
              <span className="font-mono">{instrument.minimumQuantity}</span>
            </div>
          </div>
        </aside>

        <section className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold">BTC / USD</h1>
                <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                  CFD
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-3">
                <p
                  className="font-mono text-3xl font-semibold tracking-tight"
                  data-testid="live-price"
                >
                  ${decimal(ticker.price)}
                </p>
                <p
                  className={`font-mono text-sm ${positive ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                >
                  {positive ? '+' : ''}
                  {decimal(ticker.change24h)}%
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {['1m', '5m', '15m', '1h'].map((timeframe) => (
                <span
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs ${
                    timeframe === '5m'
                      ? 'bg-[var(--accent)] text-[#0b1207]'
                      : 'text-[var(--muted)]'
                  }`}
                  key={timeframe}
                >
                  {timeframe}
                </span>
              ))}
            </div>
          </header>

          <div className="grid grid-cols-2 gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {[
              ['24h high', `$${decimal(ticker.high24h)}`],
              ['24h low', `$${decimal(ticker.low24h)}`],
              ['Best bid', `$${decimal(ticker.bid)}`],
              ['Best ask', `$${decimal(ticker.ask)}`],
            ].map(([label, value]) => (
              <div className="bg-[var(--surface)] px-5 py-3" key={label}>
                <p className="text-[11px] text-[var(--muted)]">{label}</p>
                <p className="mt-1 font-mono text-sm">{value}</p>
              </div>
            ))}
          </div>

          <div className="h-[520px] w-full" ref={chartContainer} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--muted)]">
            <span>
              {candles.items.length} five-minute candles · Volume{' '}
              {decimal(ticker.volume24h, 4)} BTC
            </span>
            <a
              className="transition hover:text-[var(--foreground)]"
              href="https://www.tradingview.com/"
              rel="noreferrer"
              target="_blank"
            >
              Charts by TradingView
            </a>
          </div>
        </section>

        <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Order ticket</h2>
            <span className="rounded-full bg-white/5 px-2 py-1 font-mono text-[10px] text-[var(--muted)]">
              DEMO
            </span>
          </div>
          <form onSubmit={submitOrder}>
            <div className="mt-6 grid grid-cols-2 rounded-xl bg-[#0b0f14] p-1 text-center text-sm">
              {(['BUY', 'SELL'] as const).map((nextSide) => (
                <button
                  aria-pressed={side === nextSide}
                  className={`rounded-lg py-2 transition ${
                    side === nextSide
                      ? nextSide === 'BUY'
                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'bg-rose-300/10 text-rose-300'
                      : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                  }`}
                  key={nextSide}
                  onClick={() => changeSide(nextSide)}
                  type="button"
                >
                  {nextSide === 'BUY' ? 'Buy' : 'Sell'}
                </button>
              ))}
            </div>
            <fieldset className="mt-6">
              <legend className="text-xs text-[var(--muted)]">
                Order type
              </legend>
              <div className="mt-2 grid grid-cols-3 rounded-xl bg-[#0b0f14] p-1 text-xs">
                {(['MARKET', 'LIMIT', 'STOP'] as const).map((nextType) => (
                  <button
                    aria-pressed={orderType === nextType}
                    className={`rounded-lg py-2.5 capitalize transition ${
                      orderType === nextType
                        ? 'bg-white/10 text-[var(--foreground)]'
                        : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                    }`}
                    key={nextType}
                    onClick={() => changeOrderType(nextType)}
                    type="button"
                  >
                    {nextType.toLowerCase()}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="mt-4 block text-xs text-[var(--muted)]">
              Quantity (BTC)
              <input
                className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#0b0f14] px-4 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
                inputMode="decimal"
                min={instrument.minimumQuantity}
                name="quantity"
                onChange={(event) => setQuantity(event.target.value)}
                required
                step={instrument.lotSize}
                type="number"
                value={quantity}
              />
            </label>
            {orderType !== 'MARKET' ? (
              <label className="mt-4 block text-xs text-[var(--muted)]">
                {orderType === 'LIMIT' ? 'Limit price' : 'Stop price'} (USD)
                <input
                  className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#0b0f14] px-4 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
                  inputMode="decimal"
                  min={instrument.tickSize}
                  name="orderPrice"
                  onChange={(event) => setOrderPrice(event.target.value)}
                  required
                  step={instrument.tickSize}
                  type="number"
                  value={orderPrice}
                />
              </label>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block text-xs text-[var(--muted)]">
                Stop loss (USD)
                <input
                  className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#0b0f14] px-3 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
                  inputMode="decimal"
                  min={instrument.tickSize}
                  name="stopLossPrice"
                  onChange={(event) => setStopLossPrice(event.target.value)}
                  placeholder="Optional"
                  step={instrument.tickSize}
                  type="number"
                  value={stopLossPrice}
                />
              </label>
              <label className="block text-xs text-[var(--muted)]">
                Take profit (USD)
                <input
                  className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#0b0f14] px-3 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
                  inputMode="decimal"
                  min={instrument.tickSize}
                  name="takeProfitPrice"
                  onChange={(event) => setTakeProfitPrice(event.target.value)}
                  placeholder="Optional"
                  step={instrument.tickSize}
                  type="number"
                  value={takeProfitPrice}
                />
              </label>
            </div>
            <div className="mt-6 space-y-3 border-y border-[var(--border)] py-5 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Equity</span>
                <span className="font-mono">
                  {formatCurrency(
                    livePortfolio.equity,
                    livePortfolio.account.baseCurrency,
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Estimated price</span>
                <span className="font-mono">${decimal(estimatedPrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Order value</span>
                <span className="font-mono">
                  $
                  {decimal(
                    String((parsedQuantity || 0) * Number(estimatedPrice)),
                  )}
                </span>
              </div>
            </div>
            <button
              className={`mt-6 w-full rounded-xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-[var(--muted)] ${
                side === 'BUY'
                  ? 'bg-[var(--accent)] text-[#0b1207]'
                  : 'bg-rose-300 text-[#16090c]'
              }`}
              disabled={isSubmitting || !orderIsValid || feedStatus !== 'LIVE'}
              type="submit"
            >
              {isSubmitting
                ? orderType === 'MARKET'
                  ? 'Executing…'
                  : 'Submitting…'
                : `${side === 'BUY' ? 'Buy' : 'Sell'} BTC · ${orderType.toLowerCase()}`}
            </button>
          </form>
          {orderError ? (
            <p
              className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-200"
              role="alert"
            >
              {orderError}
            </p>
          ) : null}
          {lastOrder ? (
            <p
              className="mt-4 rounded-xl border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-3 py-2 text-xs leading-5 text-[var(--accent)]"
              role="status"
            >
              {lastOrder.trade ? (
                <>
                  Filled {lastOrder.trade.quantity} BTC at $
                  {decimal(lastOrder.trade.price)}
                  {lastOrder.relatedOrders.length > 0
                    ? ` · ${lastOrder.relatedOrders.length} protection order${lastOrder.relatedOrders.length === 1 ? '' : 's'} active`
                    : ''}
                </>
              ) : (
                <>
                  {lastOrder.order.type === 'LIMIT' ? 'Limit' : 'Stop'} order
                  accepted at $
                  {decimal(
                    lastOrder.order.requestedPrice ??
                      lastOrder.order.stopPrice ??
                      '0',
                  )}
                </>
              )}
            </p>
          ) : null}
          <div className="mt-8 border-t border-[var(--border)] pt-5 text-xs text-[var(--muted)]">
            Signed in as
            <span className="mt-1 block truncate text-[var(--foreground)]">
              {user.email}
            </span>
          </div>
        </aside>
      </div>

      <section className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Portfolio
            </p>
            <h2 className="mt-2 text-lg font-semibold">Open position</h2>
          </div>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
            1× buying power
          </span>
        </div>
        <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
          {[
            [
              'Equity',
              formatCurrency(
                livePortfolio.equity,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Unrealized P/L',
              formatCurrency(
                livePortfolio.unrealizedPnl,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Cash balance',
              formatCurrency(
                livePortfolio.account.balance,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Exposure',
              formatCurrency(
                openPosition?.notional ?? '0',
                livePortfolio.account.baseCurrency,
              ),
            ],
          ].map(([label, value]) => (
            <div className="bg-[var(--surface)] px-4 py-4" key={label}>
              <p className="text-[11px] text-[var(--muted)]">{label}</p>
              <p
                className={`mt-1 font-mono text-sm ${
                  label === 'Unrealized P/L'
                    ? Number(livePortfolio.unrealizedPnl) >= 0
                      ? 'text-[var(--accent)]'
                      : 'text-rose-300'
                    : ''
                }`}
                data-testid={
                  label === 'Unrealized P/L' ? 'live-unrealized-pnl' : undefined
                }
              >
                {value}
              </p>
            </div>
          ))}
        </div>
        {openPosition ? (
          <div className="mt-4 grid gap-4 rounded-xl bg-[#0b0f14] p-4 text-sm sm:grid-cols-5">
            <div>
              <p className="text-xs text-[var(--muted)]">Instrument</p>
              <p className="mt-1 font-semibold">{openPosition.symbol}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Side</p>
              <p
                className={`mt-1 font-mono ${
                  Number(openPosition.signedQuantity) > 0
                    ? 'text-[var(--accent)]'
                    : 'text-rose-300'
                }`}
              >
                {Number(openPosition.signedQuantity) > 0 ? 'LONG' : 'SHORT'}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Quantity</p>
              <p className="mt-1 font-mono">
                {decimal(
                  String(Math.abs(Number(openPosition.signedQuantity))),
                  8,
                )}{' '}
                BTC
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Entry</p>
              <p className="mt-1 font-mono">
                ${decimal(openPosition.averageEntryPrice ?? '0')}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Mark</p>
              <p className="mt-1 font-mono">
                ${decimal(openPosition.markPrice)}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-xl bg-[#0b0f14] px-4 py-5 text-sm text-[var(--muted)]">
            No open BTC-USD position. Place a market order to start tracking
            live P/L.
          </p>
        )}
      </section>

      <section className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Orders
            </p>
            <h2 className="mt-2 text-lg font-semibold">Open orders</h2>
          </div>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
            {openOrders.length} active
          </span>
        </div>
        {openOrders.length > 0 ? (
          <div className="mt-5 space-y-2" data-testid="open-orders">
            {openOrders.map((order) => {
              const label = orderLabel(order);
              const triggerPrice =
                order.requestedPrice ?? order.stopPrice ?? '0';
              return (
                <div
                  className="grid items-center gap-3 rounded-xl bg-[#0b0f14] p-4 text-sm sm:grid-cols-[1.2fr_0.8fr_1fr_1fr_auto]"
                  key={order.id}
                >
                  <div>
                    <p className="font-semibold">{label}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {order.reduceOnly ? 'Reduce only · OCO' : 'Entry order'}
                    </p>
                  </div>
                  <p
                    className={`font-mono text-xs ${order.side === 'BUY' ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                  >
                    {order.side}
                  </p>
                  <div>
                    <p className="text-xs text-[var(--muted)]">Quantity</p>
                    <p className="mt-1 font-mono">{order.quantity} BTC</p>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--muted)]">
                      {order.type === 'STOP' ? 'Trigger' : 'Limit'}
                    </p>
                    <p className="mt-1 font-mono">${decimal(triggerPrice)}</p>
                  </div>
                  <button
                    aria-label={`Cancel ${label.toLowerCase()} order`}
                    className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-50"
                    disabled={cancellingOrderId === order.id}
                    onClick={() => void cancelPendingOrder(order.id)}
                    type="button"
                  >
                    {cancellingOrderId === order.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-5 rounded-xl bg-[#0b0f14] px-4 py-5 text-sm text-[var(--muted)]">
            No open orders. Limit, stop, and attached protection orders will
            appear here.
          </p>
        )}
      </section>
    </main>
  );
}
