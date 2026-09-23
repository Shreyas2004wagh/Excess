import { BadRequestException } from '@nestjs/common';
import { parseReportQuery } from './report-query.js';

const now = new Date('2026-09-23T08:30:00.000Z');

describe('UTC report query validation', () => {
  it('defaults to 30 UTC calendar days and an execution cutoff', () => {
    expect(parseReportQuery({}, now).filters).toEqual({
      from: '2026-08-25',
      to: '2026-09-23',
      symbol: null,
      asOf: now.toISOString(),
    });
  });

  it('includes the complete end date and accepts leap days', () => {
    const query = parseReportQuery(
      { from: '2024-02-29', to: '2024-02-29', symbol: 'ETH-USD', limit: '100' },
      now,
    );
    expect(query.start.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(query.endExclusive.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(query.limit).toBe(100);
  });

  it.each([
    { from: '2025-02-29' },
    { from: '2024-04-31' },
    { to: 'yesterday' },
    { from: '2026-09-24', to: '2026-09-23' },
    { from: '2024-01-01', to: '2025-01-01' },
    { symbol: 'DOGE-USD' },
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: ['20'] },
    { from: ['2024-01-01', '2024-01-02'] },
    { cursor: 'not-a-uuid' },
    { cursor: 'd93c4d1e-2b3d-4db6-bcd8-ea441aa8cf33' },
    { asOf: '2026-09-24T00:00:00.000Z' },
    { asOf: 'invalid' },
  ])('rejects invalid filters: %j', (query) => {
    expect(() => parseReportQuery(query, now)).toThrow(BadRequestException);
  });

  it('allows exactly 366 days and defaults relative to a supplied end date', () => {
    expect(
      parseReportQuery({ from: '2024-01-01', to: '2024-12-31' }, now).filters
        .from,
    ).toBe('2024-01-01');
    expect(parseReportQuery({ to: '2024-03-01' }, now).filters.from).toBe(
      '2024-02-01',
    );
  });
});
