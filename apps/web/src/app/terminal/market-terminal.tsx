'use client';

import { UserButton, useAuth } from '@clerk/nextjs';
import type {
  CandleHistoryResponse,
  DemoAccountSummary,
  MarketCandle,
  MarketDataStatus,
  MarketInstrumentSummary,
  MarketTicker,
  UserProfileSummary,
} from '@excess/shared-types';
import type {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

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

export function MarketTerminal({
  account,
  candles,
  instrument,
  user,
}: {
  account: DemoAccountSummary;
  candles: CandleHistoryResponse;
  instrument: MarketInstrumentSummary;
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

  const change = Number(ticker.change24h);
  const positive = change >= 0;

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
              {formatCurrency(account.balance, account.baseCurrency)}
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
                  Bitcoin · Spot
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
                  SPOT
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
          <div className="mt-6 grid grid-cols-2 rounded-xl bg-[#0b0f14] p-1 text-center text-sm">
            <span className="rounded-lg bg-[var(--accent)]/10 py-2 text-[var(--accent)]">
              Buy
            </span>
            <span className="py-2 text-[var(--muted)]">Sell</span>
          </div>
          <label className="mt-6 block text-xs text-[var(--muted)]">
            Order type
            <span className="mt-2 block rounded-xl border border-[var(--border)] bg-[#0b0f14] px-4 py-3 text-sm text-[var(--foreground)]">
              Market
            </span>
          </label>
          <label className="mt-4 block text-xs text-[var(--muted)]">
            Quantity (BTC)
            <span className="mt-2 block rounded-xl border border-[var(--border)] bg-[#0b0f14] px-4 py-3 font-mono text-sm text-[var(--muted)]">
              0.00000000
            </span>
          </label>
          <div className="mt-6 space-y-3 border-y border-[var(--border)] py-5 text-xs">
            <div className="flex justify-between">
              <span className="text-[var(--muted)]">Available</span>
              <span className="font-mono">
                {formatCurrency(account.balance, account.baseCurrency)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--muted)]">Estimated price</span>
              <span className="font-mono">${decimal(ticker.ask)}</span>
            </div>
          </div>
          <button
            className="mt-6 w-full cursor-not-allowed rounded-xl bg-white/5 px-4 py-3 text-sm text-[var(--muted)]"
            disabled
            type="button"
          >
            Order entry coming next
          </button>
          <p className="mt-4 text-center text-xs leading-5 text-[var(--muted)]">
            Live prices are active. Execution remains disabled until the trading
            engine milestone.
          </p>
          <div className="mt-8 border-t border-[var(--border)] pt-5 text-xs text-[var(--muted)]">
            Signed in as
            <span className="mt-1 block truncate text-[var(--foreground)]">
              {user.email}
            </span>
          </div>
        </aside>
      </div>
    </main>
  );
}
