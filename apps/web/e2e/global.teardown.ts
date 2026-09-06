import { prisma } from '@excess/database';

export default async function globalTeardown() {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) return;

  const user = await prisma.user.findFirst({
    where: { email },
    include: { accounts: true, priceAlerts: true },
  });
  if (!user) {
    await prisma.$disconnect();
    return;
  }

  const accountIds = user.accounts.map((account) => account.id);
  const alertIds = user.priceAlerts.map((alert) => alert.id);
  const orders = await prisma.order.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  await prisma.$transaction([
    prisma.outboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: { in: orders.map((order) => order.id) } },
          { aggregateType: 'PRICE_ALERT', aggregateId: { in: alertIds } },
        ],
      },
    }),
    prisma.auditEvent.deleteMany({
      where: {
        actorUserId: user.id,
        action: {
          in: [
            'MARKET_ORDER_FILLED',
            'ORDER_FILLED',
            'NEGATIVE_BALANCE_PROTECTED',
            'PRICE_ALERT_TRIGGERED',
          ],
        },
      },
    }),
    prisma.ledgerEntry.deleteMany({
      where: { accountId: { in: accountIds }, type: 'REALIZED_PNL' },
    }),
    prisma.trade.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.order.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.position.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.priceAlert.deleteMany({ where: { userId: user.id } }),
    ...user.accounts.map((account) =>
      prisma.account.update({
        where: { id: account.id },
        data: { balance: account.initialBalance },
      }),
    ),
  ]);
  await prisma.$disconnect();
}
