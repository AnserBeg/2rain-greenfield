import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly delivered: {
    number: string;
    recordId: string;
    lines: string[];
    receipt: { number: string; recordId: string; lines: string[] };
  };
  readonly short: { number: string; recordId: string; lines: string[] };
  readonly invoice: {
    number: string;
    recordId: string;
    order: { number: string; recordId: string };
  };
  readonly scope: string;
}

// ORDER-PARITY increment B: a sales order names the lines it is short and
// shows where it stands; a truck's delivery is received as one receipt of
// several lines, filled from what is open; the latest receipt is reversed; an
// invoice opens the order it bills. The orders are seeded through the
// governed operations; the pages and their Tasks are then used in the browser,
// by keyboard, at phone width and without script.
test('an order page names its short lines and its progress, receives a truck of lines, reverses a receipt and links an invoice to its order', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (base, seed) => {
    const scenario = await seed();
    const url = (
      surface: string,
      scopeQuery: string,
      parameters: Record<string, string>,
    ) => {
      const target = new URL(base);
      target.search = '';
      target.searchParams.set('surface', `${ns}:surface.${surface}`);
      target.searchParams.set(
        `${ns}:parameter.${scopeQuery}_legal_entity_scope`,
        scenario.scope,
      );
      for (const [name, value] of Object.entries(parameters))
        target.searchParams.set(name, value);
      return target.href;
    };
    const dataset = (local: string) =>
      page.locator(`[data-composition-dataset="${ns}:dataset.${local}"]`);
    const row = (local: string, recordId: string) =>
      dataset(local).locator(`tr[data-record-id="${recordId}"]`);
    const progression = page.locator('[data-composition-progression]');

    // The sales order asks for more than is free: its banner names both
    // lines with what each is short, and its progression where it stands.
    await page.goto(
      url('sales_order_detail', 'commercial_order_get', {
        record: scenario.short.recordId,
      }),
    );
    const banner = page.getByRole('region', { name: 'Fulfillment exception' });
    await expect(banner).toBeVisible();
    const flagged = banner.getByRole('listitem');
    await expect(flagged).toHaveCount(2);
    await expect(flagged.nth(0)).toContainText('Short 1');
    await expect(flagged.nth(1)).toContainText('Short 9');
    for (const [line, short] of [
      [scenario.short.lines[0]!, '1'],
      [scenario.short.lines[1]!, '9'],
    ] as const)
      await expect(
        row('fulfillment_lines', line).locator('td[data-column-label="Short"]'),
      ).toHaveText(short);
    await expect(
      progression.getByRole('heading', { name: 'Order to cash' }),
    ).toBeVisible();
    await expect(
      progression.locator('li[data-step-state="complete"]'),
    ).toContainText('Sales order');
    await expect(
      progression.locator('li[aria-current="step"]').first(),
    ).toContainText('Fulfillment');
    await page.screenshot({
      path: testInfo.outputPath('order-pages-short.png'),
    });
    await atPhoneWidth(
      page,
      testInfo.outputPath('order-pages-short-phone.png'),
      async () => {
        await expect(banner).toBeVisible();
        await expect(progression).toBeVisible();
      },
    );

    // The truck: the order's next step, by keyboard, fills every line from
    // what is still open; line 2 did not arrive and is emptied.
    await page.goto(
      url('purchase_order_detail', 'commercial_purchase_order_get', {
        record: scenario.truck.recordId,
      }),
    );
    const next = progression.getByRole('button', {
      name: 'Next action: Receive lines with actual cost',
      exact: true,
    });
    await next.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Receive lines with actual cost' }),
    ).toBeVisible();
    const lineInput = (label: string, line: number) =>
      dialog.getByRole('textbox', {
        name: `${label}, Field notebook, Line ${String(line)}`,
        exact: true,
      });
    // Rows start empty.
    for (const line of [1, 2, 3])
      await expect(lineInput('Quantity to receive', line)).toHaveValue('');
    await dialog
      .getByRole('button', { name: 'Fill open quantities', exact: true })
      .click();
    await expect(lineInput('Quantity to receive', 1)).toHaveValue('5');
    await expect(lineInput('Quantity to receive', 2)).toHaveValue('2');
    await expect(lineInput('Quantity to receive', 3)).toHaveValue('4');
    await lineInput('Quantity to receive', 2).fill('');
    await lineInput('Actual received unit cost', 1).fill('2.40');
    await lineInput('Actual received unit cost', 3).fill('2.5');
    await dialog
      .getByLabel('Packing slip / delivery note', { exact: true })
      .fill('PS-TRUCK');
    await atPhoneWidth(
      page,
      testInfo.outputPath('order-pages-truck-phone.png'),
      async () => {
        await expect(lineInput('Quantity to receive', 3)).toBeVisible();
      },
    );
    await dialog
      .getByRole('button', {
        name: 'Review Receive lines with actual cost',
        exact: true,
      })
      .click();
    // Two lines are reviewed; the empty one is not received.
    await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
    await dialog
      .getByRole('button', {
        name: 'Confirm Receive lines with actual cost',
        exact: true,
      })
      .click();
    await expect(page.getByRole('status').first()).toContainText(
      'Receive lines with actual cost: done',
    );
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    for (const [line, received] of [
      [scenario.truck.lines[0]!, '5'],
      [scenario.truck.lines[1]!, '0'],
      [scenario.truck.lines[2]!, '4'],
    ] as const)
      await expect(
        row('purchasing_lines', line).locator(
          'td[data-column-label="Received"]',
        ),
      ).toHaveText(received);
    await expect(dataset('purchasing_receipts')).toContainText(/RCV-\d{6}/u);
    await expect(dataset('purchasing_receipts')).toContainText('PS-TRUCK');

    // The delivered order's receipt, reversed: every line at exactly what it
    // received, back to nothing received.
    await page.goto(
      url('purchase_order_detail', 'commercial_purchase_order_get', {
        record: scenario.delivered.recordId,
      }),
    );
    await row('purchasing_receipts', scenario.delivered.receipt.recordId)
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    for (const [line, reversible] of [
      [scenario.delivered.receipt.lines[0]!, '4'],
      [scenario.delivered.receipt.lines[1]!, '3'],
    ] as const)
      await expect(
        row('purchasing_receipt_lines', line).locator(
          'td[data-column-label="Reversible"]',
        ),
      ).toHaveText(reversible);
    await page
      .getByRole('button', { name: 'Reverse receipt', exact: true })
      .click();
    await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Delivered to the wrong dock');
    await dialog
      .getByRole('button', { name: 'Review Reverse receipt', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Confirm Reverse receipt', exact: true })
      .click();
    await expect(page.getByRole('status').first()).toContainText(
      'Reverse receipt: done',
    );
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    for (const line of scenario.delivered.lines)
      await expect(
        row('purchasing_lines', line).locator(
          'td[data-column-label="Received"]',
        ),
      ).toHaveText('0');
    for (const line of scenario.delivered.receipt.lines)
      await expect(
        row('purchasing_receipt_lines', line).locator(
          'td[data-column-label="Reversible"]',
        ),
      ).toHaveText('0');
    await expect(
      page.getByRole('button', { name: 'Reverse receipt', exact: true }),
    ).toHaveCount(0);

    // The invoice names the order it bills and opens it.
    await page.goto(
      url('customer_invoice_detail', 'customer_invoice_get', {
        record: scenario.invoice.recordId,
      }),
    );
    await expect(
      page
        .locator('.composition-header-facts > div')
        .filter({ has: page.locator('dt', { hasText: /^Sales order$/u }) })
        .locator('dd'),
    ).toHaveText(scenario.invoice.order.number);
    await page
      .getByRole('link', { name: 'Open sales order', exact: true })
      .click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    await expect(page.locator('.composition-header h1')).toHaveText(
      scenario.invoice.order.number,
    );

    // Without script the same Task fills on the server.
    const plain = await browser.newContext({ javaScriptEnabled: false });
    try {
      const noScript = await plain.newPage();
      noScript.setDefaultTimeout(30_000);
      await noScript.goto(
        url('purchase_order_detail', 'commercial_purchase_order_get', {
          record: scenario.truck.recordId,
        }),
      );
      await noScript
        .getByRole('button', {
          name: 'Receive lines with cost explicitly absent',
          exact: true,
        })
        .click();
      const task = noScript.locator('[data-composition-task]');
      await task
        .getByRole('button', { name: 'Fill open quantities', exact: true })
        .click();
      // Line 2's two are still to arrive; lines 1 and 3 have nothing open.
      await expect(
        task.getByRole('textbox', {
          name: 'Quantity to receive, Field notebook, Line 2',
          exact: true,
        }),
      ).toHaveValue('2');
      await expect(task.locator('[data-task-row]')).toHaveCount(1);
    } finally {
      await plain.close();
    }
  });
});

/** One screen width at phone size: the page scrolls down, never sideways. */
async function atPhoneWidth(
  page: Page,
  path: string,
  check: () => Promise<void>,
) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await check();
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * The order-entry fixture, served with `--verify` so the scenario is seeded
 * through its own governed operations once the application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<Scenario>) => Promise<void>,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--verify',
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let pending = '';
  let seeded: ((value: Scenario) => void) | null = null;
  const exited = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
      if (match) resolve(match[1]!);
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines)
        if (line.startsWith('ORDER_ENTRY_MEASURED=')) {
          seeded?.(
            JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)) as Scenario,
          );
          seeded = null;
        }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', () => reject(new Error(output)));
  });
  const seed = () =>
    new Promise<Scenario>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase: 'order_pages' })}\n`);
    });
  try {
    await run(await ready, seed);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
