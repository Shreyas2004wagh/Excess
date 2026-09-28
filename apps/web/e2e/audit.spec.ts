import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, test } from '@playwright/test';
import { prisma } from '@excess/database';
import { randomUUID } from 'node:crypto';

test('protects the audit explorer and API from unauthenticated requests', async ({
  page,
  request,
}) => {
  await setupClerkTestingToken({ page });
  await page.goto('/admin/audit');
  await expect(page).toHaveURL(/\/sign-in/);
  expect(
    (
      await request.get('http://localhost:4000/api/v1/admin/audit-events')
    ).status(),
  ).toBe(401);
});

test('filters, paginates, inspects, and protects administrator audit activity', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  // Settle Clerk's configured post-sign-in dashboard redirect before navigation.
  await page.goto('/dashboard');
  await expect(
    page.getByRole('button', { name: 'Open user menu' }),
  ).toBeVisible();
  await page.goto('/admin');
  await expect(
    page.getByRole('link', { name: 'Open audit explorer' }),
  ).toBeVisible();
  const user = await prisma.user.findFirstOrThrow({ where: { email } });
  const resourceId = randomUUID();
  const ids = Array.from({ length: 26 }, () => randomUUID());
  try {
    await prisma.auditEvent.createMany({
      data: ids.map((id, index) => ({
        id,
        actorUserId: user.id,
        action: index === 25 ? 'ORDER_CANCELLED' : 'ORDER_ACCEPTED',
        resourceType: 'ORDER',
        resourceId,
        createdAt: new Date('2024-06-02T12:00:00.000Z'),
        metadata: {
          quantity: '0.0100000001',
          requestedPrice: '64000.1234567891',
          symbol: 'BTC-USD',
          secret: 'not-public-event-data',
        },
      })),
    });
    await page.getByRole('link', { name: 'Open audit explorer' }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    await expect(
      page.getByRole('heading', { name: 'Audit explorer', exact: true }),
    ).toBeVisible();
    await page.getByLabel('From (UTC)').fill('2024-06-01');
    await page.getByLabel('To (UTC)').fill('2024-06-03');
    await page.getByLabel('Resource ID', { exact: true }).fill(resourceId);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByTestId('audit-event')).toHaveCount(20);
    await page.getByRole('button', { name: 'Load more events' }).click();
    await expect(page.getByTestId('audit-event')).toHaveCount(26);
    await expect(
      page.getByRole('button', { name: 'Load more events' }),
    ).toHaveCount(0);
    await page.getByLabel('Action', { exact: true }).fill('ORDER_CANCELLED');
    await page.getByLabel('Resource type', { exact: true }).fill('ORDER');
    await page.getByLabel('Associated user ID', { exact: true }).fill(user.id);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.getByTestId('audit-event')).toHaveCount(1);
    await expect(page).toHaveURL(/action=ORDER_CANCELLED/);
    await page.reload();
    await expect(page.getByTestId('audit-event')).toHaveCount(1);
    await expect(page.getByLabel('Action', { exact: true })).toHaveValue(
      'ORDER_CANCELLED',
    );
    await page.getByText('View event details', { exact: true }).click();
    await expect(
      page.locator('pre[aria-label="Event metadata"]'),
    ).toContainText('64000.1234567891');
    await expect(
      page.locator('pre[aria-label="Event metadata"]'),
    ).not.toContainText('not-public-event-data');
    await expect(
      page.getByRole('button', { name: 'Open user menu' }),
    ).toBeVisible();
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.screenshot({
      path: testInfo.outputPath('audit-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('audit-mobile.png'),
      fullPage: true,
    });

    await page.route('**/admin/audit-events?**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit activity is temporarily unavailable.',
        }),
      }),
    );
    await page.getByRole('button', { name: 'Refresh results' }).click();
    await expect(
      page.locator('#main-content').getByRole('alert'),
    ).toContainText('Previous results are still displayed');
    await expect(page.getByTestId('audit-event')).toHaveCount(1);
    await page.unroute('**/admin/audit-events?**');
    await page.getByRole('button', { name: 'Refresh results' }).click();
    await expect(page.locator('#main-content').getByRole('alert')).toHaveCount(
      0,
    );

    await page.getByLabel('Resource ID', { exact: true }).fill(randomUUID());
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(
      page.getByText('No matching activity.', { exact: true }),
    ).toBeVisible();
    await page.goto('/admin/audit?from=2024-02-30');
    await expect(
      page.locator('#main-content').getByRole('alert'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page.locator('#main-content').getByRole('alert')).toHaveCount(
      0,
    );
    await expect(page.getByTestId('audit-events')).toBeVisible();

    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'TRADER' },
    });
    await page.getByRole('button', { name: 'Refresh results' }).click();
    await expect(
      page.locator('#main-content').getByRole('alert'),
    ).toContainText('Administrator access is no longer available');
    await expect(page.getByTestId('audit-events')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Apply filters' }),
    ).toBeDisabled();
  } finally {
    await prisma.user.update({
      where: { id: user.id },
      data: { role: user.role },
    });
    await prisma.auditEvent.deleteMany({ where: { id: { in: ids } } });
  }
});
