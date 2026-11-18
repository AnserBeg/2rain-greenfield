import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

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
 * LOOK-1's proof: the seven screens of the Ledger mockup
 * (`docs/design/ledger-final.html`) rendered by the generator from the
 * distributor seed -- Today, a purchase order with its next step, the receive
 * dialog, stock by item, a sales order, a record type a tenant adds through
 * Customize (Equipment: draft, approve, activate, then one record's page) and
 * the new purchase order form -- each at 1440 and 390 wide, light and dark.
 * Every screen must show the Ledger's generic parts and no raw code. When
 * LOOK_EVIDENCE_OUT names a directory the screenshots are written there (the
 * committed evidence); otherwise beside the test's results.
 */
const SCREENS = [
  'home',
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

test('LOOK-1: the seven mockup screens render in the Ledger look, wide and phone, light and dark', async ({
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
          po: purchaseOrder,
          receive: purchaseOrder,
          stock: await menuDestination(page, base, 'Stock by item'),
          so: salesOrder,
          record: equipment,
          'new-po': await newPurchaseOrder(page, base),
        };

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
                fullPage: screen !== 'receive',
              });
              await requireLedgerParts(page, screen, viewport.width);
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
    home: ['.launcher-tiles .launcher-tile', '.launcher-scan'],
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
  await page.getByRole('button', { name: 'Approve' }).click();
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
