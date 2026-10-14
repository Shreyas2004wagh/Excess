import type { MarketSymbol, OrderBookLevel } from '@excess/shared-types';
import { z } from 'zod';

import { isMarketSymbol, type ProviderOrderBook } from './market-data.types.js';

const decimal = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)));

const messageSchema = z.object({
  channel: z.literal('l2_data'),
  sequence_num: z.number().int().nonnegative().safe(),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  events: z.array(
    z.object({
      type: z.enum(['snapshot', 'update']),
      product_id: z.string(),
      updates: z.array(
        z.object({
          side: z.enum(['bid', 'offer']),
          price_level: decimal.refine((value) => Number(value) > 0),
          new_quantity: decimal,
        }),
      ),
    }),
  ),
});

const envelopeSchema = z.object({
  channel: z.string(),
  sequence_num: z.number().int().nonnegative().safe(),
});

type Book = {
  bids: Map<number, OrderBookLevel>;
  asks: Map<number, OrderBookLevel>;
  updatedAt: string;
};

const MAX_LEVELS_PER_SIDE = 100_000;

// Keep every price level: truncating the source book would lose levels when
// better prices disappear. Only the browser snapshot is limited to 20 levels.
export class CoinbaseOrderBook {
  private readonly books = new Map<MarketSymbol, Book>();
  private readonly dirty = new Set<MarketSymbol>();
  private sequence: number | null = null;

  reset() {
    this.books.clear();
    this.dirty.clear();
    this.sequence = null;
  }

  apply(raw: string): 'ignored' | 'updated' | 'resync' {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return 'ignored';
    }
    if (typeof value !== 'object' || value === null || !('channel' in value)) {
      return 'ignored';
    }
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success) {
      return value.channel === 'l2_data' ? this.resync() : 'ignored';
    }
    // Sequence numbers span all channels on this connection, including
    // heartbeat messages and subscription acknowledgments.
    if (this.sequence !== null) {
      if (envelope.data.sequence_num <= this.sequence) return 'ignored';
      if (envelope.data.sequence_num !== this.sequence + 1)
        return this.resync();
    }
    this.sequence = envelope.data.sequence_num;
    if (envelope.data.channel !== 'l2_data') return 'ignored';
    const result = messageSchema.safeParse(value);
    if (!result.success) return this.resync();
    const message = result.data;

    for (const event of message.events) {
      if (!isMarketSymbol(event.product_id)) continue;
      const symbol = event.product_id.toUpperCase() as MarketSymbol;
      if (event.type === 'snapshot') {
        this.books.set(symbol, {
          bids: new Map(),
          asks: new Map(),
          updatedAt: message.timestamp,
        });
      }
      const book = this.books.get(symbol);
      if (!book) return this.resync();
      for (const update of event.updates) {
        const side = update.side === 'bid' ? book.bids : book.asks;
        const price = Number(update.price_level);
        if (Number(update.new_quantity) === 0) {
          side.delete(price);
        } else {
          side.set(price, {
            price: update.price_level,
            quantity: update.new_quantity,
          });
        }
        if (side.size > MAX_LEVELS_PER_SIDE) return this.resync();
      }
      book.updatedAt = message.timestamp;
      this.dirty.add(symbol);
    }
    return 'updated';
  }

  takeSnapshots(depth = 20): ProviderOrderBook[] | null {
    const snapshots: ProviderOrderBook[] = [];
    for (const symbol of this.dirty) {
      const book = this.books.get(symbol)!;
      const bids = [...book.bids.values()]
        .sort((left, right) => Number(right.price) - Number(left.price))
        .slice(0, depth);
      const asks = [...book.asks.values()]
        .sort((left, right) => Number(left.price) - Number(right.price))
        .slice(0, depth);
      if (bids[0] && asks[0] && Number(bids[0].price) > Number(asks[0].price)) {
        this.reset();
        return null;
      }
      snapshots.push({ symbol, bids, asks, updatedAt: book.updatedAt });
    }
    this.dirty.clear();
    return snapshots;
  }

  private resync(): 'resync' {
    this.reset();
    return 'resync';
  }
}
