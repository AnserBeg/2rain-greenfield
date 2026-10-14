import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  operationsBrowserSpecs,
} from './playwright.shared.js';

// The Sales and platform specs: every spec the operations config does not run.
export default defineConfig({
  ...browserSuiteConfig('browser'),
  projects: [
    {
      name: 'browser',
      testIgnore: operationsBrowserSpecs,
    },
  ],
});
