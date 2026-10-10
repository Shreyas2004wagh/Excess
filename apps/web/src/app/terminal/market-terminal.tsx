'use client';

import { useAuth } from '@clerk/nextjs';
import type {
  CandleHistoryResponse,
  Leverage,
  MarketCandle,
  MarketDataStatus,
  MarketInstrumentSummary,
  MarketSymbol,
  MarketTicker,
  OrderPlacementRequest,
  OrderPlacementResponse,
  OrderSide,
  OrderSummary,
  OrderType,
  PortfolioSummary,
  PriceAlertDirection,
  PriceAlertSummary,
  TradeHistoryItem,
  TradeHistoryPage,
  TradingPerformanceSummary,
  UserProfileSummary,
} from '@excess/shared-types';
import { SIMULATED_SLIPPAGE_BPS } from '@excess/shared-types';
import type {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import Link from 'next/link';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io } from 'socket.io-client';

import {
  cancelPriceAlert,
  cancelOrder,
  createPriceAlert,
  ExcessApiError,
  getOpenOrders,
  getPortfolio,
  getPriceAlerts,
  getTradeHistory,
  getTradingPerformance,
  placeOrder,
} from '../../lib/excess-api';
import { formatCurrency } from '../../lib/format';
import { estimateMarketFill } from '../../lib/execution-preview';

import { WorkspaceShell } from '../../components/workspace-shell';
import { Icon } from '../../components/icon';
import { ClosePositionPanel } from './close-position-panel';

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

const chartTimeframes = [
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3_600 },
] as const;

