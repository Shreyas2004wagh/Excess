import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, test } from '@playwright/test';

test('redirects an unauthenticated visitor away from the dashboard', async ({
  page,
}) => {
  await setupClerkTestingToken({ page });
  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/sign-in/);
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
  await expect(page.getByText('BTC-USD terminal is live.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('$10,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('Opening demo credit')).toHaveCount(1);

  await clerk.signOut({ page });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('renders the authenticated live BTC-USD terminal', async ({ page }) => {
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

  await page.getByLabel('Quantity (BTC)').fill('0.01');
  await page.getByRole('button', { name: '2×', exact: true }).click();
  await page.getByRole('button', { name: 'Buy BTC · market' }).click();
  await expect(page.getByRole('status')).toContainText('Filled 0.01 BTC at $');
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
