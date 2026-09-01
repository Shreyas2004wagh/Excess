import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';

import type { ClerkGateway } from '../auth/auth.types.js';
import { MarketDataGateway } from './market-data.gateway.js';
import type { MarketDataService } from './market-data.service.js';

function createSocket(token?: string) {
  return {
    handshake: {
      auth: token ? { token } : {},
      headers: { origin: 'http://localhost:3000' },
    },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket;
}

const config = {
  getOrThrow: () => 'http://localhost:3000',
} as unknown as ConfigService;

const marketData = {
  subscribe: () => () => undefined,
  getCurrentTicker: () => null,
} as unknown as MarketDataService;

describe('MarketDataGateway', () => {
  it('rejects a connection without a Clerk token', async () => {
    const clerk = {
      authenticate: jest.fn(async () => ({ isAuthenticated: false })),
    } as unknown as ClerkGateway;
    const gateway = new MarketDataGateway(config, marketData, clerk);
    const socket = createSocket();

    await gateway.handleConnection(socket);

    expect(clerk.authenticate).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'market:error',
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('joins the BTC-USD stream with a verified Clerk session', async () => {
    const clerk = {
      authenticate: jest.fn(async () => ({
        isAuthenticated: true,
        toAuth: () => ({ userId: 'user_valid', sessionId: 'session_valid' }),
      })),
    } as unknown as ClerkGateway;
    const gateway = new MarketDataGateway(config, marketData, clerk);
    const socket = createSocket('valid-token');

    await gateway.handleConnection(socket);

    expect(socket.join).toHaveBeenCalledWith('BTC-USD');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data).toMatchObject({
      identity: {
        clerkUserId: 'user_valid',
        sessionId: 'session_valid',
      },
    });
  });

  it('rejects a token verification failure', async () => {
    const clerk = {
      authenticate: jest.fn(async () => {
        throw new Error('expired');
      }),
    } as unknown as ClerkGateway;
    const gateway = new MarketDataGateway(config, marketData, clerk);
    const socket = createSocket('expired-token');

    await gateway.handleConnection(socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
