import { describe, expect, it } from '@jest/globals';

import { parseCoinbaseMessage } from './coinbase-market-data.provider.js';

describe('parseCoinbaseMessage', () => {
  it('normalizes ticker updates as decimal strings', () => {
    const events = parseCoinbaseMessage(
      JSON.stringify({
        channel: 'ticker',
        timestamp: '2026-09-01T12:00:00.000Z',
        events: [
          {
            tickers: [
              {
                product_id: 'BTC-USD',
                price: '65001.25',
                best_bid: '65001.24',
                best_ask: '65001.26',
                price_percent_chg_24_h: '1.25',
                high_24_h: '66000',
                low_24_h: '64000',
                volume_24_h: '1250.125',
              },
            ],
          },
        ],
      }),
    );

    expect(events).toEqual([
      {
        type: 'ticker',
        ticker: {
          symbol: 'BTC-USD',
          price: '65001.25',
          bid: '65001.24',
          ask: '65001.26',
          change24h: '1.25',
          high24h: '66000',
          low24h: '64000',
          volume24h: '1250.125',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    ]);
  });

  it('normalizes supported candle updates and ignores unsupported input', () => {
    expect(
      parseCoinbaseMessage(
        JSON.stringify({
          channel: 'candles',
          events: [
            {
              candles: [
                {
                  product_id: 'BTC-USD',
                  start: '1788264000',
                  open: '65000',
                  high: '65100',
                  low: '64950',
                  close: '65075',
                  volume: '12.5',
                },
                {
                  product_id: 'ETH-USD',
                  start: '1788264000',
                  open: '3500',
                  high: '3520',
                  low: '3490',
                  close: '3515',
                  volume: '120.5',
                },
                {
                  product_id: 'SOL-USD',
                  start: '1788264000',
                  open: '100',
                  high: '101',
                  low: '99',
                  close: '100.5',
                  volume: '200',
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'candle',
        symbol: 'BTC-USD',
        candle: {
          time: 1788264000,
          open: '65000',
          high: '65100',
          low: '64950',
          close: '65075',
          volume: '12.5',
        },
      },
      {
        type: 'candle',
        symbol: 'ETH-USD',
        candle: {
          time: 1788264000,
          open: '3500',
          high: '3520',
          low: '3490',
          close: '3515',
          volume: '120.5',
        },
      },
    ]);
    expect(parseCoinbaseMessage('not-json')).toEqual([]);
  });
});
