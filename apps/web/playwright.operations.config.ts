import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  composedOrInventorySpecs,
  operationsBrowserSpecs,
} from './playwright.shared.js';

// Purchasing, receiving and receivables, payables and the order Lists and
// pages, in a CI job of their own beside the Sales and platform specs. The
// composed application's journeys and the inventory specs match the same rule
// and run in jobs of their own (playwright.composed.config.ts,
// playwright.inventory.config.ts), so this one ignores them.
export default defineConfig({
  ...browserSuiteConfig('browser-operations'),
  projects: [
    {
      name: 'operations',
      testIgnore: composedOrInventorySpecs,
      testMatch: operationsBrowserSpecs,
    },
  ],
});