function aggregateCandles(candles: MarketCandle[], seconds: number) {
  const buckets = new Map<number, MarketCandle>();
  for (const candle of candles) {
    const time = Math.floor(candle.time / seconds) * seconds;
    const current = buckets.get(time);
    if (!current) {
      buckets.set(time, { ...candle, time });
      continue;
    }
    current.high = String(Math.max(Number(current.high), Number(candle.high)));
    current.low = String(Math.min(Number(current.low), Number(candle.low)));
    current.close = candle.close;
    current.volume = String(Number(current.volume) + Number(candle.volume));
  }
  return [...buckets.values()];
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

function tradePurposeLabel(trade: TradeHistoryItem) {
  if (trade.purpose === 'STOP_LOSS') return 'Stop loss';
  if (trade.purpose === 'TAKE_PROFIT') return 'Take profit';
  if (trade.purpose === 'LIQUIDATION') return 'Liquidation';
  if (trade.purpose === 'POSITION_CLOSE') return 'Position close';
  return trade.orderType === 'MARKET'
    ? 'Market execution'
    : `${trade.orderType.toLowerCase()} execution`;
}

function suggestedPrice(
  type: OrderType,
  side: OrderSide,
  ticker: MarketTicker,
) {
  const executable = Number(side === 'BUY' ? ticker.ask : ticker.bid);
  const offset = executable * (type === 'LIMIT' ? -0.005 : 0.005);
  const direction = side === 'BUY' ? 1 : -1;
  return (executable + offset * direction).toFixed(2);
}

function suggestedAlertPrice(
  direction: PriceAlertDirection,
  ticker: MarketTicker,
) {
  const multiplier = direction === 'ABOVE' ? 1.01 : 0.99;
  return (Number(ticker.price) * multiplier).toFixed(2);
}

function portfolioAtMarket(
  portfolio: PortfolioSummary,
  tickers: Readonly<Record<MarketSymbol, MarketTicker>>,
): PortfolioSummary {
  const positions = portfolio.positions.map((position) => {
    const markPrice =
      tickers[position.symbol as MarketSymbol]?.price ?? position.markPrice;
    const mark = Number(markPrice);
    const quantity = Number(position.signedQuantity);
    const entry = Number(position.averageEntryPrice ?? markPrice);
    return {
      ...position,
      markPrice,
      notional: String(Math.abs(quantity) * mark),
      usedMargin: String((Math.abs(quantity) * mark) / position.leverage),
      unrealizedPnl: String((mark - entry) * quantity),
    };
  });
  const unrealizedPnl = positions.reduce(
    (total, position) => total + Number(position.unrealizedPnl),
    0,
  );
  const usedMargin = positions.reduce(
    (total, position) => total + Number(position.usedMargin),
    0,
  );
  const equity = Number(portfolio.account.balance) + unrealizedPnl;
  const marginLevel = usedMargin === 0 ? null : (equity / usedMargin) * 100;
  const riskState =
    marginLevel !== null && marginLevel <= 50
      ? 'LIQUIDATION'
      : marginLevel !== null && marginLevel <= 100
        ? 'MARGIN_WARNING'
        : 'HEALTHY';

  return {
    ...portfolio,
    equity: String(equity),
    unrealizedPnl: String(unrealizedPnl),
    usedMargin: String(usedMargin),
    freeMargin: String(equity - usedMargin),
    marginLevel: marginLevel === null ? null : String(marginLevel),
    riskState,
    positions,
  };
}

export function MarketTerminal({
  candlesBySymbol,
  instruments,
  openOrders: initialOpenOrders,
  portfolio: initialPortfolio,
  priceAlerts: initialPriceAlerts,
  performance: initialPerformance,
  tradeHistory: initialTradeHistory,
  user,
}: {
  candlesBySymbol: Record<MarketSymbol, CandleHistoryResponse>;
  instruments: MarketInstrumentSummary[];
  openOrders: OrderSummary[];
  portfolio: PortfolioSummary;
  priceAlerts: PriceAlertSummary[];
  performance: TradingPerformanceSummary;
  tradeHistory: TradeHistoryPage;
  user: UserProfileSummary;
}) {
  const { getToken } = useAuth();
  const chartContainer = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const pendingCandle = useRef<MarketCandle | null>(null);
  const latestChartCandle = useRef<MarketCandle | null>(null);
  const latestSourceCandle = useRef<MarketCandle | null>(null);
  const timeframeRef = useRef<(typeof chartTimeframes)[number]['seconds']>(300);
  const [timeframe, setTimeframe] =
    useState<(typeof chartTimeframes)[number]['seconds']>(300);
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('BTC-USD');
  const [tickers, setTickers] = useState<Record<MarketSymbol, MarketTicker>>(
    () =>
      Object.fromEntries(
        instruments.map((item) => [item.symbol, item.ticker]),
      ) as Record<MarketSymbol, MarketTicker>,
  );
  const instrument =
    instruments.find((item) => item.symbol === selectedSymbol) ??
    instruments[0]!;
  const candles = candlesBySymbol[instrument.symbol];
  timeframeRef.current = timeframe;
  const timeframeLabel =
    chartTimeframes.find((item) => item.seconds === timeframe)?.label ?? '5m';
  const ticker = tickers[instrument.symbol] ?? instrument.ticker;
  const [feedStatus, setFeedStatus] = useState<MarketDataStatus>(ticker.status);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [portfolio, setPortfolio] =
    useState<PortfolioSummary>(initialPortfolio);
  const [side, setSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [quantity, setQuantity] = useState('0.01');
  const [leverage, setLeverage] = useState<Leverage>(
    initialPortfolio.positions.find(
      (position) => position.symbol === selectedSymbol,
    )?.leverage ?? 1,
  );
  const [orderPrice, setOrderPrice] = useState(instrument.ticker.price);
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [openOrders, setOpenOrders] =
    useState<OrderSummary[]>(initialOpenOrders);
  const [priceAlerts, setPriceAlerts] =
    useState<PriceAlertSummary[]>(initialPriceAlerts);
  const [performance, setPerformance] =
    useState<TradingPerformanceSummary>(initialPerformance);
  const [tradeHistory, setTradeHistory] =
    useState<TradeHistoryPage>(initialTradeHistory);
  const [hasExpandedTradeHistory, setHasExpandedTradeHistory] = useState(false);
  const [isLoadingMoreTrades, setIsLoadingMoreTrades] = useState(false);
  const [tradeHistoryError, setTradeHistoryError] = useState<string | null>(
    null,
  );
  const [alertDirection, setAlertDirection] =
    useState<PriceAlertDirection>('ABOVE');
  const [alertPrice, setAlertPrice] = useState(
    suggestedAlertPrice('ABOVE', instrument.ticker),
  );
  const [isCreatingAlert, setIsCreatingAlert] = useState(false);
  const [cancellingAlertId, setCancellingAlertId] = useState<string | null>(
    null,
  );
  const [alertError, setAlertError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isClosingPosition, setIsClosingPosition] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(
    null,
  );
  const [orderError, setOrderError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<OrderPlacementResponse | null>(
    null,
  );

  const updateChartCandle = useCallback((candle: MarketCandle) => {
    const seconds = timeframeRef.current;
    const time = Math.floor(candle.time / seconds) * seconds;
    const current = latestChartCandle.current;
    if (current && time < current.time) return;
    const aggregated =
      current?.time === time
        ? {
            ...current,
            high: String(Math.max(Number(current.high), Number(candle.high))),
            low: String(Math.min(Number(current.low), Number(candle.low))),
            close: candle.close,
            volume: String(
              Number(current.volume) +
                Number(candle.volume) -
                (latestSourceCandle.current?.time === candle.time
                  ? Number(latestSourceCandle.current.volume)
                  : 0),
            ),
          }
        : { ...candle, time };
    latestChartCandle.current = aggregated;
    latestSourceCandle.current = candle;
    candleSeries.current?.update(chartCandle(aggregated));
  }, []);

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
            background: { type: ColorType.Solid, color: '#101318' },
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
          upColor: '#b6ed72',
          downColor: '#f38a9b',
          borderVisible: false,
          wickUpColor: '#b6ed72',
          wickDownColor: '#f38a9b',
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        chart.current = nextChart;
        candleSeries.current = nextSeries;
        const initialCandles = aggregateCandles(candles.items, timeframe);
        nextSeries.setData(initialCandles.map(chartCandle));
        latestChartCandle.current = initialCandles.at(-1) ?? null;
        latestSourceCandle.current = candles.items.at(-1) ?? null;
        if (pendingCandle.current) {
          updateChartCandle(pendingCandle.current);
        }
        nextChart.timeScale().fitContent();
      },
    );

    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      candleSeries.current = null;
      latestChartCandle.current = null;
    };
  }, [candles.items, timeframe, updateChartCandle]);

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
        setTickers((current) => ({
          ...current,
          [nextTicker.symbol]: nextTicker,
        }));
        if (nextTicker.symbol === instrument.symbol) {
          setFeedStatus(nextTicker.status);
        }
      });
      socket.on(
        'market:candle',
        (message: { symbol: string; candle: MarketCandle }) => {
          if (message.symbol !== instrument.symbol) return;
          pendingCandle.current = message.candle;
          updateChartCandle(message.candle);
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
  }, [getToken, instrument.symbol, updateChartCandle]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const token = await getToken();
      if (!token) return;
      const [
        nextPortfolio,
        nextOrders,
        nextAlerts,
        nextHistory,
        nextPerformance,
      ] = await Promise.all([
        getPortfolio(token),
        getOpenOrders(token),
        getPriceAlerts(token),
        getTradeHistory(token),
        getTradingPerformance(token),
      ]);
      if (!disposed) {
        setPortfolio(nextPortfolio);
        setOpenOrders(nextOrders.items);
        setPriceAlerts(nextAlerts.items);
        setTradeHistory((current) => {
          if (!hasExpandedTradeHistory) return nextHistory;
          const refreshedIds = new Set(
            nextHistory.items.map((trade) => trade.id),
          );
          return {
            items: [
              ...nextHistory.items,
              ...current.items.filter((trade) => !refreshedIds.has(trade.id)),
            ],
            nextCursor: current.nextCursor,
          };
        });
        setPerformance(nextPerformance);
      }
    };
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [getToken, hasExpandedTradeHistory]);

  const change = Number(ticker.change24h);
  const positive = change >= 0;
  const livePortfolio = portfolioAtMarket(portfolio, tickers);
  const openPosition = livePortfolio.positions.find(
    (position) => position.symbol === instrument.symbol,
  );
  const estimatedPrice =
    orderType === 'MARKET'
      ? estimateMarketFill(
          side === 'BUY' ? ticker.ask : ticker.bid,
          side,
          instrument.tickSize,
          instrument.pricePrecision,
        )
      : orderPrice;
  const parsedQuantity = Number(quantity);
  const parsedOrderPrice = Number(orderPrice);
  const orderIsValid =
    Number.isFinite(parsedQuantity) &&
    parsedQuantity >= Number(instrument.minimumQuantity) &&
    (orderType === 'MARKET' ||
      (Number.isFinite(parsedOrderPrice) && parsedOrderPrice > 0));
  const estimatedMargin =
    ((parsedQuantity || 0) * Number(estimatedPrice)) / leverage;
  const visibleOpenOrders = openOrders.filter(
    (order) => order.symbol === instrument.symbol,
  );
  const visibleAlerts = priceAlerts.filter(
    (alert) =>
      alert.symbol === instrument.symbol && alert.status !== 'CANCELLED',
  );

  function selectInstrument(symbol: MarketSymbol) {
    const nextInstrument = instruments.find((item) => item.symbol === symbol);
    if (!nextInstrument || symbol === instrument.symbol) return;
    const nextTicker = tickers[symbol] ?? nextInstrument.ticker;
    const nextPosition = portfolio.positions.find(
      (position) => position.symbol === symbol,
    );
    setSelectedSymbol(symbol);
    setFeedStatus(nextTicker.status);
    setQuantity(symbol === 'BTC-USD' ? '0.01' : '0.1');
    setLeverage(nextPosition?.leverage ?? 1);
    setOrderPrice(
      orderType === 'MARKET'
        ? nextTicker.price
        : suggestedPrice(orderType, side, nextTicker),
    );
    setAlertPrice(suggestedAlertPrice(alertDirection, nextTicker));
    setStopLossPrice('');
    setTakeProfitPrice('');
    setOrderError(null);
    setAlertError(null);
    setLastOrder(null);
    pendingCandle.current = null;
  }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !orderIsValid ||
      feedStatus !== 'LIVE' ||
      isClosingPosition ||
      isSubmitting
    )
      return;

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
        symbol: instrument.symbol,
        side,
        quantity,
        leverage,
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
      const [nextOrders, nextHistory, nextPerformance] = await Promise.all([
        getOpenOrders(token),
        getTradeHistory(token),
        getTradingPerformance(token),
      ]);
      setOpenOrders(nextOrders.items);
      setTradeHistory(nextHistory);
      setHasExpandedTradeHistory(false);
      setPerformance(nextPerformance);
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

  async function refreshAfterClose() {
    const token = await getToken();
    if (!token) return;
    const [nextPortfolio, nextOrders, nextHistory, nextPerformance] =
      await Promise.all([
        getPortfolio(token),
        getOpenOrders(token),
        getTradeHistory(token),
        getTradingPerformance(token),
      ]);
    setPortfolio(nextPortfolio);
    setOpenOrders(nextOrders.items);
    setTradeHistory(nextHistory);
    setHasExpandedTradeHistory(false);
    setPerformance(nextPerformance);
  }

  function positionClosed(response: OrderPlacementResponse) {
    setPortfolio(response.portfolio);
    setLastOrder(response);
    // The close is committed even if a secondary activity refresh fails.
    void refreshAfterClose().catch(() =>
      setTradeHistoryError(
        'Position closed. Recent activity could not be refreshed; the next automatic refresh will retry.',
      ),
    );
  }

  function changeOrderType(nextType: OrderType) {
    setOrderType(nextType);
    if (nextType !== 'MARKET') {
      setOrderPrice(suggestedPrice(nextType, side, ticker));
    }
  }

  async function cancelPendingOrder(orderId: string) {
    if (isClosingPosition) return;
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

  function changeAlertDirection(direction: PriceAlertDirection) {
    setAlertDirection(direction);
    setAlertPrice(suggestedAlertPrice(direction, ticker));
  }

  async function submitPriceAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreatingAlert(true);
    setAlertError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Your session expired. Sign in again.');
      const alert = await createPriceAlert(token, {
        symbol: instrument.symbol,
        direction: alertDirection,
        targetPrice: alertPrice,
      });
      setPriceAlerts((items) => [alert, ...items]);
      setAlertPrice(suggestedAlertPrice(alertDirection, ticker));
    } catch (error) {
      setAlertError(
        error instanceof Error
          ? error.message
          : 'The alert could not be created.',
      );
    } finally {
      setIsCreatingAlert(false);
    }
  }

  async function cancelActiveAlert(alertId: string) {
    setCancellingAlertId(alertId);
    setAlertError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Your session expired. Sign in again.');
      await cancelPriceAlert(token, alertId);
      setPriceAlerts((items) => items.filter((item) => item.id !== alertId));
    } catch (error) {
      setAlertError(
        error instanceof Error
          ? error.message
          : 'The alert could not be cancelled.',
      );
    } finally {
      setCancellingAlertId(null);
    }
  }

  async function loadMoreTrades() {
    if (!tradeHistory.nextCursor || isLoadingMoreTrades) return;
    setIsLoadingMoreTrades(true);
    setTradeHistoryError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Your session expired. Sign in again.');
      const nextPage = await getTradeHistory(token, {
        cursor: tradeHistory.nextCursor,
      });
      setTradeHistory((current) => ({
        items: [
          ...current.items,
          ...nextPage.items.filter(
            (trade) =>
              !current.items.some((existing) => existing.id === trade.id),
          ),
        ],
        nextCursor: nextPage.nextCursor,
      }));
      setHasExpandedTradeHistory(true);
    } catch (error) {
      setTradeHistoryError(
        error instanceof Error
          ? error.message
          : 'More executions could not be loaded.',
      );
    } finally {
      setIsLoadingMoreTrades(false);
    }
  }

  return (
    <WorkspaceShell
      active="terminal"
      admin={user.role === 'ADMIN'}
      status={
        <span
          className={`font-mono text-[10px] ${statusTone(feedStatus)}`}
          data-testid="feed-status"
        >
          ● {feedStatus}
        </span>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">MARKET WORKSPACE</p>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {ticker.source === 'COINBASE' ? 'Coinbase' : 'Test feed'} ·
            Simulated execution · USD
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-[10px] text-[var(--muted)]">Demo balance</p>
            <p className="mt-1 font-mono text-sm">
              {formatCurrency(
                livePortfolio.account.balance,
                livePortfolio.account.baseCurrency,
              )}
            </p>
          </div>
          <a className="button button-secondary" href="#order-ticket">
            Trade <Icon name="arrow" size={14} />
          </a>
        </div>
      </div>

      {streamError ? (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-2 text-sm text-amber-200">
          {streamError}
        </div>
      ) : null}

      {livePortfolio.riskState !== 'HEALTHY' ? (
        <div
          className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
            livePortfolio.riskState === 'LIQUIDATION'
              ? 'border-rose-300/30 bg-rose-300/10 text-rose-100'
              : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
          }`}
          data-testid="risk-alert"
          role="alert"
        >
          {livePortfolio.riskState === 'LIQUIDATION'
            ? 'Liquidation threshold reached. The risk engine is closing the position.'
            : 'Margin warning: margin level is at or below 100%. Review your exposure and consider reducing the position.'}
        </div>
      ) : null}

      <div className="terminal-market-strip" aria-label="Market watchlist">
        {instruments.map((item) => {
          const itemTicker = tickers[item.symbol] ?? item.ticker;
          const itemPositive = Number(itemTicker.change24h) >= 0;
          const selected = item.symbol === instrument.symbol;
          return (
            <button
              aria-pressed={selected}
              className={`flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-left transition sm:p-4 ${selected ? 'border-[var(--accent)]/35 bg-[var(--accent)]/5' : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--muted)]'}`}
              data-testid={`instrument-${item.symbol}`}
              key={item.symbol}
              onClick={() => selectInstrument(item.symbol)}
              disabled={isClosingPosition || isSubmitting}
              type="button"
            >
              <span className="flex items-center gap-3">
                <span
                  className={`asset-avatar ${item.baseCurrency === 'ETH' ? 'eth' : ''}`}
                >
                  {item.baseCurrency === 'BTC' ? '₿' : 'Ξ'}
                </span>
                <span>
                  <span className="block text-sm font-medium">
                    {item.displayName.replace('/', ' / ')}
                  </span>
                  <span className="mt-1 block text-[10px] text-[var(--muted)]">
                    {item.baseCurrency === 'BTC' ? 'Bitcoin' : 'Ethereum'} ·
                    Demo CFD
                  </span>
                </span>
              </span>
              <span>
                <span className="block font-mono text-sm">
                  ${decimal(itemTicker.price)}
                </span>
                <span
                  className={`mt-1 block font-mono text-[10px] sm:text-right ${itemPositive ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                >
                  {itemPositive ? '+' : ''}
                  {decimal(itemTicker.change24h)}%{' '}
                  <span className="text-[var(--muted)]">24h</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="terminal-trade-grid">
        <section className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold">
                  {instrument.displayName.replace('/', ' / ')}
                </h1>
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
            <div className="flex flex-wrap items-center gap-2">
              <div
                aria-label="Chart timeframe"
                className="flex rounded-lg border border-[var(--border)] p-0.5"
                role="group"
              >
                {chartTimeframes.map((item) => (
                  <button
                    aria-pressed={timeframe === item.seconds}
                    className={`min-h-7 rounded-md px-2 text-[11px] font-medium transition ${timeframe === item.seconds ? 'bg-[var(--accent)] text-[#10130d]' : 'text-[var(--muted)] hover:text-[var(--foreground)]'}`}
                    key={item.seconds}
                    onClick={() => setTimeframe(item.seconds)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <button
                className="button button-secondary !min-h-8 !px-2 !py-1 !text-[10px]"
                onClick={() => chart.current?.timeScale().fitContent()}
                type="button"
                aria-label="Reset chart view"
              >
                <Icon name="refresh" size={14} />
                Reset view
              </button>
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

          <div
            className="terminal-chart"
            ref={chartContainer}
            role="img"
            aria-label={`${instrument.symbol} live ${timeframeLabel} candlestick chart`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--muted)]">
            <span>
              {aggregateCandles(candles.items, timeframe).length}{' '}
              {timeframeLabel} candles · Volume {decimal(ticker.volume24h, 4)}{' '}
              {instrument.baseCurrency}
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

        <aside className="terminal-ticket panel p-5" id="order-ticket">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Order ticket</h2>
            <span className="rounded-full bg-white/5 px-2 py-1 font-mono text-[10px] text-[var(--muted)]">
              DEMO
            </span>
          </div>
          <form onSubmit={submitOrder}>
            <div className="mt-6 grid grid-cols-2 rounded-xl bg-[#101318] p-1 text-center text-sm">
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
              <div className="mt-2 grid grid-cols-3 rounded-xl bg-[#101318] p-1 text-xs">
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
              Quantity ({instrument.baseCurrency})
              <input
                className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#101318] px-4 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
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
            <fieldset className="mt-4">
              <legend className="text-xs text-[var(--muted)]">Leverage</legend>
              <div className="mt-2 grid grid-cols-4 rounded-xl bg-[#101318] p-1 text-xs">
                {([1, 2, 5, 10] as const).map((nextLeverage) => (
                  <button
                    aria-pressed={leverage === nextLeverage}
                    className={`rounded-lg py-2.5 transition ${
                      leverage === nextLeverage
                        ? 'bg-white/10 text-[var(--foreground)]'
                        : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                    }`}
                    key={nextLeverage}
                    onClick={() => setLeverage(nextLeverage)}
                    type="button"
                  >
                    {nextLeverage}×
                  </button>
                ))}
              </div>
              {openPosition && openPosition.leverage !== leverage ? (
                <p className="mt-2 text-[11px] leading-4 text-amber-200">
                  Adding to this position requires {openPosition.leverage}×.
                  Closing orders keep its current leverage.
                </p>
              ) : null}
            </fieldset>
            {orderType !== 'MARKET' ? (
              <label className="mt-4 block text-xs text-[var(--muted)]">
                {orderType === 'LIMIT' ? 'Limit price' : 'Stop price'} (USD)
                <input
                  className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#101318] px-4 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
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
            <details className="optional-protection">
              <summary>Add stop loss / take profit</summary>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block text-xs text-[var(--muted)]">
                  Stop loss (USD)
                  <input
                    className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#101318] px-3 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
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
                    className="mt-2 block w-full rounded-xl border border-[var(--border)] bg-[#101318] px-3 py-3 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
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
            </details>
            <div className="mt-5 space-y-3 text-xs">
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
                <span className="text-[var(--muted)]">
                  {orderType === 'MARKET'
                    ? 'Estimated fill'
                    : orderType === 'STOP'
                      ? 'Stop trigger'
                      : 'Limit price'}
                </span>
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
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Required margin</span>
                <span className="font-mono">
                  ${decimal(String(estimatedMargin))}
                </span>
              </div>
            </div>
            <button
              className={`mt-6 w-full rounded-xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-[var(--muted)] ${
                side === 'BUY'
                  ? 'bg-[var(--accent)] text-[#0b1207]'
                  : 'bg-rose-300 text-[#16090c]'
              }`}
              disabled={
                isSubmitting ||
                isClosingPosition ||
                !orderIsValid ||
                feedStatus !== 'LIVE'
              }
              type="submit"
            >
              {isSubmitting
                ? orderType === 'MARKET'
                  ? 'Executing…'
                  : 'Submitting…'
                : `${side === 'BUY' ? 'Buy' : 'Sell'} ${instrument.baseCurrency} · ${orderType.toLowerCase()}`}
            </button>
          </form>
          <p className="mt-3 text-[10px] leading-5 text-[var(--muted)]">
            {feedStatus !== 'LIVE'
              ? 'Orders are paused until a live quote is available.'
              : !orderIsValid
                ? 'Enter a valid quantity and the required order price to continue.'
                : `Virtual funds only. Market and triggered stop fills include the quoted spread plus ${SIMULATED_SLIPPAGE_BPS} bps simulated adverse slippage; limit fills do not slip. Estimates can change with the quote.`}
          </p>
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
                  Filled {lastOrder.trade.quantity} {instrument.baseCurrency} at
                  ${decimal(lastOrder.trade.price)}
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

      <nav className="terminal-section-nav" aria-label="Terminal sections">
        <a href="#positions">Positions</a>
        <a href="#open-orders">Open orders</a>
        <a href="#price-alerts">Price alerts</a>
        <a href="#trading-activity">Trading activity</a>
        <Link href="/reports">
          Full reports <Icon name="diagonal" size={12} />
        </Link>
      </nav>
      <section id="positions" className="mt-3 panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Portfolio
            </p>
            <h2 className="mt-2 text-lg font-semibold">Open position</h2>
          </div>
          <span
            className={`rounded-full border px-3 py-1 font-mono text-[10px] ${
              livePortfolio.riskState === 'HEALTHY'
                ? 'border-[var(--border)] text-[var(--muted)]'
                : livePortfolio.riskState === 'MARGIN_WARNING'
                  ? 'border-amber-300/30 text-amber-200'
                  : 'border-rose-300/30 text-rose-200'
            }`}
            data-testid="risk-state"
          >
            {livePortfolio.riskState.replace('_', ' ')}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 xl:grid-cols-6">
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
              'Used margin',
              formatCurrency(
                livePortfolio.usedMargin,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Free margin',
              formatCurrency(
                livePortfolio.freeMargin,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Margin level',
              livePortfolio.marginLevel === null
                ? '—'
                : `${decimal(livePortfolio.marginLevel)}%`,
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
                  label === 'Unrealized P/L'
                    ? 'live-unrealized-pnl'
                    : label === 'Used margin'
                      ? 'used-margin'
                      : label === 'Margin level'
                        ? 'margin-level'
                        : undefined
                }
              >
                {value}
              </p>
            </div>
          ))}
        </div>
        {openPosition ? (
          <div className="mt-4 grid grid-cols-2 gap-4 break-words rounded-xl bg-[#101318] p-4 text-sm sm:grid-cols-3 xl:grid-cols-6">
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
                {instrument.baseCurrency}
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
            <div>
              <p className="text-xs text-[var(--muted)]">Leverage / margin</p>
              <p className="mt-1 font-mono">
                {openPosition.leverage}× · ${decimal(openPosition.usedMargin)}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-xl bg-[#101318] px-4 py-5 text-sm text-[var(--muted)]">
            No open {instrument.symbol} position. Place a market order to start
            tracking live P/L.
          </p>
        )}
        <ClosePositionPanel
          key={instrument.symbol}
          position={openPosition}
          ticker={{ ...ticker, status: feedStatus }}
          tickSize={instrument.tickSize}
          pricePrecision={instrument.pricePrecision}
          pendingEntries={
            visibleOpenOrders.filter((order) => order.purpose === 'ENTRY')
              .length
          }
          blocked={isSubmitting || cancellingOrderId !== null}
          onBusyChange={setIsClosingPosition}
          onClosed={positionClosed}
          onRefresh={refreshAfterClose}
        />
      </section>

      <section
        id="trading-activity"
        className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Performance
            </p>
            <h2 className="mt-2 text-lg font-semibold">Trading activity</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              All-time execution and realized results across your demo account.
            </p>
          </div>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
            {performance.activePositions} open position
            {performance.activePositions === 1 ? '' : 's'}
          </span>
        </div>

        <div
          className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 xl:grid-cols-6"
          data-testid="trading-performance"
        >
          {[
            [
              'Net realized P/L',
              formatCurrency(
                performance.netRealizedPnl,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Win rate',
              performance.winRate === null
                ? '—'
                : `${decimal(performance.winRate)}%`,
            ],
            ['Executions', String(performance.totalTrades)],
            [
              'Wins / losses',
              `${performance.winningTrades} / ${performance.losingTrades}`,
            ],
            [
              'Traded notional',
              formatCurrency(
                performance.tradedNotional,
                livePortfolio.account.baseCurrency,
              ),
            ],
            [
              'Average execution',
              formatCurrency(
                performance.averageTradeNotional,
                livePortfolio.account.baseCurrency,
              ),
            ],
          ].map(([label, value]) => (
            <div className="bg-[var(--surface)] px-4 py-4" key={label}>
              <p className="text-[11px] text-[var(--muted)]">{label}</p>
              <p
                className={`mt-1 font-mono text-sm ${
                  label === 'Net realized P/L'
                    ? Number(performance.netRealizedPnl) >= 0
                      ? 'text-[var(--accent)]'
                      : 'text-rose-300'
                    : ''
                }`}
              >
                {value}
              </p>
            </div>
          ))}
        </div>

        {tradeHistory.items.length > 0 ? (
          <div
            className="mt-5 max-h-[440px] space-y-2 overflow-y-auto pr-1"
            data-testid="trade-history"
            role="region"
            aria-label="Recent execution history"
            tabIndex={0}
          >
            {tradeHistory.items.map((trade) => (
              <div
                className="grid items-center gap-3 rounded-xl bg-[#101318] p-4 text-sm sm:grid-cols-[1.1fr_0.8fr_1.2fr_0.7fr_1fr]"
                key={trade.id}
              >
                <div>
                  <p className="font-semibold">{trade.symbol}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {new Date(trade.executedAt).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p
                    className={`font-mono text-xs ${trade.side === 'BUY' ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                  >
                    {trade.side}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {tradePurposeLabel(trade)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--muted)]">Execution</p>
                  <p className="mt-1 font-mono">
                    {trade.quantity} @ ${decimal(trade.price)}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">
                    Spread {decimal(trade.spreadBps, 3)} bps · Slippage{' '}
                    {decimal(trade.slippageBps, 3)} bps
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--muted)]">Leverage</p>
                  <p className="mt-1 font-mono">{trade.leverage}×</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-xs text-[var(--muted)]">Realized P/L</p>
                  <p
                    className={`mt-1 font-mono ${
                      trade.realizedPnl === null
                        ? 'text-[var(--muted)]'
                        : Number(trade.realizedPnl) >= 0
                          ? 'text-[var(--accent)]'
                          : 'text-rose-300'
                    }`}
                  >
                    {trade.realizedPnl === null
                      ? '—'
                      : formatCurrency(
                          trade.realizedPnl,
                          livePortfolio.account.baseCurrency,
                        )}
                  </p>
                </div>
              </div>
            ))}
            {tradeHistory.nextCursor ? (
              <button
                className="mt-3 w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)] transition hover:border-[var(--accent)]/30 hover:text-[var(--foreground)] disabled:cursor-wait disabled:opacity-50"
                disabled={isLoadingMoreTrades}
                onClick={() => void loadMoreTrades()}
                type="button"
              >
                {isLoadingMoreTrades ? 'Loading executions…' : 'Load more'}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-5 rounded-xl bg-[#101318] px-4 py-5 text-sm text-[var(--muted)]">
            No executions yet. Filled orders will appear here with their
            realized result.
          </p>
        )}
        {tradeHistoryError ? (
          <p className="mt-3 text-sm text-rose-200" role="alert">
            {tradeHistoryError}
          </p>
        ) : null}
      </section>

      <section
        id="open-orders"
        className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Orders
            </p>
            <h2 className="mt-2 text-lg font-semibold">Open orders</h2>
          </div>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 font-mono text-[10px] text-[var(--muted)]">
            {visibleOpenOrders.length} active
          </span>
        </div>
        {visibleOpenOrders.length > 0 ? (
          <div className="mt-5 space-y-2" data-testid="open-orders">
            {visibleOpenOrders.map((order) => {
              const label = orderLabel(order);
              const triggerPrice =
                order.requestedPrice ?? order.stopPrice ?? '0';
              return (
                <div
                  className="grid items-center gap-3 rounded-xl bg-[#101318] p-4 text-sm sm:grid-cols-[1.2fr_0.8fr_1fr_1fr_auto]"
                  key={order.id}
                >
                  <div>
                    <p className="font-semibold">{label}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {order.reduceOnly ? 'Reduce only · OCO' : 'Entry order'} ·{' '}
                      {order.leverage}×
                    </p>
                  </div>
                  <p
                    className={`font-mono text-xs ${order.side === 'BUY' ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                  >
                    {order.side}
                  </p>
                  <div>
                    <p className="text-xs text-[var(--muted)]">Quantity</p>
                    <p className="mt-1 font-mono">
                      {order.quantity} {instrument.baseCurrency}
                    </p>
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
                    disabled={
                      isClosingPosition || cancellingOrderId === order.id
                    }
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
          <p className="mt-5 rounded-xl bg-[#101318] px-4 py-5 text-sm text-[var(--muted)]">
            No open orders. Limit, stop, and attached protection orders will
            appear here.
          </p>
        )}
      </section>

      <section
        id="price-alerts"
        className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Monitoring
            </p>
            <h2 className="mt-2 text-lg font-semibold">Price alerts</h2>
            <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
              Trigger once when the live {instrument.symbol} price crosses your
              target.
            </p>
          </div>
          <form
            className="grid w-full gap-3 sm:grid-cols-[auto_minmax(180px,1fr)_auto] xl:w-auto"
            onSubmit={submitPriceAlert}
          >
            <fieldset>
              <legend className="sr-only">Alert direction</legend>
              <div className="grid grid-cols-2 rounded-xl bg-[#101318] p-1 text-xs">
                {(['ABOVE', 'BELOW'] as const).map((direction) => (
                  <button
                    aria-pressed={alertDirection === direction}
                    className={`rounded-lg px-4 py-2.5 capitalize transition ${
                      alertDirection === direction
                        ? 'bg-white/10 text-[var(--foreground)]'
                        : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                    }`}
                    key={direction}
                    onClick={() => changeAlertDirection(direction)}
                    type="button"
                  >
                    {direction.toLowerCase()}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="sr-only" htmlFor="alert-price">
              Alert price (USD)
            </label>
            <input
              className="rounded-xl border border-[var(--border)] bg-[#101318] px-4 py-2.5 font-mono text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]/60"
              id="alert-price"
              inputMode="decimal"
              min={instrument.tickSize}
              onChange={(event) => setAlertPrice(event.target.value)}
              required
              step={instrument.tickSize}
              type="number"
              value={alertPrice}
            />
            <button
              className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[#0b1207] transition disabled:cursor-wait disabled:opacity-50"
              disabled={isCreatingAlert || feedStatus !== 'LIVE'}
              type="submit"
            >
              {isCreatingAlert ? 'Creating…' : 'Create alert'}
            </button>
          </form>
        </div>
        {alertError ? (
          <p
            className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-200"
            role="alert"
          >
            {alertError}
          </p>
        ) : null}
        {visibleAlerts.length > 0 ? (
          <div className="mt-5 space-y-2" data-testid="price-alerts">
            {visibleAlerts.map((alert) => (
              <div
                className="grid items-center gap-3 rounded-xl bg-[#101318] p-4 text-sm sm:grid-cols-[1.2fr_1fr_1fr_auto]"
                key={alert.id}
              >
                <div>
                  <p className="font-semibold">
                    {alert.symbol} {alert.direction.toLowerCase()} $
                    {decimal(alert.targetPrice)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Created {new Date(alert.createdAt).toLocaleString()}
                  </p>
                </div>
                <p
                  className={`font-mono text-xs ${
                    alert.status === 'TRIGGERED'
                      ? 'text-[var(--accent)]'
                      : 'text-sky-300'
                  }`}
                >
                  {alert.status}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {alert.status === 'TRIGGERED'
                    ? `Triggered at $${decimal(alert.triggeredPrice ?? alert.targetPrice)}`
                    : 'Watching live price'}
                  {alert.deliveryStatus
                    ? ` · Delivery ${alert.deliveryStatus.toLowerCase()}`
                    : ''}
                </p>
                {alert.status === 'ACTIVE' ? (
                  <button
                    aria-label={`Cancel ${alert.direction.toLowerCase()} price alert`}
                    className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-50"
                    disabled={cancellingAlertId === alert.id}
                    onClick={() => void cancelActiveAlert(alert.id)}
                    type="button"
                  >
                    {cancellingAlertId === alert.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : (
                  <span className="text-right font-mono text-[10px] text-[var(--muted)]">
                    ONE-SHOT
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-5 rounded-xl bg-[#101318] px-4 py-5 text-sm text-[var(--muted)]">
            No active or triggered alerts yet.
          </p>
        )}
      </section>
    </WorkspaceShell>
  );
}
