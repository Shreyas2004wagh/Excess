import type {
  MarketCandle,
  MarketDataSource,
  MarketDataStatus,
  MarketTicker,
} from '@excess/shared-types';

export const MARKET_DATA_PROVIDER = Symbol('MARKET_DATA_PROVIDER');
export const MARKET_SYMBOL = 'BTC-USD';
export const CANDLE_GRANULARITY = 300 as const;

export type ProviderTicker = Omit<MarketTicker, 'source' | 'status'>;

export type MarketProviderEvent =
  | { type: 'ticker'; ticker: ProviderTicker }
  | { type: 'candle'; symbol: string; candle: MarketCandle }
  | { type: 'status'; status: MarketDataStatus };

export interface MarketDataProvider {
  readonly source: MarketDataSource;
  readonly status: MarketDataStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  fetchCandles(limit: number): Promise<MarketCandle[]>;
  fetchTicker(): Promise<ProviderTicker>;
  subscribe(listener: (event: MarketProviderEvent) => void): () => void;
}
