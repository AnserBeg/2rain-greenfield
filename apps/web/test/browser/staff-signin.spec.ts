import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('a Chromium passkey enrolls a staff member, signs in to the installed ERP, and retires the session everywhere', async () => {
  test.setTimeout(360000);
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/staff-browser-journey.ts'],
    { timeout: 330000 },
  );
});
