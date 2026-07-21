import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  reporter: 'list',
});
