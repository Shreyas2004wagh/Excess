import { randomUUID } from 'node:crypto';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { prisma } from '@excess/database';
import type {
  OrderPlacementResponse,
  PortfolioSummary,
} from '@excess/shared-types';

async function api(
  page: Page,
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
) {
  await page.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          Clerk?: { session?: unknown };
        }
      ).Clerk?.session,
    ),
  );
  const token = await page.evaluate(async () => {
    const identity = (
      window as unknown as {
        Clerk: { session: { getToken(): Promise<string | null> } };
      }
    ).Clerk;
    return identity.session.getToken();
  });
  expect(token).toBeTruthy();
  const response = await request.fetch(`http://localhost:4000/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response;
}

test('requires authentication to close a position', async ({ request }) => {
  const response = await request.post(
    `http://localhost:4000/api/v1/trading/positions/${randomUUID()}/close`,
    {
      data: { clientOrderId: randomUUID(), expectedVersion: 0 },
    },
  );
  expect(response.status()).toBe(401);
});

test('reviews, keeps, refreshes and retries a reduce-only position close on desktop and mobile', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');
  await expect(
    page.getByRole('button', { name: 'Open user menu' }),
  ).toBeVisible();

  // Bring only the dedicated E2E account to a flat starting position through the API.
  const initial = (await (
    await api(page, request, 'GET', '/trading/portfolio')
  ).json()) as PortfolioSummary;
  for (const position of initial.positions) {
    await api(
      page,
      request,
      'POST',
      `/trading/positions/${position.id}/close`,
      { clientOrderId: randomUUID(), expectedVersion: position.version },
    );
  }
  const place = async (body: object) =>
    (
      await api(page, request, 'POST', '/trading/orders', {
        clientOrderId: randomUUID(),
        ...body,
      })
    ).json() as Promise<OrderPlacementResponse>;
  const entry = await place({
    type: 'MARKET',
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: '0.01',
    leverage: 5,
    stopLossPrice: '50000',
    takeProfitPrice: '80000',
  });
  expect(Number(entry.trade?.slippageBps)).toBeGreaterThan(0);
  expect(
    entry.portfolio.positions.find((position) => position.symbol === 'BTC-USD')
      ?.leverage,
  ).toBe(5);
  await place({
    type: 'MARKET',
    symbol: 'ETH-USD',
    side: 'BUY',
    quantity: '0.1',
  });
  const pending = await place({
    type: 'LIMIT',
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: '0.01',
    limitPrice: '10000',
    leverage: 5,
  });
  const accountId = entry.portfolio.account.id;
  const countCloses = () =>
    prisma.order.count({ where: { accountId, purpose: 'POSITION_CLOSE' } });
  const baseline = await countCloses();
  await page.goto('/terminal');
  const positions = page.locator('#positions');
  await expect(
    page
      .getByTestId('trade-history')
      .getByText(/Spread .* bps · Slippage .* bps/)
      .first(),
  ).toBeVisible();
  await positions
    .getByRole('button', { name: 'Close position', exact: true })
    .click();
  await expect(
    positions.getByRole('button', { name: 'Keep position' }),
  ).toBeFocused();
  await expect(
    positions.getByText(/Sell the full 0.01 BTC position/),
  ).toBeVisible();
  await expect(
    positions.getByText('Estimated exit incl. slippage'),
  ).toBeVisible();
  await expect(
    positions.getByText(/pending entry order.*remain active/),
  ).toBeVisible();
  await positions.getByRole('button', { name: 'Keep position' }).click();
  await expect(
    positions.getByRole('button', { name: 'Close position', exact: true }),
  ).toBeFocused();
  expect(await countCloses()).toBe(baseline);
  await positions
    .getByRole('button', { name: 'Close position', exact: true })
    .click();
  await positions.screenshot({
    path: testInfo.outputPath('position-close-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await positions.screenshot({
    path: testInfo.outputPath('position-close-mobile.png'),
  });

  // A new fill from another tab invalidates the old confirmation.
  await place({
    type: 'MARKET',
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: '0.01',
    leverage: 5,
  });
  await expect(
    positions.getByText(
      'The position changed during review. Review its current size before closing.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    positions.getByRole('button', { name: 'Confirm close position' }),
  ).toBeDisabled();
  await positions
    .getByRole('button', { name: 'Review current position' })
    .click();
  await expect(
    positions.getByText(/Sell the full 0.02 BTC position/),
  ).toBeVisible();

  // Simulate a response being lost after the real API commits; retry must replay.
  const keys: string[] = [];
  let lost = false;
  await page.route('**/trading/positions/*/close', async (route) => {
    keys.push(
      (route.request().postDataJSON() as { clientOrderId: string })
        .clientOrderId,
    );
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (!lost) {
      lost = true;
      await route.abort('failed');
    } else {
      await route.fulfill({ response });
    }
  });
  await positions
    .getByRole('button', { name: 'Confirm close position' })
    .click();
  await expect(positions.getByRole('alert')).toContainText(
    'Retry uses the same request identifier',
  );
  await expect.poll(countCloses).toBe(baseline + 1);
  await positions.getByRole('button', { name: 'Retry close request' }).click();
  await expect(positions.getByRole('status')).toContainText(
    'BTC-USD close confirmed',
  );
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(await countCloses()).toBe(baseline + 1);
  await page.unroute('**/trading/positions/*/close');
  await expect(page.getByTestId('trade-history')).toContainText(
    'Position close',
  );
  await expect(
    positions.getByText('No open BTC-USD position.', { exact: false }),
  ).toBeVisible();
  const latest = (await (
    await api(page, request, 'GET', '/trading/portfolio')
  ).json()) as PortfolioSummary;
  expect(latest.positions.map((position) => position.symbol)).toEqual([
    'ETH-USD',
  ]);
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: pending.order.id } }))
      .status,
  ).toBe('ACCEPTED');
  expect(
    await prisma.order.count({
      where: {
        id: { in: entry.relatedOrders.map((order) => order.id) },
        status: 'ACCEPTED',
      },
    }),
  ).toBe(0);
  await page.reload();
  await expect(
    positions.getByRole('button', { name: 'Close position', exact: true }),
  ).toHaveCount(0);

  await place({
    type: 'MARKET',
    symbol: 'BTC-USD',
    side: 'SELL',
    quantity: '0.01',
  });
  await page.reload();
  await expect(positions.getByText('SHORT', { exact: true })).toBeVisible();
  await positions
    .getByRole('button', { name: 'Close position', exact: true })
    .click();
  await expect(
    positions.getByText(/Buy back the full 0.01 BTC position/),
  ).toBeVisible();
  await positions
    .getByRole('button', { name: 'Confirm close position' })
    .click();
  await expect(positions.getByRole('status')).toContainText(
    'BTC-USD close confirmed · BUY 0.01',
  );
  expect(await countCloses()).toBe(baseline + 2);
  await positions.screenshot({
    path: testInfo.outputPath('position-close-result-mobile.png'),
  });
});
