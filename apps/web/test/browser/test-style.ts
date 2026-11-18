import type { Page } from '@playwright/test';

let served = 0;

/**
 * A test-only stylesheet, as the CSP admits it (SPEED-1: `style-src 'self'`,
 * no inline style): served from a same-origin URL that this page's route
 * fulfils, then linked. The page's CSP stays enforced.
 */
export async function addTestStyle(page: Page, css: string): Promise<void> {
  served += 1;
  const url = `${new URL(page.url()).origin}/__test-style-${String(served)}.css`;
  await page.route(url, (route) =>
    route.fulfill({ body: css, contentType: 'text/css; charset=utf-8' }),
  );
  await page.addStyleTag({ url });
}
