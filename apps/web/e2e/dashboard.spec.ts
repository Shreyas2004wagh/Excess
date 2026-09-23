import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, test } from '@playwright/test';
import { prisma } from '@excess/database';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('redirects an unauthenticated visitor away from the dashboard', async ({
  page,
}) => {
  await setupClerkTestingToken({ page });
  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/sign-in/);
});

test('protects reports and CSV exports from unauthenticated requests', async ({
  page,
  request,
}) => {
  await setupClerkTestingToken({ page });
  await page.goto('/reports');
  await expect(page).toHaveURL(/\/sign-in/);
  for (const endpoint of ['/reports/trading', '/reports/trading/export']) {
    const response = await request.get(
      `http://localhost:4000/api/v1${endpoint}`,
    );
    expect(response.status()).toBe(401);
  }
});

test('filters, paginates, refreshes, and exports an authenticated trading report', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');
  await expect(
    page.getByRole('link', { name: 'Reports', exact: true }),
  ).toBeVisible();
  const user = await prisma.user.findFirstOrThrow({
    where: { email },
    include: { accounts: true },
  });
  const accountId = user.accounts.find(
    (account) => account.type === 'DEMO' && account.baseCurrency === 'USD',
  )!.id;
  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: ['BTC-USD', 'ETH-USD'] } },
  });
  const fixtures = Array.from({ length: 26 }, (_, index) => ({
    orderId: randomUUID(),
    tradeId: randomUUID(),
    instrumentId: instruments.find(
      (instrument) =>
        instrument.symbol === (index === 25 ? 'ETH-USD' : 'BTC-USD'),
    )!.id,
    executedAt: new Date(
      `2024-06-02T12:00:${String(index).padStart(2, '0')}.000Z`,
    ),
  }));
  try {
    await prisma.$transaction([
      prisma.order.createMany({
        data: fixtures.map((fixture) => ({
          id: fixture.orderId,
          accountId,
          instrumentId: fixture.instrumentId,
          clientOrderId: fixture.orderId,
          side: 'BUY',
          type: 'MARKET',
          quantity: '0.01',
          status: 'FILLED',
          executedQuantity: '0.01',
          averageFillPrice: '100.1234567891',
        })),
      }),
      prisma.trade.createMany({
        data: fixtures.map((fixture) => ({
          id: fixture.tradeId,
          orderId: fixture.orderId,
          accountId,
          instrumentId: fixture.instrumentId,
          side: 'BUY',
          price: '100.1234567891',
          quantity: '0.01',
          executedAt: fixture.executedAt,
        })),
      }),
      prisma.ledgerEntry.createMany({
        data: [
          {
            accountId,
            type: 'REALIZED_PNL',
            amount: '2.5',
            balanceAfter: '10002.5',
            referenceType: 'TRADE',
            referenceId: fixtures[24]!.tradeId,
          },
          {
            accountId,
            type: 'REALIZED_PNL',
            amount: '-1.25',
            balanceAfter: '10001.25',
            referenceType: 'TRADE',
            referenceId: fixtures[25]!.tradeId,
          },
        ],
      }),
    ]);
    await page.getByRole('link', { name: 'Reports', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Trading reports', exact: true }),
    ).toBeVisible();
    await page.getByLabel('From (UTC)').fill('2024-06-01');
    await page.getByLabel('To (UTC)').fill('2024-06-03');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByTestId('report-range')).toContainText(
      '2024-06-01 through 2024-06-03',
    );
    await expect(page.getByTestId('report-summary')).toContainText('$1.25');
    await expect(page.getByTestId('report-trades')).toContainText(
      '20 of 26 executions',
    );

    // The CSV must include all 26 results even before loading the next page.
    const downloadEvent = page.waitForEvent('download');
    const exportResponseEvent = page.waitForResponse((response) =>
      response.url().includes('/reports/trading/export?'),
    );
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadEvent;
    const exportResponse = await exportResponseEvent;
    expect(exportResponse.headers()['content-type']).toContain('text/csv');
    expect(exportResponse.headers()['cache-control']).toContain('no-store');
    expect(download.suggestedFilename()).toBe(
      'excess-trades-2024-06-01-2024-06-03.csv',
    );
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv.trim().split('\r\n')).toHaveLength(27);
    expect(csv).toContain('100.1234567891');
    expect(csv).toContain(fixtures[0]!.tradeId);

    await page.getByRole('button', { name: 'Load more executions' }).click();
    await expect(page.getByTestId('report-trades')).toContainText(
      '26 of 26 executions',
    );
    await expect(
      page.getByTestId('report-trades').locator('tbody tr'),
    ).toHaveCount(26);
    await page.screenshot({
      path: testInfo.outputPath('reports-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath('reports-mobile.png'),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // A transient filter failure must preserve the current result and allow retry.
    await page.route(
      '**/api/v1/reports/trading?*',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': 'http://localhost:3000' },
          body: JSON.stringify({
            code: 'TEMPORARY_FAILURE',
            message: 'Temporary report failure',
          }),
        }),
      { times: 1 },
    );
    await page
      .getByRole('combobox', { name: 'Instrument', exact: true })
      .selectOption('ETH-USD');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Temporary report failure' }),
    ).toBeVisible();
    await expect(page.getByTestId('report-trades')).toContainText(
      '26 of 26 executions',
    );
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByTestId('report-trades')).toContainText(
      '1 of 1 executions',
    );
    await expect(page.getByTestId('report-trades')).not.toContainText(
      'BTC-USD',
    );
    await expect(page.getByTestId('report-summary')).toContainText('-$1.25');
    await expect(page).toHaveURL(/symbol=ETH-USD/);
    await page.reload();
    await expect(
      page.getByRole('combobox', { name: 'Instrument', exact: true }),
    ).toHaveValue('ETH-USD');
    await expect(page.getByTestId('report-trades')).toContainText(
      '1 of 1 executions',
    );

    await page.getByLabel('From (UTC)').fill('2024-05-01');
    await page.getByLabel('To (UTC)').fill('2024-05-02');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      page.getByText(
        'No executions match these filters. Try another period or instrument.',
      ),
    ).toBeVisible();
    await page.goto('/reports?from=2024-02-30&to=2024-03-01');
    await expect(
      page.getByRole('heading', { name: 'Check your report filters' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Reset filters' }).click();
    await expect(
      page.getByRole('heading', { name: 'Trading reports', exact: true }),
    ).toBeVisible();
  } finally {
    await prisma.$transaction([
      prisma.ledgerEntry.deleteMany({
        where: {
          accountId,
          referenceType: 'TRADE',
          referenceId: { in: fixtures.map((fixture) => fixture.tradeId) },
        },
      }),
      prisma.trade.deleteMany({
        where: { id: { in: fixtures.map((fixture) => fixture.tradeId) } },
      }),
      prisma.order.deleteMany({
        where: { id: { in: fixtures.map((fixture) => fixture.orderId) } },
      }),
    ]);
  }
});

