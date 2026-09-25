import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, test, type Page } from '@playwright/test';
import { prisma } from '@excess/database';

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test('presents the product, real navigation, and a clearly labelled preview', async ({
  page,
}, testInfo) => {
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Make your',
  );
  await expect(
    page.getByText('Interface preview · Illustrative prices'),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await page.getByRole('link', { name: 'The workspace', exact: true }).click();
  await expect(page).toHaveURL(/#workspace$/);
  await page.goto('/');
  await page.screenshot({
    path: testInfo.outputPath('landing-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noPageOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: testInfo.outputPath('landing-mobile.png'),
    fullPage: true,
  });
  await page
    .getByRole('link', { name: 'Create account', exact: false })
    .click();
  await expect(page).toHaveURL(/\/sign-up/);
  await expect(
    page.getByRole('heading', { name: 'Create your account' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Google/ })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await noPageOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('sign-up-mobile.png'),
    fullPage: true,
  });
});

test('keeps workspace navigation and the terminal usable across screen sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(
    nav.getByRole('link', { name: 'Dashboard', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('dashboard-balance')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open user menu' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('dashboard-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noPageOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('dashboard-mobile.png'),
    fullPage: true,
  });
  await nav.getByRole('link', { name: 'Terminal', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'BTC / USD', exact: true }),
  ).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await noPageOverflow(page);
  await page.getByRole('button', { name: 'Reset chart view' }).click();
  await page.getByRole('link', { name: 'Trade', exact: true }).click();
  await expect(page.getByLabel('Quantity (BTC)')).toBeInViewport();
  await page.getByText('Add stop loss / take profit', { exact: true }).click();
  await expect(page.getByLabel('Stop loss (USD)')).toBeVisible();
  await expect(page.getByLabel('Take profit (USD)')).toBeVisible();
  await page.getByText('Add stop loss / take profit', { exact: true }).click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.screenshot({
    path: testInfo.outputPath('terminal-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: testInfo.outputPath('terminal-desktop.png'),
    fullPage: true,
  });
  await noPageOverflow(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await noPageOverflow(page);
  await nav.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByTestId('realized-chart')).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Reports', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await noPageOverflow(page);
  await nav.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Market notifications', exact: true }),
  ).toBeVisible();
  await noPageOverflow(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe('auto');
});

test('renders ledger debits with the correct label and sign', async ({
  page,
}) => {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (!email) throw new Error('E2E_CLERK_USER_EMAIL is required');
  await setupClerkTestingToken({ page });
  await page.goto('/');
  await clerk.signIn({ page, emailAddress: email });
  await page.goto('/dashboard');
  const user = await prisma.user.findFirstOrThrow({
    where: { email },
    include: { accounts: true },
  });
  const entry = await prisma.ledgerEntry.create({
    data: {
      accountId: user.accounts[0]!.id,
      type: 'FEE',
      amount: '-12.34',
      balanceAfter: '9987.66',
    },
  });
  try {
    await page.reload();
    const row = page
      .getByTestId('dashboard-ledger')
      .locator('.ledger-row')
      .filter({ hasText: 'Trading fee' });
    await expect(row).toContainText('-$12.34');
    await expect(row).not.toContainText('+-');
    await expect(
      page.getByTestId('dashboard-ledger').getByText('Opening demo credit'),
    ).toHaveCount(1);
  } finally {
    await prisma.ledgerEntry.delete({ where: { id: entry.id } });
  }
});
