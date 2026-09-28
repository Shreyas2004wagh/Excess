import { parseAuditQuery } from './audit-query.js';
import { auditMetadata } from './audit-metadata.js';

const now = new Date('2026-09-28T12:00:00.000Z');
describe('Audit query validation', () => {
  it('defaults to the last 30 UTC days and a bounded page', () => {
    expect(parseAuditQuery({}, now)).toMatchObject({
      filters: {
        from: '2026-08-30',
        to: '2026-09-28',
        asOf: now.toISOString(),
      },
      limit: 20,
    });
  });
  it.each([
    { from: '2026-02-30' },
    { from: '0000-01-01', to: '0000-01-02' },
    { from: '2026-09-29', to: '2026-09-28' },
    { from: '2024-01-01', to: '2026-09-28' },
    { from: ['2026-09-28'] },
    { action: ['ORDER_FILLED'] },
    { action: 'order filled' },
    { actorUserId: 'not-a-user' },
    { resourceId: '' },
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { cursor: '11111111-1111-4111-8111-111111111111' },
    { asOf: '2026-09-29T00:00:00.000Z' },
  ])('rejects invalid filters %j', (query) => {
    expect(() => parseAuditQuery(query, now)).toThrow();
  });
  it('accepts an inclusive UTC range and exact event filters', () => {
    const query = parseAuditQuery(
      {
        from: '2026-09-01',
        to: '2026-09-28',
        action: 'ORDER_FILLED',
        resourceType: 'ORDER',
        resourceId: 'resource-1',
        limit: '100',
      },
      now,
    );
    expect(query.endExclusive.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(query.filters.action).toBe('ORDER_FILLED');
    expect(query.limit).toBe(100);
  });
});

describe('Audit metadata projection', () => {
  it('preserves financial decimal strings and excludes unrelated or nested fields', () => {
    expect(
      auditMetadata({
        quantity: '0.0100000001',
        fillPrice: '65000.1234567891',
        symbol: 'BTC-USD',
        token: 'private',
        payload: { secret: true },
        reason: null,
      }),
    ).toEqual({
      quantity: '0.0100000001',
      fillPrice: '65000.1234567891',
      symbol: 'BTC-USD',
      reason: null,
    });
    expect(auditMetadata(null)).toBeNull();
    expect(auditMetadata([])).toBeNull();
  });
});
