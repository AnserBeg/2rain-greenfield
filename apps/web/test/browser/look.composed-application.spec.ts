import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { scriptedModel } from '../../../../packages/operations-agent/src/index.js';
import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

import {
  createSale,
  LoopScorecard,
  placePurchaseOrder,
  rawCodes,
} from './loop-scorecard.js';

/**
 * The Ledger screens from the LOOK-1 mockup
 * (`docs/design/ledger-final.html`) rendered by the generator from the
 * distributor seed -- Today, the PO list, a purchase order and its next step, the receive
 * dialog, stock by item, a sales order, a record type a tenant adds through
 * Customize (Equipment: draft, approve, activate, then one record's page) and
 * the new purchase order form -- each at 1440 and 390 wide, light and dark.
 * Every screen must show the Ledger's generic parts and no raw code. When
 * LOOK_EVIDENCE_OUT names a directory the screenshots are written there (the
 * committed evidence); otherwise beside the test's results.
 */
const SCREENS = [
  'home',
  'po-list',
  'po',
  'receive',
  'stock',
  'so',
  'record',
  'new-po',
] as const;
type Screen = (typeof SCREENS)[number];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

test('the Ledger pages share their content edges and gutters on desktop and phone in both themes', async ({
  page,
}, testInfo) => {
  test.setTimeout(1_500_000);
  const out = process.env.LOOK_EVIDENCE_OUT
    ? resolve(process.env.LOOK_EVIDENCE_OUT)
    : testInfo.outputPath('look');
  mkdirSync(out, { recursive: true });
  await withEphemeralPostgres(
    'look-browser',
    async ({ connection }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        seedProfile: 'distributor',
        assistantModel: async () =>
          scriptedModel([
            () => ({ text: 'This purchase order is ready to receive.' }),
          ]),
        tenantSlug: 'look-browser',
      });
      try {
        page.setDefaultTimeout(60_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        const card = new LoopScorecard(page);
        const base = application.baseUrl;

        // The loop's documents, as the owner will make them.
        await page.goto(base);
        await placePurchaseOrder(card);
        const purchaseOrder = page.url();
        await createSale(card);
        const salesOrder = page.url();

        // LOOP-1's filed fold: a confirmed sales order's lines are on the
        // first screen of a 1280×800 laptop.
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(salesOrder);
        const firstLine = page
          .locator('[data-composition-dataset] tbody tr')
          .first();
        const top = await firstLine.evaluate(
          (row) => row.getBoundingClientRect().top,
        );
        expect.soft(top, 'sales order lines above the fold').toBeLessThan(800);

        // A record type a tenant adds through Customize.
        await page.setViewportSize({ width: 1440, height: 900 });
        const equipment = await addEquipment(page, base);

        const urls: Readonly<Record<Screen, string>> = {
          home: `${base}/`,
          'po-list': await menuDestination(page, base, 'Purchase orders'),
          po: purchaseOrder,
          receive: purchaseOrder,
          stock: await menuDestination(page, base, 'Stock by item'),
          so: salesOrder,
          record: equipment,
          'new-po': await newPurchaseOrder(page, base),
        };

        for (const width of [1280, 1920]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(purchaseOrder);
          await requireAlignment(page, 'po');
        }
        for (const scheme of ['light', 'dark'] as const)
          for (const viewport of VIEWPORTS) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize(viewport);
            for (const screen of SCREENS) {
              await page.goto(urls[screen]);
              if (screen === 'receive') {
                await page
                  .locator('.composition-progression-next')
                  .getByRole('link')
                  .or(
                    page
                      .locator('.composition-progression-next')
                      .getByRole('button'),
                  )
                  .first()
                  .click();
                await expect(
                  page.locator('[data-composition-task]'),
                ).toBeVisible();
              }
              // The record's menu entry -- Custom › Equipment -- in view.
              if (screen === 'record' && viewport.width > 900)
                await page
                  .getByRole('navigation', { name: 'Release navigation' })
                  .getByRole('link', { name: 'Equipment', exact: true })
                  .scrollIntoViewIfNeeded();
              // The picture first, so a red still leaves the evidence.
              await page.screenshot({
                path: `${out}/app-${screen}-${String(viewport.width)}-${scheme}.png`,
                // The phone's Receive dialog is shown whole (round 4).
                fullPage: screen !== 'receive' || viewport.width < 900,
              });
              // The phone's Receive dialog scrolls inside itself: its end is
              // a second picture (round 4).
              if (screen === 'receive' && viewport.width < 900) {
                await page
                  .locator('dialog[data-composition-task]')
                  .evaluate((dialog) => {
                    for (const node of [
                      dialog,
                      ...dialog.querySelectorAll('*'),
                    ])
                      if (node.scrollHeight > node.clientHeight + 1)
                        node.scrollTop = node.scrollHeight;
                  });
                await page.screenshot({
                  path: `${out}/app-${screen}-${String(viewport.width)}-${scheme}-end.png`,
                });
              }
              if (screen === 'po') {
                const panel = page.locator('[data-assistant-panel]');
                await page
                  .getByRole('button', { name: 'Assistant', exact: true })
                  .click();
                await panel
                  .getByRole('button', { name: 'New conversation' })
                  .click();
                await panel
                  .locator('textarea')
                  .fill('What is the next step on this purchase order?');
                await panel.getByRole('button', { name: 'Send' }).click();
                await expect(
                  panel.locator('[data-assistant-reply]'),
                ).toHaveText('This purchase order is ready to receive.');
                mkdirSync(resolve(out, 'panel-2'), { recursive: true });
                await page.screenshot({
                  path: resolve(
                    out,
                    'panel-2',
                    `po-detail-${String(viewport.width)}-${scheme}.png`,
                  ),
                });
                await panel
                  .getByRole('button', { name: 'Close the assistant' })
                  .click();
              }
              await requireLedgerParts(page, screen, viewport.width);
              if (scheme === 'light') await requireAlignment(page, screen);
              const text = await page.locator('body').innerText();
              // The order date is a date (round 2): no "(UTC)" anywhere.
              expect.soft(rawCodes(text), `${screen} raw codes`).toEqual([]);
              expect
                .soft(machineText(text), `${screen} canonical ids or instants`)
                .toEqual([]);
              expect
                .soft(
                  await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                  ),
                  `${screen} scrolls sideways at ${String(viewport.width)}`,
                )
                .toBe(true);
            }
          }
      } finally {
        await application.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

/**
 * Text only a machine writes (round 2): a canonical id such as an option's,
 * a raw instant, or a record or principal id (round 3: the chrome too) --
 * what a page shown to a person never is.
 */
function machineText(text: string): readonly string[] {
  return [
    ...text.matchAll(
      /\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z]+\.[a-z0-9_-]+|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu,
    ),
  ].map((match) => match[0]);
}

/** The Ledger's generic parts each screen must show. */
async function requireLedgerParts(
  page: Page,
  screen: Screen,
  width: number,
): Promise<void> {
  // The shell: the work queues lead the sidebar (a drawer on a phone).
  await expect.soft(page.locator('nav.work-queues a').first()).toBeAttached();
  if (width > 900) await expect.soft(page.locator('.sidebar')).toBeVisible();
  else await expect.soft(page.locator('.shell-menu > summary')).toBeVisible();
  const parts: Readonly<Record<Screen, readonly string[]>> = {
    // Searched from the top bar (round 3): no find box of its own.
    home: ['.launcher-tiles .launcher-tile', '.shell-search input'],
    'po-list': ['[data-declared-list]', '.list-controls'],
    po: [
      '.composition-header h1',
      '.composition-business-status',
      '.composition-progression-steps li',
      '.composition-progression-next',
      '.composition-header-facts',
      '.line-progress',
      '.composition-totals',
    ],
    receive: ['[data-composition-task] .composition-task-header'],
    stock: ['.list-views', 'table thead th', 'tbody tr'],
    so: [
      '.composition-header h1',
      '.composition-progression-next',
      '.composition-header-facts',
      '.line-progress',
    ],
    record: ['main h1', '[data-platform-slot="record:keyFacts"]'],
    'new-po': [
      '[data-document-editor]',
      '.draft-lines',
      '[data-save-boundary]',
    ],
  };
  for (const selector of parts[screen])
    await expect
      .soft(page.locator(selector).first(), `${screen} shows ${selector}`)
      .toBeAttached();
}

/** Measure the painted text and controls as well as their enclosing sheets. */
async function requireAlignment(page: Page, screen: Screen): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const errors = await page.evaluate((screen) => {
    const failures: string[] = [];
    function near(name: string, actual: number, expected: number) {
      if (Math.abs(actual - expected) > 1)
        failures.push(`${name}: ${actual} vs ${expected}`);
    }
    function el(selector: string): HTMLElement {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) throw new Error(`${screen} missing ${selector}`);
      return found;
    }
    const rect = (selector: string) => el(selector).getBoundingClientRect();
    function ink(node: Element) {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    }
    const grid = rect('main .surface-grid');
    const area = rect('.workspace');
    const wide = innerWidth > 900;
    near('equal page gutters', grid.left - area.left, area.right - grid.right);
    near('top bar search', rect('.shell-search').left, grid.left);
    near('top bar account', rect('.shell-account').right, grid.right);
    near('title', rect('main h1').left, grid.left);
    const sheet = (selector: string) => {
      const box = rect(selector);
      near(selector + ' left', box.left, grid.left);
      near(selector + ' right', box.right, grid.right);
    };
    if (screen === 'home') sheet('.launcher-tiles ul');
    if (screen === 'stock' || screen === 'po-list') {
      sheet('[data-declared-list]');
      const firstCell = el('[data-declared-list] tbody td');
      const cards =
        getComputedStyle(el('[data-declared-list] thead')).position ===
        'absolute';
      near(
        'search and first column',
        rect('.list-controls input[type=search]').left,
        cards ? firstCell.getBoundingClientRect().left : ink(firstCell).left,
      );
    }
    if (['po', 'so', 'new-po', 'record', 'receive'].includes(screen)) {
      near('breadcrumb', rect('.record-breadcrumb').left, grid.left);
      near(
        'eyebrow',
        rect('main :is(.surface-heading--slot,.composition-title) .eyebrow')
          .left,
        grid.left,
      );
    }
    if (screen === 'new-po') {
      for (const selector of [
        '.panel:has([data-document-editor])',
        '.draft-lines-panel',
        '.panel:has([data-save-boundary])',
      ])
        sheet(selector);
      near(
        'form inset',
        rect('[data-document-editor] legend').left,
        rect('.draft-lines-panel h2').left,
      );
      near(
        'first form cell',
        rect('.draft-line .reference-search input').left,
        rect('.draft-lines-panel h2').left,
      );
      const draft = el('[data-document-editor] .draft-header');
      const columns =
        getComputedStyle(draft).gridTemplateColumns.split(' ').length;
      const fields = [
        ...draft.querySelectorAll(
          ':scope > .form-field:not(.form-field--wide)',
        ),
      ];
      for (const [i, field] of fields.entries()) {
        const reference = fields[i % columns]!.getBoundingClientRect();
        const box = field.getBoundingClientRect();
        near('field column left', box.left, reference.left);
        near('field column right', box.right, reference.right);
      }
    }
    if (screen === 'record') {
      sheet('.panel:has(.record-section-group)');
      near(
        'record command edge',
        rect('.command-bar-slot .action-overflow summary').right,
        grid.right,
      );
      near(
        'commands at the eyebrow',
        rect('.command-bar-slot > .command-bar').top,
        rect('.surface-heading .eyebrow').top,
      );
      near(
        'record facts and section',
        rect('.record-section-group h2').left,
        rect('.record-section-group .record-fields dt').left,
      );
    }
    if (['po', 'so', 'receive'].includes(screen)) {
      sheet('.composition-progression');
      const facts = rect('.composition-facts');
      const rail = rect('.composition-rail');
      const lines = el('.composition-collection:has(.line-progress)');
      const lineRow = lines.querySelector('tbody tr')!;
      const firstCell = lineRow.querySelector(
        wide ? 'td' : 'td[data-cell-role=primary]',
      )!;
      const first = ink(firstCell.querySelector('strong') ?? firstCell);
      near('sheet left', facts.left, grid.left);
      near('joined sheets', lines.getBoundingClientRect().right, facts.right);
      near('rail right', rail.right, grid.right);
      if (!wide) near('stacked rail left', rail.left, grid.left);
      near(
        'facts and section',
        rect('.composition-header-facts dt').left,
        lines.querySelector('h2')!.getBoundingClientRect().left,
      );
      near(
        'facts and first cell',
        rect('.composition-header-facts dt').left,
        first.left,
      );
      near(
        'details inset',
        rect('[data-composition-fields] h2').left,
        first.left,
      );
      if (screen !== 'receive') {
        near(
          'header menu at eyebrow',
          rect('.composition-record-actions > summary').top,
          rect('.composition-title .eyebrow').top,
        );
        near(
          'header menu right',
          rect('.composition-record-actions > summary').right,
          grid.right,
        );
      }
      const row = document.querySelector(
        '.composition-rail [data-resolution=empty]',
      );
      if (row) {
        const label = row.querySelector('h2')!.getBoundingClientRect();
        const pill = row
          .querySelector(
            '[data-message-sentence], .composition-message strong',
          )!
          .getBoundingClientRect();
        near('rail insets', label.left - rail.left, rail.right - pill.right);
      }
      if (wide) {
        near(
          'progress baseline',
          ink(lineRow.querySelector('.line-progress > span')!).bottom,
          ink(lineRow.querySelector('td[data-cell-role=quantity]')!).bottom,
        );
        const amount = document.querySelector(
          '.composition-collection:has(.composition-totals) td[data-column-label="Amount"]',
        );
        if (amount)
          near(
            'amount and grand total',
            ink(amount).right,
            ink(el('.composition-totals div:last-child dd')).right,
          );
      }
    }
    if (screen === 'receive') {
      near(
        'dialog fields',
        rect('.composition-task-header h2').left,
        rect('.composition-inputs').left,
      );
      near(
        'dialog lines',
        rect('.composition-task-rows legend').left,
        rect('.composition-task-header h2').left,
      );
      near(
        'dialog footer',
        rect('.composition-task-footer button:last-child').right,
        rect('.composition-inputs').right,
      );
    }
    for (const table of document.querySelectorAll<HTMLTableElement>(
      'main table',
    )) {
      const head = table.tHead?.rows[0];
      const row = table.tBodies[0]?.rows[0];
      if (!row || !head || !table.getBoundingClientRect().width) continue;
      const cards = getComputedStyle(table.tHead!).position === 'absolute';
      for (const cell of row.cells) {
        const th = head.cells[cell.cellIndex];
        if (!th || !cell.getBoundingClientRect().width) continue;
        if (
          !th.matches(
            '[data-cell-kind=number],.composition-quantity,.composition-progress-heading',
          )
        )
          continue;
        near(
          (th.textContent ?? '') + ' cell right alignment',
          getComputedStyle(cell).textAlign === 'right' ? 1 : -1,
          1,
        );
        if (cards || !th.getBoundingClientRect().width) continue;
        const control = cell.querySelector('input');
        const header =
          th.querySelector('a')?.getBoundingClientRect() ?? ink(th);
        near(
          th.textContent + ' figures',
          control?.getBoundingClientRect().right ?? ink(cell).right,
          header.right,
        );
      }
    }
    return failures;
  }, screen);
  expect
    .soft(
      errors,
      `${screen} alignment at ${String(page.viewportSize()?.width)}`,
    )
    .toEqual([]);
}

