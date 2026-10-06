import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  composedApplicationSpecs,
  inventoryBrowserSpecs,
} from './playwright.shared.js';

// The inventory and item stock specs, in a CI job of their own beside the
// operations specs, under the same 20-minute bound (INTEGRATION).
export default defineConfig({
  ...browserSuiteConfig('browser-inventory'),
  projects: [
    {
      name: 'inventory',
      testIgnore: composedApplicationSpecs,
      testMatch: inventoryBrowserSpecs,
    },
  ],
});
