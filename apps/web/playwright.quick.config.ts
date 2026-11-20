import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { quickFiles } from '../../test/helpers/quick-files.js';
import { browserSuiteConfig } from './playwright.shared.js';

const { browserFiles } = quickFiles();
if (!browserFiles.length) throw new Error('Empty quick browser selection');
export default defineConfig({
  ...browserSuiteConfig('quick-browser'),
  testMatch: browserFiles.map((file) => resolve(file)),
});
