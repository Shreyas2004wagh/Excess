import { Inject, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { MarketStreamEvent } from '@excess/shared-types';
import type { Namespace, Socket } from 'socket.io';

import { CLERK_GATEWAY } from '../auth/auth.tokens.js';
import type { ClerkGateway } from '../auth/auth.types.js';
import { MarketDataService } from './market-data.service.js';
import { MARKET_SYMBOL } from './market-data.types.js';

@WebSocketGateway({
  namespace: '/market-data',
  transports: ['websocket'],
  cors: {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  },
})
export class MarketDataGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Namespace;

  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly marketData: MarketDataService,
    @Inject(CLERK_GATEWAY) private readonly clerk: ClerkGateway,
  ) {}

  afterInit() {
    this.unsubscribe = this.marketData.subscribe((message) => {
      this.server.to(MARKET_SYMBOL).emit(message.event, message.data);
    });
  }

  async handleConnection(client: Socket) {
    const token = client.handshake.auth.token;
    if (typeof token !== 'string' || !token) {
      this.reject(client);
      return;
    }

    try {
      const webOrigin = this.config.getOrThrow<string>('WEB_ORIGIN');
      const request = new Request(`${webOrigin}/market-data`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: client.handshake.headers.origin ?? webOrigin,
        },
      });
      const state = await this.clerk.authenticate(request);
      const auth = state.isAuthenticated ? state.toAuth() : null;
      if (!auth?.userId || !auth.sessionId) {
        this.reject(client);
        return;
      }

      client.data.identity = {
        clerkUserId: auth.userId,
        sessionId: auth.sessionId,
      };
      await client.join(MARKET_SYMBOL);
      const ticker = this.marketData.getCurrentTicker();
      if (ticker) {
        client.emit('market:ticker', ticker);
      }
    } catch {
      this.reject(client);
    }
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  private reject(client: Socket) {
    const message: Extract<MarketStreamEvent, { event: 'market:status' }> = {
      event: 'market:status',
      data: { symbol: MARKET_SYMBOL, status: 'OFFLINE' },
    };
    client.emit('market:error', {
      code: 'UNAUTHORIZED',
      message: 'A valid Clerk session is required',
    });
    client.emit(message.event, message.data);
    client.disconnect(true);
  }
}
