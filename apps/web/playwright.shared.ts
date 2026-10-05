import { devices, type PlaywrightTestConfig } from '@playwright/test';

/**
 * The browser suite runs as three CI jobs under the same bound, split by file
 * name. The browser job (playwright.config.ts) ignores every spec this rule
 * matches: purchasing, receiving and receivables, inventory, payables and every
 * composed-application journey. Of those, the composed job
 * (playwright.composed.config.ts) runs the composed-application journeys and
 * the operations job (playwright.operations.config.ts) runs the rest, so every
 * spec runs in exactly one job. The rule reads the file name only: nothing
 * after the matched word may be a directory.
 */
export const operationsBrowserSpecs =
  /(?:purchase|receiv|inventory|payable|composed-application|expected-receipts|order-lists|item-stock)[^/]*\.spec\.ts$/u;

/** The composed-application journeys; every one also matches the rule above. */
export const composedApplicationSpecs = /composed-application\.spec\.ts$/u;

/**
 * Everything the browser jobs share except which specs they select. The
 * reporters are the named producer's: its raw report and its unfiltered-run
 * check, which records the invocation under that producer's id.
 */
export function browserSuiteConfig(producer: string): PlaywrightTestConfig {
  return {
    expect: { timeout: 5_000 },
    fullyParallel: false,
    reporter: [
      ['list'],
      [
        'json',
        {
          outputFile: `../../test-results/reachability/${producer}.raw.json`,
        },
      ],
      ['../../test/helpers/playwright-unfiltered-reporter.ts', { producer }],
    ],
    testDir: './test/browser',
    timeout: 20_000,
    use: {
      ...devices['Desktop Chrome'],
      headless: true,
    },
  };
}
