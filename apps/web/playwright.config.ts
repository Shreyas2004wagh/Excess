import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'corepack pnpm --filter @excess/api dev',
      url: 'http://localhost:4000/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'corepack pnpm --filter @excess/web dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'Clerk setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['Clerk setup'],
      testIgnore: /global\.setup\.ts/,
    },
  ],
});
