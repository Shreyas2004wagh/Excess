import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });
const label = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const schema = z.object({
  from: date.optional(),
  to: date.optional(),
  action: label.optional(),
  actorUserId: z.uuid().optional(),
  resourceType: label.optional(),
  resourceId: z.string().min(1).max(128).optional(),
  asOf: z.iso.datetime().optional(),
  cursor: z.uuid().optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(20),
});

function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_AUDIT_QUERY', message });
}

export function parseAuditQuery(query: unknown, now = new Date()) {
  const result = schema.safeParse(query);
  if (!result.success)
    invalid(
      'Use UTC dates, uppercase action/resource names, a user UUID, and a limit of 1–100.',
    );
  const {
    from,
    to = now.toISOString().slice(0, 10),
    action,
    actorUserId,
    resourceType,
    resourceId,
    asOf,
    cursor,
    limit,
  } = result.data;
  const end = new Date(`${to}T00:00:00.000Z`);
  const start = from
    ? new Date(`${from}T00:00:00.000Z`)
    : new Date(end.getTime() - 29 * DAY_MS);
  const days = (end.getTime() - start.getTime()) / DAY_MS + 1;
  if (days < 1 || days > 366 || start.getUTCFullYear() < 1)
    invalid(
      'Choose a date range of 1–366 days, with the start on or before the end.',
    );
  const cutoff = asOf ? new Date(asOf) : now;
  if (cutoff > now || (cursor && !asOf))
    invalid(
      'Pagination requires the original asOf timestamp, which cannot be in the future.',
    );
  return {
    filters: {
      from: start.toISOString().slice(0, 10),
      to,
      action: action ?? null,
      actorUserId: actorUserId ?? null,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
      asOf: cutoff.toISOString(),
    },
    start,
    endExclusive: new Date(end.getTime() + DAY_MS),
    cutoff,
    cursor,
    limit,
  };
}

export type AuditQuery = ReturnType<typeof parseAuditQuery>;
