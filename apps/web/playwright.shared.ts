import { devices, type PlaywrightTestConfig } from '@playwright/test';

/** The default project ignores the specs owned by operations, inventory and
 * the composed-application projects. Each selector matches the file name.
 */
export const operationsBrowserSpecs =
  /(?:purchase|receiv|inventory|payable|composed-application|expected-receipts|order-lists|order-pages|item-stock|price-list)[^/]*\.spec\.ts$/u;

/** The composed-application journeys; every one also matches the rule above. */
export const composedApplicationSpecs = /composed-application\.spec\.ts$/u;
export const customizationRulesSpecs =
  /(?:^|\/)customize-(?:rules|formulas|inspection)\.composed-application\.spec\.ts$/u;
export const customizationBrowserSpecs =
  /(?:^|\/)customize\.composed-application\.spec\.ts$/u;

/**
 * The inventory and item stock specs; every one also matches the rule above.
 * INTEGRATION split them from the operations job when the union's operations
 * specs ran 19.5 minutes and the job passed its 20-minute bound (CI run
 * 37366491594).
 */
export const inventoryBrowserSpecs =
  /(?:inventory|item-stock)[^/]*\.spec\.ts$/u;

/**
 * What the operations job leaves to the composed and inventory jobs: the
 * union of the two rules above, as one pattern.
 */
export const composedOrInventorySpecs =
  /(?:composed-application|(?:inventory|item-stock)[^/]*)\.spec\.ts$/u;

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
