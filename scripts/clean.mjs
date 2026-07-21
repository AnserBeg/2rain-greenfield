import { rmSync } from 'node:fs';

for (const directory of [
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
]) {
  rmSync(directory, { force: true, recursive: true });
}
