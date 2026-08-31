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
  await expect(page.getByText('Trading terminal coming next.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('$10,000.00', { exact: true })).toBeVisible();
  await expect(page.getByText('Opening demo credit')).toHaveCount(1);

  await clerk.signOut({ page });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in/);
});
