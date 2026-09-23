import { BadRequestException } from '@nestjs/common';
import { MARKET_SYMBOLS } from '@excess/shared-types';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const schema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  symbol: z.enum(MARKET_SYMBOLS).optional(),
  asOf: z.iso.datetime().optional(),
  cursor: z.uuid().optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(20),
});

function invalidQuery(message: string): never {
  throw new BadRequestException({ code: 'INVALID_REPORT_QUERY', message });
}

export function parseReportQuery(query: unknown, now = new Date()) {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    invalidQuery(
      'Use UTC dates (YYYY-MM-DD), a supported symbol, a valid cursor, and a limit of 1–100.',
    );
  }
  const {
    from,
    to = now.toISOString().slice(0, 10),
    symbol,
    cursor,
    limit,
    asOf,
  } = parsed.data;
  const end = new Date(`${to}T00:00:00.000Z`);
  const start = from
    ? new Date(`${from}T00:00:00.000Z`)
    : new Date(end.getTime() - 29 * DAY_MS);
  const days = (end.getTime() - start.getTime()) / DAY_MS + 1;
  if (days < 1 || days > 366 || start.getUTCFullYear() < 1) {
    invalidQuery(
      'Choose a date range of 1–366 days, with the start on or before the end.',
    );
  }
  const cutoff = asOf ? new Date(asOf) : now;
  if (cutoff > now || (cursor && !asOf)) {
    invalidQuery(
      'Use a past or current asOf timestamp; pagination requires the original asOf value.',
    );
  }
  return {
    filters: {
      from: start.toISOString().slice(0, 10),
      to,
      symbol: symbol ?? null,
      asOf: cutoff.toISOString(),
    },
    start,
    endExclusive: new Date(end.getTime() + DAY_MS),
    cutoff,
    cursor,
    limit,
  };
}

export type ReportQuery = ReturnType<typeof parseReportQuery>;
