import { defineConfig } from '@playwright/test';

import {
  browserSuiteConfig,
  composedApplicationSpecs,
} from './playwright.shared.js';

// The composed application's journeys, in a CI job of their own beside the
// operations specs. In the operations job they depended on the `operations`
// project, so the two never ran at once on one runner. On a runner of their own
// nothing contends with them, so that dependency is gone.
export default defineConfig({
  ...browserSuiteConfig('browser-composed'),
  projects: [
    {
      name: 'composed-application',
      testMatch: composedApplicationSpecs,
    },
  ],
});