test('provisions one demo account and keeps it after refresh', async ({
  page,
}) => {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) {
    throw new Error('E2E_CLERK_USER_EMAIL is required');
  }

  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');

  await expect(page.getByText('$10,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('Opening demo credit')).toHaveCount(1);
  await expect(page.getByText('BTC and ETH markets are live.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('$10,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('Opening demo credit')).toHaveCount(1);

  await clerk.signOut({ page });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('renders and switches the authenticated multi-market terminal', async ({
  page,
}) => {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) {
    throw new Error('E2E_CLERK_USER_EMAIL is required');
  }

  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/terminal');

  await expect(
    page.getByRole('heading', { name: 'BTC / USD', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Test feed', { exact: true })).toBeVisible();
  await expect(page.getByText('● LIVE', { exact: true })).toBeVisible();
  await expect(page.getByText('Charts by TradingView')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  const livePrice = page.getByTestId('live-price');
  const initialPrice = await livePrice.textContent();
  await expect
    .poll(() => livePrice.textContent(), { timeout: 5_000 })
    .not.toBe(initialPrice);

  await page.getByTestId('instrument-ETH-USD').click();
  await expect(
    page.getByRole('heading', { name: 'ETH / USD', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Quantity (ETH)')).toHaveValue('0.1');
  await expect(
    page.getByRole('button', { name: 'Buy ETH · market' }),
  ).toBeVisible();
  await page.getByTestId('instrument-BTC-USD').click();

  await page.getByLabel('Quantity (BTC)').fill('0.01');
  await page.getByRole('button', { name: '2×', exact: true }).click();
  await page.getByRole('button', { name: 'Buy BTC · market' }).click();
  await expect(page.getByRole('status')).toContainText('Filled 0.01 BTC at $');
  await expect(page.getByTestId('trading-performance')).toContainText(
    'Executions',
  );
  await expect(page.getByTestId('trade-history')).toContainText('BTC-USD');
  await expect(page.getByTestId('trade-history')).toContainText(
    'Market execution',
  );
  await expect(page.getByText('LONG', { exact: true })).toBeVisible();
  await expect(page.getByText(/2× · \$/)).toBeVisible();
  await expect(page.getByTestId('risk-state')).toHaveText('HEALTHY');
  await expect(page.getByTestId('used-margin')).not.toHaveText('$0.00');

  const unrealizedPnl = page.getByTestId('live-unrealized-pnl');
  const initialPnl = await unrealizedPnl.textContent();
  await expect
    .poll(() => unrealizedPnl.textContent(), { timeout: 5_000 })
    .not.toBe(initialPnl);

  await page.getByRole('button', { name: 'limit' }).click();
  await expect(page.getByLabel('Limit price (USD)')).toBeVisible();
  await page.getByRole('button', { name: 'Buy BTC · limit' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Limit order accepted at $',
  );
  await expect(page.getByTestId('open-orders')).toContainText('Entry order');
  await page.getByRole('button', { name: 'Cancel limit order' }).click();
  await expect(page.getByText('No open orders.')).toBeVisible();

  await expect(page.getByLabel('Alert price (USD)')).toBeVisible();
  await page.getByRole('button', { name: 'Create alert' }).click();
  await expect(page.getByTestId('price-alerts')).toContainText(
    'Watching live price',
  );
  await page.getByRole('button', { name: 'Cancel above price alert' }).click();
  await expect(
    page.getByText('No active or triggered alerts yet.'),
  ).toBeVisible();
});

test('delivers a triggered alert to the in-app notification center', async ({
  page,
}) => {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');

  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');

  const [user, instrument] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { email } }),
    prisma.instrument.findUniqueOrThrow({ where: { symbol: 'BTC-USD' } }),
  ]);
  const alert = await prisma.priceAlert.create({
    data: {
      userId: user.id,
      instrumentId: instrument.id,
      direction: 'ABOVE',
      targetPrice: '65000',
      status: 'TRIGGERED',
      triggeredPrice: '65001',
      triggeredAt: new Date(),
    },
  });
  await prisma.outboxEvent.create({
    data: {
      aggregateType: 'PRICE_ALERT',
      aggregateId: alert.id,
      eventType: 'PRICE_ALERT_TRIGGERED',
      payload: {
        alertId: alert.id,
        userId: user.id,
        symbol: 'BTC-USD',
        direction: 'ABOVE',
        targetPrice: '65000',
        triggeredPrice: '65001',
      },
    },
  });

  await page.goto('/notifications');
  await expect(
    page.getByText('BTC-USD price alert triggered', { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(page.getByText('Read', { exact: true })).toBeVisible();
});

test('renders the protected administration console for an allowlisted user', async ({
  page,
}) => {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');

  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/admin');

  await expect(
    page.getByRole('heading', { name: 'Administration console' }),
  ).toBeVisible();
  await expect(page.getByTestId('admin-console')).toBeVisible();
  await expect(page.getByText('Alert delivery pipeline')).toBeVisible();
});
