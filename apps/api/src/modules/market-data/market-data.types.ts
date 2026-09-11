import {
  MARKET_SYMBOLS,
  type MarketCandle,
  type MarketDataSource,
  type MarketDataStatus,
  type MarketSymbol,
  type MarketTicker,
} from '@excess/shared-types';

export { MARKET_SYMBOLS };

export const MARKET_DATA_PROVIDER = Symbol('MARKET_DATA_PROVIDER');
export const CANDLE_GRANULARITY = 300 as const;

export const MARKET_INSTRUMENTS: Record<
  MarketSymbol,
  {
    baseCurrency: string;
    quoteCurrency: string;
    pricePrecision: number;
    quantityPrecision: number;
    tickSize: string;
    lotSize: string;
    minimumQuantity: string;
    defaultSpreadBps: string;
  }
> = {
  'BTC-USD': {
    baseCurrency: 'BTC',
    quoteCurrency: 'USD',
    pricePrecision: 2,
    quantityPrecision: 8,
    tickSize: '0.01',
    lotSize: '0.00000001',
    minimumQuantity: '0.00000001',
    defaultSpreadBps: '0',
  },
  'ETH-USD': {
    baseCurrency: 'ETH',
    quoteCurrency: 'USD',
    pricePrecision: 2,
    quantityPrecision: 8,
    tickSize: '0.01',
    lotSize: '0.00000001',
    minimumQuantity: '0.00000001',
    defaultSpreadBps: '0',
  },
};

export function isMarketSymbol(symbol: string): symbol is MarketSymbol {
  return MARKET_SYMBOLS.includes(symbol.toUpperCase() as MarketSymbol);
}

export type ProviderTicker = Omit<MarketTicker, 'source' | 'status'>;

export type MarketProviderEvent =
  | { type: 'ticker'; ticker: ProviderTicker }
  | { type: 'candle'; symbol: MarketSymbol; candle: MarketCandle }
  | { type: 'status'; status: MarketDataStatus };

export interface MarketDataProvider {
  readonly source: MarketDataSource;
  readonly status: MarketDataStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  fetchCandles(symbol: MarketSymbol, limit: number): Promise<MarketCandle[]>;
  fetchTicker(symbol: MarketSymbol): Promise<ProviderTicker>;
  subscribe(listener: (event: MarketProviderEvent) => void): () => void;
}
