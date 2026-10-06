import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const HOUR = 60 * 60 * 1000;

interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly delivered: {
    number: string;
    recordId: string;
    lines: string[];
    receipt: { number: string; recordId: string; lines: string[] };
  };
  readonly scope: string;
}

/** An instant as the explicit-UTC picker shows it, to the second. */
const picker = (instant: Date) => instant.toISOString().slice(0, 19);

// RECEIVING-EXTRAS in the browser, against the composed application on
// PostgreSQL: the truck's receive Task asks the day the goods arrived,
// starting at today; a day after today or one past the backdate window is
// refused in plain language and receives nothing; yesterday is received as
// yesterday. A posted receipt's own page then takes back part of one line
// only -- never more than it still adds -- through Correct receipt.
test('a receive Task is dated the day goods arrived, refused in plain language outside the window, and a receipt is corrected for part of one line', async ({
  page,
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
    const dialog = page.getByRole('dialog');
    const truckUrl = url(
      'purchase_order_detail',
      'commercial_purchase_order_get',
      { record: scenario.truck.recordId },
    );
    const received = async (expected: readonly string[]) => {
      await page.goto(truckUrl);
      for (const [index, line] of scenario.truck.lines.entries())
        await expect(
          row('purchasing_lines', line).locator(
            'td[data-column-label="Received"]',
          ),
        ).toHaveText(expected[index]!);
    };

    // The truck, received on a stated day: the date starts at today, in
    // UTC as every instant here reads.
    const receiveTruck = async (receivedOn: Date | null) => {
      await page.goto(truckUrl);
      await page
        .getByRole('button', {
          name: 'Receive lines with actual cost',
          exact: true,
        })
        .click();
      await expect(
        dialog.getByRole('heading', {
          name: 'Receive lines with actual cost',
        }),
      ).toBeVisible();
      const date = dialog.getByLabel('Received on (UTC)', { exact: true });
      await expect(date).toHaveValue(
        new RegExp(`^${new Date().toISOString().slice(0, 10)}T`, 'u'),
      );
      if (receivedOn) await date.fill(picker(receivedOn));
      await dialog
        .getByRole('button', { name: 'Fill open quantities', exact: true })
        .click();
      const lineInput = (label: string, line: number) =>
        dialog.getByRole('textbox', {
          name: `${label}, Field notebook, Line ${String(line)}`,
          exact: true,
        });
      // Line 2 did not arrive.
      await lineInput('Quantity to receive', 2).fill('');
      await lineInput('Actual received unit cost', 1).fill('2.40');
      await lineInput('Actual received unit cost', 3).fill('2.5');
      await dialog
        .getByRole('button', {
          name: 'Review Receive lines with actual cost',
          exact: true,
        })
        .click();
      await dialog
        .getByRole('button', {
          name: 'Confirm Receive lines with actual cost',
          exact: true,
        })
        .click();
    };

    // A day after today: refused by the posting kernel, said plainly, and
    // nothing is received.
    await receiveTruck(new Date(Date.now() + 30 * HOUR));
    const afterToday = page.locator(
      '[data-message="OPERATION_DATE_AFTER_TODAY"]',
    );
    await expect(afterToday.locator('[data-message-sentence]')).toHaveText(
      'Date is after today',
    );
    await expect(afterToday.locator('[data-message-subject]')).toHaveText(
      'RECEIPT_FORWARD_DATE_REFUSED',
    );
    await page.screenshot({
      path: testInfo.outputPath('receiving-extras-after-today.png'),
    });
    await received(['0', '0', '0']);
    // Nine days back is past the company's seven-day window.
    await receiveTruck(new Date(Date.now() - 9 * 24 * HOUR));
    await expect(
      page
        .locator('[data-message="OPERATION_DATE_BEFORE_WINDOW"]')
        .locator('[data-message-sentence]'),
    ).toHaveText('Date is too far back');
    await received(['0', '0', '0']);
    // Yesterday: received, and the receipt reads as received yesterday.
    const yesterday = new Date(Date.now() - 24 * HOUR);
    await receiveTruck(yesterday);
    await expect(page.getByRole('status').first()).toContainText(
      'Receive lines with actual cost: done',
    );
    await received(['5', '0', '4']);
    await expect(
      dataset('purchasing_receipts')
        .locator('tbody tr')
        .filter({ hasText: 'posted' }),
    ).toContainText(yesterday.toISOString().slice(0, 10));

    // The delivered order's receipt, on its own page: its lines with what
    // each still adds to stock.
    await page.goto(
      url('purchase_order_detail', 'commercial_purchase_order_get', {
        record: scenario.delivered.recordId,
      }),
    );
    await row('purchasing_receipts', scenario.delivered.receipt.recordId)
      .getByRole('link', { name: 'Open receipt', exact: true })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      scenario.delivered.receipt.number,
    );
    const [first, second] = scenario.delivered.receipt.lines;
    const reversible = async (expected: readonly [string, string]) => {
      for (const [line, value] of [
        [first!, expected[0]],
        [second!, expected[1]],
      ] as const)
        await expect(
          row('receipt_doc_lines', line).locator(
            'td[data-column-label="Reversible"]',
          ),
        ).toHaveText(value);
    };
    await reversible(['4', '3']);
    const receiptUrl = page.url();

    const correct = async (quantity: string) => {
      await page.goto(receiptUrl);
      await page
        .getByRole('button', { name: 'Correct receipt', exact: true })
        .click();
      await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
      await dialog
        .getByRole('button', {
          name: 'Fill reversible quantities',
          exact: true,
        })
        .click();
      const quantityOf = (line: string) =>
        dialog.locator(`[data-task-row="${line}"] input`);
      await expect(quantityOf(first!)).toHaveValue('4');
      await expect(quantityOf(second!)).toHaveValue('3');
      // Only part of the first line is taken back; the second is untouched.
      await quantityOf(first!).fill(quantity);
      await quantityOf(second!).fill('');
      await dialog
        .getByLabel('Reason', { exact: true })
        .fill('One notebook arrived damaged');
      await dialog
        .getByRole('button', { name: 'Review Correct receipt', exact: true })
        .click();
      await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
      await dialog
        .getByRole('button', { name: 'Confirm Correct receipt', exact: true })
        .click();
    };
    // More than the line still adds: refused, said plainly, nothing moves.
    await correct('5');
    await expect(
      page
        .locator('[data-message="OPERATION_RECEIPT_CORRECTION_EXCEEDED"]')
        .locator('[data-message-sentence]'),
    ).toHaveText('Correction exceeds the receipt');
    await page.goto(receiptUrl);
    await reversible(['4', '3']);
    // One of the first line's four.
    await correct('1');
    await expect(page.getByRole('status').first()).toContainText(
      'Correct receipt: done',
    );
    await page.goto(receiptUrl);
    await reversible(['3', '3']);
    await expect(
      dataset('receipt_doc_corrections')
        .locator('tbody tr')
        .filter({ hasText: 'posted' }),
    ).toContainText('correction');
    await page.screenshot({
      path: testInfo.outputPath('receiving-extras-corrected.png'),
      fullPage: true,
    });
    await atPhoneWidth(
      page,
      testInfo.outputPath('receiving-extras-corrected-phone.png'),
      async () => {
        await expect(dataset('receipt_doc_lines')).toBeVisible();
      },
    );
    // The order received three on the first line and keeps the second's.
    await page
      .getByRole('link', { name: 'Open purchase order', exact: true })
      .click();
    for (const [line, value] of [
      [scenario.delivered.lines[0]!, '3'],
      [scenario.delivered.lines[1]!, '3'],
    ] as const)
      await expect(
        row('purchasing_lines', line).locator(
          'td[data-column-label="Received"]',
        ),
      ).toHaveText(value);
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
 * The order-entry fixture, served with `--verify` so the order pages'
 * scenario is seeded through its own governed operations once the
 * application is up.
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
