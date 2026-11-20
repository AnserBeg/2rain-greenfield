import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  customizationRulesSpecs,
} from './playwright.shared.js';

// The Customize journeys boot and activate releases in isolated PostgreSQL
// fixtures. Run them beside the other composed journeys within the same bound.
export default defineConfig({
  ...browserSuiteConfig('browser-rules'),
  projects: [
    {
      name: 'customization-rules',
      testMatch: customizationRulesSpecs,
    },
  ],
});
