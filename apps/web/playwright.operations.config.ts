import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  composedApplicationSpecs,
  operationsBrowserSpecs,
} from './playwright.shared.js';

// Purchasing, receiving and receivables, inventory, payables and the composed
// application, in a CI job of their own beside the Sales and platform specs.
// The composed journeys still wait for every other spec in their run, as they
// waited for the whole suite when it was one job, so the rest never contend
// with them.
export default defineConfig({
  ...browserSuiteConfig('browser-operations'),
  projects: [
    {
      name: 'operations',
      testIgnore: composedApplicationSpecs,
      testMatch: operationsBrowserSpecs,
    },
    {
      dependencies: ['operations'],
      name: 'composed-application',
      testMatch: composedApplicationSpecs,
    },
  ],
});
