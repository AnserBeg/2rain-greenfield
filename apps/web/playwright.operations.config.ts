import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  composedApplicationSpecs,
  operationsBrowserSpecs,
} from './playwright.shared.js';

// Purchasing, receiving and receivables, inventory and payables, in a CI job of
// their own beside the Sales and platform specs. The composed application's
// journeys match the same rule and run in a third job
// (playwright.composed.config.ts), so this one ignores them.
export default defineConfig({
  ...browserSuiteConfig('browser-operations'),
  projects: [
    {
      name: 'operations',
      testIgnore: composedApplicationSpecs,
      testMatch: operationsBrowserSpecs,
    },
  ],
});
