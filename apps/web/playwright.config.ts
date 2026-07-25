import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [
    ['list'],
    [
      'json',
      { outputFile: '../../test-results/reachability/browser.raw.json' },
    ],
    ['../../test/helpers/playwright-unfiltered-reporter.ts'],
  ],
  testDir: './test/browser',
  timeout: 20_000,
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
  },
});
