import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { quickSelection } from '../../test/helpers/quick-ci.js';
import { browserSuiteConfig } from './playwright.shared.js';

const { browserFiles } = quickSelection();
if (!browserFiles.length) throw new Error('Empty quick browser selection');
export default defineConfig({
  ...browserSuiteConfig('quick-browser'),
  testMatch: browserFiles.map((file) => resolve(file)),
});
