import { describe, expect, it } from 'vitest';

import { applyFillToPosition } from './position';

describe('applyFillToPosition', () => {
  it('opens and adds to a long position using a weighted entry price', () => {
    const opened = applyFillToPosition({
      signedQuantity: '0',
      averageEntryPrice: null,
      side: 'BUY',
      quantity: '0.1',
      fillPrice: '60000',
    });
    const increased = applyFillToPosition({
      signedQuantity: opened.signedQuantity,
      averageEntryPrice: opened.averageEntryPrice,
      side: 'BUY',
      quantity: '0.1',
      fillPrice: '62000',
    });

    expect(increased).toEqual({
      signedQuantity: '0.2',
      averageEntryPrice: '61000',
      realizedPnlDelta: '0',
    });
  });

  it('partially closes a long position and realizes profit', () => {
    expect(
      applyFillToPosition({
        signedQuantity: '0.2',
        averageEntryPrice: '60000',
        side: 'SELL',
        quantity: '0.05',
        fillPrice: '61000',
      }),
    ).toEqual({
      signedQuantity: '0.15',
      averageEntryPrice: '60000',
      realizedPnlDelta: '50',
    });
  });

  it('closes a short position and realizes profit', () => {
    expect(
      applyFillToPosition({
        signedQuantity: '-0.1',
        averageEntryPrice: '61000',
        side: 'BUY',
        quantity: '0.1',
        fillPrice: '60000',
      }),
    ).toEqual({
      signedQuantity: '0',
      averageEntryPrice: null,
      realizedPnlDelta: '100',
    });
  });

  it('uses the fill price as entry when an order flips the position', () => {
    expect(
      applyFillToPosition({
        signedQuantity: '0.1',
        averageEntryPrice: '60000',
        side: 'SELL',
        quantity: '0.25',
        fillPrice: '59000',
      }),
    ).toEqual({
      signedQuantity: '-0.15',
      averageEntryPrice: '59000',
      realizedPnlDelta: '-100',
    });
  });
});
