import { Prisma } from '@excess/database';
import { executionPrice } from './execution-pricing.js';

const ticker = { bid: '64999.5', ask: '65000.5' };
const tickSize = new Prisma.Decimal('0.01');

describe('execution pricing', () => {
  it('adds adverse, tick-rounded slippage to a market buy without counting it as spread', () => {
    const price = executionPrice({
      ticker,
      side: 'BUY',
      type: 'MARKET',
      tickSize,
    });
    expect(price.fillPrice.toString()).toBe('65013.5');
    expect(price.spreadBps.toString()).toBe('0.076923');
    expect(price.slippageBps.toString()).toBe('1.999985');
  });

  it('uses the bid and adverse slippage for market sells and triggered stops', () => {
    for (const type of ['MARKET', 'STOP'] as const) {
      const price = executionPrice({ ticker, side: 'SELL', type, tickSize });
      expect(price.fillPrice.toString()).toBe('64986.5');
      expect(price.slippageBps.greaterThan(0)).toBe(true);
    }
  });

  it('does not slip limit orders or invent sub-tick slippage', () => {
    const limit = executionPrice({
      ticker,
      side: 'BUY',
      type: 'LIMIT',
      tickSize,
    });
    expect(limit.fillPrice.toString()).toBe(ticker.ask);
    expect(limit.slippageBps.toString()).toBe('0');
    const tiny = executionPrice({
      ticker: { bid: '0.5', ask: '0.51' },
      side: 'SELL',
      type: 'MARKET',
      tickSize,
    });
    expect(tiny.fillPrice.toString()).toBe('0.5');
    expect(tiny.slippageBps.toString()).toBe('0');
    const subTick = executionPrice({
      ticker: { bid: '0.004', ask: '0.005' },
      side: 'SELL',
      type: 'MARKET',
      tickSize,
    });
    expect(subTick.fillPrice.toString()).toBe('0.004');
  });

  it('rejects invalid executable quotes', () => {
    expect(() =>
      executionPrice({
        ticker: { bid: '0', ask: '1' },
        side: 'BUY',
        type: 'MARKET',
        tickSize,
      }),
    ).toThrow(RangeError);
    expect(() =>
      executionPrice({
        ticker: { bid: '2', ask: '1' },
        side: 'BUY',
        type: 'MARKET',
        tickSize,
      }),
    ).toThrow(RangeError);
  });
});
