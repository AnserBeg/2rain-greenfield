import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
/** Field notebook, the demo seed's first product. */
const FIELD_NOTEBOOK = '71000000-0000-4000-8000-000000000011';

// STOCK-COUNTS: a count of one location, entered from the menu the way a
// person enters one. Before the journey the fixture moves Field notebook's
// stock through the governed operations: Calgary warehouse holds 13 with 1
// still reserved for a sales order, Vancouver warehouse 6.
test('a count of one location starts from posted stock, is reviewed against the ledger and posted, then corrected and the correction reversed', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    await seed();
    await page.goto(url);
    expect(await stock(page)).toEqual({ 'CAL-WH': '13', 'VAN-WH': '6' });

    // Stock -> Stock counts -> New: pick the location, a reason and a
    // narrative; the server numbers the count when it is saved.
    await openNew(page);
    await pick(page, 'Location', 'Vancouver', 'Vancouver warehouse');
    await page
      .getByLabel('Reason', { exact: true })
      .selectOption({ label: 'Physical count' });
    await page
      .getByLabel('Narrative', { exact: true })
      .fill('Cycle count of the Vancouver warehouse');
    for (const local of ['number', 'state', 'kind', 'counted_at'])
      await expect(
        page.locator(`[name$=":${ns}:field.stock_count_${local}"]`),
      ).toHaveCount(0);
    // A new count opens with one blank line; Start counting adds the
    // location's products, so the blank line goes.
    await page
      .getByRole('button', { name: 'Remove line 1', exact: true })
      .click();
    const count = await saveDraft(page);

    // Start counting lists every product posted here; Expected is the posted
    // stock now, and nothing is counted yet.
    await command(page, 'Start counting');
    await page.goto(count.url);
    expect(await lines(page)).toEqual([
      {
        Line: '1',
        Product: 'Field notebook',
        Expected: '6',
        'Physical count': '—',
        Variance: '—',
        Unit: 'EA',
      },
    ]);
    await page.screenshot({
      path: testInfo.outputPath('stock-count-counting.png'),
      fullPage: true,
    });

    // Five are found on the shelf.
    await edit(page);
    await page.getByLabel('Line 1 physical count', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.goto(count.url);
    expect((await lines(page))[0]).toMatchObject({
      'Physical count': '5',
      Variance: '-1',
    });

    // Review freezes what posts: expected from posted stock as of now.
    await command(page, 'Review');
    await page.goto(count.url);
    expect((await lines(page))[0]).toMatchObject({
      Expected: '6',
      'Physical count': '5',
      Variance: '-1',
    });
    await command(page, 'Post', ['6', '5']);
    await page.goto(count.url);
    // The role reads as the posting role's option, as on the item page.
    expect(await movements(page)).toEqual([['Field notebook', '-1', 'count']]);
    await page.screenshot({
      path: testInfo.outputPath('stock-count-posted.png'),
      fullPage: true,
    });
    expect(await stock(page)).toEqual({ 'CAL-WH': '13', 'VAN-WH': '5' });

    // The count was wrong: a correction recounts the same products there.
    await page.goto(count.url);
    await runTask(page, 'Correct', async () => {
      await page
        .getByLabel('Narrative', { exact: true })
        .fill('A box was behind the shelf');
    });
    await page.goto(count.url);
    const corrections = compensations(page);
    await expect(corrections).toHaveCount(1);
    await corrections.first().getByRole('link', { name: 'Open' }).click();
    const correction = page.url();
    await expect(
      page.getByRole('heading', { level: 1, name: /^CNT-\d{6}$/u }),
    ).toBeVisible();
    await edit(page);
    await page.getByLabel('Line 1 physical count', { exact: true }).fill('6');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.goto(correction);
    await command(page, 'Review');
    await page.goto(correction);
    await command(page, 'Post', ['5', '6']);
    expect(await stock(page)).toEqual({ 'CAL-WH': '13', 'VAN-WH': '6' });

    // Entered against the wrong warehouse after all: the correction is
    // reversed whole, each movement exactly undone.
    await page.goto(correction);
    await runTask(page, 'Reverse', async () => {
      await page
        .getByLabel('Reason', { exact: true })
        .fill('Recounted the wrong bay');
    });
    expect(await stock(page)).toEqual({ 'CAL-WH': '13', 'VAN-WH': '5' });

    // The counts List: three counts, all posted.
    await page.goto(url);
    await openCounts(page);
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'Posted 3' })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('stock-counts-list.png'),
      fullPage: true,
    });
  });
});

/** Stock -> Stock counts, from the menu. */
async function openCounts(page: Page) {
  const counts = page
    .getByRole('navigation', { name: 'Release navigation' })
    .getByRole('link', { name: 'Stock counts', exact: true });
  if (!(await counts.isVisible())) {
    const stockGroup = page
      .getByRole('navigation', { name: 'Release navigation' })
      .getByRole('group')
      .filter({
        has: page
          .locator(':scope > summary')
          .getByText('Stock', { exact: true }),
      });
    await stockGroup.getByText('Stock', { exact: true }).click();
  }
  await counts.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Stock counts' }),
  ).toBeVisible();
}

/** Stock -> Stock counts -> New. */
async function openNew(page: Page) {
  await openCounts(page);
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Stock count' }),
  ).toBeVisible();
}

interface Saved {
  readonly number: string;
  readonly url: string;
}