async function menuDestination(
  page: Page,
  base: string,
  name: string,
): Promise<string> {
  await page.goto(base);
  await page
    .getByRole('navigation', { name: 'Release navigation' })
    .getByRole('link', { name, exact: true })
    .click();
  return page.url();
}

async function newPurchaseOrder(page: Page, base: string): Promise<string> {
  await menuDestination(page, base, 'Purchase orders');
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(page.locator('[data-document-editor]')).toBeVisible();
  return page.url();
}

/** Customize: describe Equipment, approve, activate; returns its List. */
async function addEquipment(page: Page, base: string): Promise<string> {
  await page.goto(`${base}/?customize`);
  const form = page.locator('form[data-customize-form="addRecordType"]');
  await form.locator('input[name="label"]').fill('Equipment');
  await form.locator('input[name="field_2_label"]').fill('Serial number');
  await form.locator('input[name="field_3_label"]').fill('Purchase date');
  await form.locator('select[name="field_3_type"]').selectOption('date');
  await form.locator('input[name="field_4_label"]').fill('Status');
  await form.locator('select[name="field_4_type"]').selectOption('choice');
  await form
    .locator('input[name="field_4_options"]')
    .fill('In service, Under repair, Retired');
  await form.getByRole('button', { name: 'Draft this record type' }).click();
  await expect(page.locator('[data-customize-result="drafted"]')).toBeVisible({
    timeout: 180_000,
  });
  // Approving compiles the change in the sandbox: as slow as drafting.
  await page
    .getByRole('button', { name: 'Approve' })
    .click({ timeout: 180_000 });
  await page
    .getByRole('button', { name: 'Activate now' })
    .click({ timeout: 180_000 });
  await expect(page.locator('[data-customize-result="activated"]')).toBeVisible(
    { timeout: 180_000 },
  );
  await page.getByRole('link', { name: 'Open Equipment' }).click();
  await expect(page.locator('main')).toContainText('Equipment');
  const list = page.url();
  // The record type is listed under the Custom group its customization
  // declares, by its own name (round 2).
  await expect(
    page
      .getByRole('navigation', { name: 'Release navigation' })
      .locator('details.navigation-group')
      .filter({
        has: page.locator(':scope > summary .nav-group-label', {
          hasText: /^Custom$/u,
        }),
      })
      .getByRole('link', { name: 'Equipment', exact: true }),
  ).toBeAttached();
  // One piece of equipment, entered as an office person would (round 2):
  // its record page is the screen.
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Forklift FL-07');
  await page
    .getByLabel('Serial number', { exact: true })
    .fill('TY-8FGU25-40117');
  await page.getByLabel('Purchase date', { exact: true }).fill('2025-03-14');
  await page
    .getByRole('combobox', { exact: true, name: 'Status' })
    .selectOption({ label: 'In service' });
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByRole('status')).toContainText('complete');
  await page.goto(list);
  await page
    .locator('tbody tr')
    .first()
    .getByRole('link', { name: 'Forklift FL-07' })
    .click();
  await expect(page.locator('main h1')).toContainText('Forklift FL-07');
  return page.url();
}
