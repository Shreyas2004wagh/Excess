import type { Prisma } from '@excess/database';
import type { AdminAuditEntry } from '@excess/shared-types';

// Project documented event fields rather than exposing arbitrary stored JSON.
const keys = new Set([
  'accountId',
  'tradeId',
  'symbol',
  'side',
  'type',
  'purpose',
  'quantity',
  'leverage',
  'requestedPrice',
  'stopPrice',
  'fillPrice',
  'rawRealizedPnl',
  'protectedAmount',
  'reason',
  'targetPrice',
  'triggeredPrice',
  'direction',
  'notificationId',
  'outboxEventId',
  'alertId',
]);

export function auditMetadata(
  value: Prisma.JsonValue,
): AdminAuditEntry['metadata'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    ([key, item]) =>
      keys.has(key) &&
      (item === null || ['string', 'number', 'boolean'].includes(typeof item)),
  );
  return Object.fromEntries(entries) as AdminAuditEntry['metadata'];
}
