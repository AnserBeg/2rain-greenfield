import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('Buyer submits, Manager rejects and approves, then Buyer places and stages an amendment without changing quantities', async ({
  page,
}) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--verify',
      '--approvals',
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  let output = '';
  const until = (pattern: RegExp) =>
    new Promise<string>((resolve, reject) => {
      const observe = () => {
        const match = pattern.exec(output);
        if (match) {
          child.stdout.off('data', observe);
          resolve(match[1]!);
        }
      };
      child.stdout.on('data', observe);
      child.once('exit', () => reject(new Error(output)));
      observe();
    });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const url = await until(/ORDER_ENTRY_URL=(.*)/u);
    child.stdin.write(`${JSON.stringify({ phase: 'approval_order' })}\n`);
    const order = JSON.parse(await until(/ORDER_ENTRY_MEASURED=(.*)/u)) as {
      number: string;
      recordId: string;
    };
    await page.goto(url);
    const nav = page.getByRole('navigation', { name: 'Release navigation' });
    await nav.getByText('Purchasing', { exact: true }).click();
    await nav
      .getByRole('link', { name: 'Purchase orders', exact: true })
      .click();
    await page
      .getByRole('link', {
        name: `Open Purchase orders ${order.number}`,
        exact: true,
      })
      .click();
    const orderUrl = page.url();
    const act = async (label: string) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog
        .getByRole('button', { name: `Review ${label}`, exact: true })
        .click();
      await dialog
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
      await page.goto(orderUrl);
    };
    const finish = async (label: string) => {
      const dialog = page.getByRole('dialog');
      await dialog
        .getByRole('button', { name: `Review ${label}`, exact: true })
        .click();
      await dialog
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };
    const switchPerson = async (person: string) => {
      await page.getByLabel('Acting as', { exact: true }).selectOption(person);
      await page
        .getByRole('button', { name: 'Switch person', exact: true })
        .click();
      await expect(page.getByLabel('Acting as', { exact: true })).toHaveValue(
        person,
      );
    };
    const openRequest = async () => {
      const inbox = nav.getByRole('link', { name: 'Approvals', exact: true });
      if (!(await inbox.isVisible()))
        await nav.getByText('Purchasing', { exact: true }).click();
      await inbox.click();
      await page
        .getByRole('table')
        .locator('tbody tr')
        .filter({ hasText: order.number })
        .getByRole('link')
        .first()
        .click();
    };
    await expect(page.getByLabel('Acting as')).toHaveValue('buyer');
    await expect(
      page.getByRole('button', { name: 'Place order', exact: true }),
    ).toHaveCount(0);
    await act('Submit for approval');
    await openRequest();
    await expect(
      page.getByRole('button', { name: 'Approve', exact: true }),
    ).toHaveCount(0);
    await switchPerson('manager');
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Please confirm the supplier terms');
    await finish('Reject');
    await page.goto(orderUrl);
    await expect(
      page.locator(
        '[data-composition-dataset$="dataset.purchasing_approvals"]',
      ),
    ).toContainText('Please confirm the supplier terms');
    await switchPerson('buyer');
    await act('Submit for approval');
    await switchPerson('manager');
    // Decisions are reached through the declared Approvals inbox.
    await openRequest();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Supplier terms checked');
    await finish('Approve');
    await page.goto(orderUrl);
    await switchPerson('buyer');
    await page
      .getByRole('button', { name: 'Place order', exact: true })
      .click();
    await page
      .getByLabel('Supplier reference', { exact: true })
      .fill('SUP-7781');
    await finish('Place order');
    await page.goto(orderUrl);
    await expect(page.locator('.composition-header')).toContainText('Released');
    await expect(page.locator('main')).toContainText('SUP-7781');
    const lines = page.locator(
      '[data-composition-dataset$="dataset.purchasing_lines"]',
    );
    await lines
      .locator('tbody tr')
      .first()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Request quantity amendment', exact: true })
      .click();
    await page.getByLabel('New ordered quantity', { exact: true }).fill('8');
    await page.getByLabel('Reason', { exact: true }).fill('Demand increased');
    await finish('Request quantity amendment');
    await page.goto(orderUrl);
    await expect(
      lines
        .locator('tbody tr')
        .first()
        .locator('td[data-column-label="Ordered"]'),
    ).toHaveText('5');
    await openRequest();
    await switchPerson('manager');
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Keep the current quantity');
    await finish('Reject');
    await page.goto(orderUrl);
    await expect(
      lines
        .locator('tbody tr')
        .first()
        .locator('td[data-column-label="Ordered"]'),
    ).toHaveText('5');
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
});
