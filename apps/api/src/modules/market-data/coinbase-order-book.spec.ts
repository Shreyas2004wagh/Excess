import { describe, expect, it } from '@jest/globals';

import { CoinbaseOrderBook } from './coinbase-order-book.js';

const timestamp = '2026-10-14T12:00:00.000Z';
type Update = {
  side: 'bid' | 'offer';
  price_level: string;
  new_quantity: string;
};
const bid = (price: string, quantity: string): Update => ({
  side: 'bid',
  price_level: price,
  new_quantity: quantity,
});
const ask = (price: string, quantity: string): Update => ({
  side: 'offer',
  price_level: price,
  new_quantity: quantity,
});
const message = (
  sequence: number,
  type: 'snapshot' | 'update',
  updates: Update[],
  symbol = 'BTC-USD',
) =>
  JSON.stringify({
    channel: 'l2_data',
    timestamp,
    sequence_num: sequence,
    events: [{ type, product_id: symbol, updates }],
  });

describe('Coinbase order book reconstruction', () => {
  it('publishes decimal strings with bids descending and asks ascending', () => {
    const book = new CoinbaseOrderBook();
    expect(
      book.apply(
        message(0, 'snapshot', [
          bid('99', '3'),
          bid('100', '2'),
          ask('102', '4'),
          ask('101', '1'),
        ]),
      ),
    ).toBe('updated');
    expect(book.takeSnapshots()).toEqual([
      {
        symbol: 'BTC-USD',
        bids: [
          { price: '100', quantity: '2' },
          { price: '99', quantity: '3' },
        ],
        asks: [
          { price: '101', quantity: '1' },
          { price: '102', quantity: '4' },
        ],
        updatedAt: timestamp,
      },
    ]);
    expect(book.takeSnapshots()).toEqual([]);
  });

  it('replaces sizes instead of adding deltas and removes zero-size levels', () => {
    const book = new CoinbaseOrderBook();
    book.apply(
      message(0, 'snapshot', [
        bid('100.00', '2'),
        bid('99', '3'),
        ask('101', '1'),
      ]),
    );
    book.takeSnapshots();
    book.apply(message(1, 'update', [bid('100', '0.25'), bid('99.0', '0')]));
    expect(book.takeSnapshots()?.[0]?.bids).toEqual([
      { price: '100', quantity: '0.25' },
    ]);
  });

  it('retains deeper levels when better levels are removed', () => {
    const book = new CoinbaseOrderBook();
    book.apply(
      message(0, 'snapshot', [
        bid('100', '1'),
        bid('99', '2'),
        bid('98', '3'),
        ask('101', '1'),
      ]),
    );
    expect(book.takeSnapshots(2)?.[0]?.bids).toHaveLength(2);
    book.apply(message(1, 'update', [bid('100', '0'), bid('99', '0')]));
    expect(book.takeSnapshots(2)?.[0]?.bids).toEqual([
      { price: '98', quantity: '3' },
    ]);
  });

  it('ignores duplicates and out-of-order messages, then resyncs on a gap', () => {
    const book = new CoinbaseOrderBook();
    book.apply(message(0, 'snapshot', [bid('100', '1'), ask('101', '1')]));
    book.apply(message(1, 'update', [bid('100', '2')]));
    expect(book.apply(message(1, 'update', [bid('100', '20')]))).toBe(
      'ignored',
    );
    expect(book.apply(message(0, 'update', [bid('100', '30')]))).toBe(
      'ignored',
    );
    expect(book.takeSnapshots()?.[0]?.bids[0]?.quantity).toBe('2');
    expect(book.apply(message(3, 'update', [bid('100', '4')]))).toBe('resync');
    expect(book.takeSnapshots()).toEqual([]);
    book.apply(message(0, 'snapshot', [bid('90', '1'), ask('91', '1')]));
    expect(book.takeSnapshots()?.[0]?.bids[0]?.price).toBe('90');
  });

  it('isolates instruments while following the Level 2 channel sequence', () => {
    const book = new CoinbaseOrderBook();
    book.apply(message(0, 'snapshot', [bid('100', '1'), ask('101', '1')]));
    book.apply(
      message(1, 'snapshot', [bid('10', '5'), ask('11', '5')], 'ETH-USD'),
    );
    book.apply(message(2, 'update', [bid('100', '7')]));
    const snapshots = book.takeSnapshots();
    expect(
      snapshots?.find((item) => item.symbol === 'BTC-USD')?.bids[0]?.quantity,
    ).toBe('7');
    expect(
      snapshots?.find((item) => item.symbol === 'ETH-USD')?.bids[0]?.quantity,
    ).toBe('5');
  });

  it('requires a snapshot before updates and clears data on reset', () => {
    const book = new CoinbaseOrderBook();
    expect(book.apply(message(0, 'update', [bid('100', '1')]))).toBe('resync');
    book.apply(message(0, 'snapshot', [bid('100', '1')]));
    book.reset();
    expect(book.takeSnapshots()).toEqual([]);
    expect(book.apply(message(0, 'update', [bid('100', '1')]))).toBe('resync');
  });

  it('counts other channels between depth updates on the same connection', () => {
    const book = new CoinbaseOrderBook();
    book.apply(message(0, 'snapshot', [bid('100', '1'), ask('101', '1')]));
    expect(
      book.apply(JSON.stringify({ channel: 'ticker', sequence_num: 1 })),
    ).toBe('ignored');
    expect(
      book.apply(JSON.stringify({ channel: 'heartbeats', sequence_num: 2 })),
    ).toBe('ignored');
    expect(book.apply(message(3, 'update', [bid('100', '5')]))).toBe('updated');
    expect(book.takeSnapshots()?.[0]?.bids[0]?.quantity).toBe('5');
  });

  it('discards malformed Level 2 updates and ignores unrelated channels', () => {
    const book = new CoinbaseOrderBook();
    book.apply(message(0, 'snapshot', [bid('100', '1')]));
    expect(book.apply(message(1, 'update', [bid('100', '-5')]))).toBe('resync');
    expect(book.takeSnapshots()).toEqual([]);
    expect(book.apply('invalid json')).toBe('ignored');
    expect(
      book.apply(JSON.stringify({ channel: 'heartbeats', sequence_num: 99 })),
    ).toBe('ignored');
  });

  it('rejects crossed books instead of presenting invalid depth', () => {
    const book = new CoinbaseOrderBook();
    book.apply(message(0, 'snapshot', [bid('102', '1'), ask('101', '1')]));
    expect(book.takeSnapshots()).toBeNull();
    expect(book.takeSnapshots()).toEqual([]);
  });
});
