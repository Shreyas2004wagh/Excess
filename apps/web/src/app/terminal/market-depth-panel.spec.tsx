import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MarketOrderBook } from '@excess/shared-types';

import { MarketDepthPanel } from './market-depth-panel';

const book: MarketOrderBook = {
  symbol: 'BTC-USD',
  source: 'COINBASE',
  status: 'LIVE',
  updatedAt: '2026-10-14T12:00:00.000Z',
  bids: [
    { price: '100', quantity: '0.1' },
    { price: '99', quantity: '0.2' },
  ],
  asks: [{ price: '101', quantity: '0.5' }],
};

describe('Market depth panel', () => {
  it('presents spread, cumulative size, and both sides of the book', () => {
    const html = renderToStaticMarkup(
      <MarketDepthPanel
        book={book}
        symbol="BTC-USD"
        baseCurrency="BTC"
        source="COINBASE"
        feedStatus="LIVE"
      />,
    );
    expect(html).toContain('Bids for BTC-USD');
    expect(html).toContain('Asks for BTC-USD');
    expect(html).toContain('$1.00');
    expect(html).toContain('0.3000');
    expect(html).toContain('>Live</span>');
  });

  it('shows reconnecting and offline states without inventing levels', () => {
    const html = renderToStaticMarkup(
      <MarketDepthPanel
        book={null}
        symbol="ETH-USD"
        baseCurrency="ETH"
        source="SIMULATED"
        feedStatus="OFFLINE"
      />,
    );
    expect(html).toContain('Simulated market');
    expect(html).toContain('feed reconnects');
    expect(html).not.toContain('<table');
  });

  it('labels retained stale snapshots explicitly', () => {
    const html = renderToStaticMarkup(
      <MarketDepthPanel
        book={{ ...book, status: 'STALE' }}
        symbol="BTC-USD"
        baseCurrency="BTC"
        source="COINBASE"
        feedStatus="STALE"
      />,
    );
    expect(html).toContain('>Stale</span>');
    expect(html).not.toContain('>Live</span>');
  });
});