/** Save draft opens the saved count, titled by the number the server gave. */
async function saveDraft(page: Page): Promise<Saved> {
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/stock_count_detail/u);
  const title = page.getByRole('heading', { level: 1, name: /^CNT-\d{6}$/u });
  await expect(title).toBeVisible();
  return { number: (await title.innerText()).trim(), url: page.url() };
}

/** The count's own editor, from its page. */
async function edit(page: Page) {
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (await secondary.count()) await secondary.click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByLabel('Line 1 physical count', { exact: true }),
  ).toBeVisible();
}

/** Run a count task and verify that its stages stay on the same record page. */
async function command(
  page: Page,
  label: string,
  impact?: readonly [string, string],
) {
  const url = page.url();
  await page.evaluate(() =>
    document.body.setAttribute('data-count-journey', 'active'),
  );
  const action = page.getByRole('button', { name: label, exact: true });
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (!(await action.isVisible()) && (await secondary.count()))
    await secondary.click();
  await action.click();

  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: `Review ${label}`, exact: true })
    .click();
  if (impact) {
    const onHand = dialog
      .locator('[data-task-prepared] [data-stock-impact="onHand"]')
      .first();
    await expect(onHand.locator('[data-impact-before]')).toHaveText(impact[0]);
    await expect(onHand.locator('[data-impact-after]')).toHaveText(impact[1]);
  }
  await dialog
    .getByRole('button', { name: `Confirm ${label}`, exact: true })
    .click();
  await expectTaskResult(page, label);
  await expect(page).toHaveURL(url);
  await expect(page.locator('body')).toHaveAttribute(
    'data-count-journey',
    'active',
  );
}

/** A declared task on the count: its inputs, Review, Confirm. */
async function runTask(page: Page, label: string, fill: () => Promise<void>) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await fill();
  await page
    .getByRole('button', { name: `Review ${label}`, exact: true })
    .click();
  await page
    .getByRole('button', { name: `Confirm ${label}`, exact: true })
    .click();
  await expectTaskResult(page, label);
}

async function expectTaskResult(page: Page, label: string) {
  await expect
    .poll(
      async () => {
        const result = page.locator('[data-task-result]');
        if (await result.count()) return result.last().textContent();
        return page
          .locator('[data-diagnostic-code]:visible')
          .evaluateAll((nodes) =>
            nodes
              .map((node) =>
                [
                  node.getAttribute('data-diagnostic-code'),
                  node.textContent,
                ].join(' '),
              )
              .join(', '),
          );
      },
      { timeout: 30_000 },
    )
    .toContain(`${label}: done`);
}

/** The counts that correct or reverse this one. */
function compensations(page: Page) {
  return page
    .locator(
      `[data-composition-dataset="${ns}:dataset.stock_count_compensations"]`,
    )
    .locator('tbody tr');
}

/** The count's lines as its page states them. */
async function lines(page: Page) {
  return rows(
    page.locator(
      `[data-composition-dataset="${ns}:dataset.stock_count_stock_count_line"]`,
    ),
  );
}

/** What the count posted: product, signed change and role. */
async function movements(page: Page) {
  return (
    await rows(
      page.locator(
        `[data-composition-dataset="${ns}:dataset.stock_count_movements"]`,
      ),
    )
  ).map((row) => [row.Product, row['Quantity change'], row.Role]);
}

/**
 * Types into a picker and chooses an offered record -- in place with the
 * owned script, as ordinary submits without it -- then waits for the field to
 * show the selection.
 */
async function pick(page: Page, name: string, term: string, option: string) {
  const box = page.getByRole('combobox', { name, exact: true });
  await box.fill(term);
  if (!(await page.locator('body[data-reference-enhanced]').count()))
    await page
      .locator('[data-reference-control]')
      .filter({ has: box })
      .getByRole('button', { name: 'Search', exact: true })
      .click();
  await page
    .getByRole('option')
    .filter({ has: page.locator('strong', { hasText: option }) })
    .first()
    .click();
  await expect(
    page.getByRole('combobox', { name, exact: true }),
  ).toHaveAttribute('data-selected-label', option);
}

/** Field notebook's on hand by location code, as its item page shows it. */
async function stock(page: Page): Promise<Record<string, string>> {
  const url = new URL(page.url());
  await page.goto(
    `${url.origin}/?${new URLSearchParams({
      surface: `${ns}:surface.item_detail`,
      record: FIELD_NOTEBOOK,
    }).toString()}`,
  );
  await expect(
    page.getByRole('heading', { level: 1, name: 'Field notebook' }),
  ).toBeVisible();
  return Object.fromEntries(
    (
      await rows(
        page.locator(`[data-composition-dataset="${ns}:dataset.item_stock"]`),
      )
    )
      .map((row) => [row.Location!, row['On hand']!] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** Each row of a section as its column labels and shown values. */
async function rows(section: Locator) {
  return section
    .locator('tr[data-record-id]')
    .evaluateAll((elements) =>
      elements.map(
        (row) =>
          Object.fromEntries(
            [...row.querySelectorAll('td[data-column-label]')].map((cell) => [
              cell.getAttribute('data-column-label')!,
              (cell.querySelector('strong') ?? cell).textContent!.trim(),
            ]),
          ) as Record<string, string>,
      ),
    );
}

/**
 * The order-entry fixture, served with `--verify` so the item page's stock
 * scenario is seeded through its own governed operations once the
 * application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<unknown>) => Promise<void>,
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
  let seeded: ((value: unknown) => void) | null = null;
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
          seeded?.(JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)));
          seeded = null;
        }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', () => reject(new Error(output)));
  });
  const seed = () =>
    new Promise<unknown>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase: 'item_stock' })}\n`);
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
