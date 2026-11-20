import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';

import {parseServerTiming} from '../../../../packages/postgres-provider/src/request-work-meter.js';
import {randomUUID} from 'node:crypto';
import {mock} from 'node:test';
import {SEMANTIC_OPERATION_REQUEST_VERSION,SemanticOperationGateway} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {SEMANTIC_QUERY_REQUEST_VERSION} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

const equipmentList = 'northstar.app:surface.custom_equipment_list';

test('a person adds a count to Today, opens its list and rolls it back', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await withEphemeralPostgres(
    'customize-metric-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-metric-browser',
        seedProfile: 'distributor',
        port: 0,
      });
      try {
        await page.goto(`${app.baseUrl}/?customize`);
        const picker = page.locator('[data-customize-form="addMetricCard"]');
        await picker
          .getByLabel('List')
          .selectOption('northstar.app:surface.location_list');
        await picker.getByRole('button', { name: 'Set up metric' }).click();
        await page.getByLabel('Card name').fill('Location count');
        await page.getByRole('button', { name: 'Draft metric' }).click();
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'counts records in Locations',
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(app.baseUrl);
        const metric = page.getByRole('link', { name: /^Location count/u });
        const count = await metric
          .locator('.launcher-tile__count')
          .textContent();
        expect(Number(count)).toBeGreaterThan(0);
        await metric.click();
        await expect(page.locator('[data-list-total]')).toHaveAttribute(
          'data-list-total',
          count!,
        );
        await page.goto(`${app.baseUrl}/?customize`);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click();
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(app.baseUrl);
        await expect(metric).toHaveCount(0);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

/**
 * The non-developer path (CUSTOMIZE slices 3 and 5): on the Customize screen a
 * person describes Equipment, reads the plain diff, approves and activates it,
 * opens the new list with no restart, and rolls it back. The elapsed time from
 * opening the screen to the live list is printed for the week-6 record and
 * must stay under ten minutes.
 */
/**
 * The non-developer path (CUSTOMIZE slices 3 and 5): on the Customize screen a
 * person describes Equipment, reads the plain diff, approves and activates it,
 * opens the new list with no restart, and rolls it back. The elapsed time from
 * opening the screen to the live list is printed for the week-6 record and
 * must stay under ten minutes.
 */
test('a person adds a record type on the Customize screen, uses it live, and rolls it back', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await withEphemeralPostgres(
    'customize-browser',
    async ({ connection }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      const application = await startComposedApplication({
        databaseUrl,
        port: 0,
        tenantSlug: 'customize-browser',
      });
      try {
        const started = performance.now();
        await page.goto(`${application.baseUrl}/?customize`);
        await expect(page.locator('[data-customize-live]')).toContainText(
          'The standard application',
        );
        const form = page.locator('form[data-customize-form="addRecordType"]');
        await form.locator('input[name="label"]').fill('Equipment');
        await form.locator('input[name="field_2_label"]').fill('Serial number');
        await form.locator('input[name="field_3_label"]').fill('Purchase date');
        await form.locator('select[name="field_3_type"]').selectOption('date');
        await form.locator('input[name="field_4_label"]').fill('Status');
        await form
          .locator('select[name="field_4_type"]')
          .selectOption('choice');
        await form
          .locator('input[name="field_4_options"]')
          .fill('In service, Under repair, Retired');
        await form
          .getByRole('button', { name: 'Draft this record type' })
          .click();

        await expect(
          page.locator('[data-customize-result="drafted"]'),
        ).toBeVisible({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff] pre')).toContainText(
          'New record type "Equipment" with 4 fields',
        );
        await expect(page.locator('[data-customize-diff] pre')).toContainText(
          'Status (one of "In service", "Under repair", "Retired")',
        );
        await page.getByRole('button', { name: 'Approve' }).click();
        await expect(
          page.getByRole('button', { name: 'Activate now' }),
        ).toBeVisible({ timeout: 180_000 });
        await page.getByRole('button', { name: 'Activate now' }).click();
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });

        await page.getByRole('link', { name: 'Open Equipment' }).click();
        await expect(page).toHaveURL(
          new RegExp(encodeURIComponent(equipmentList)),
        );
        await expect(page.locator('main')).toContainText('Equipment');
        await expect(page.locator('body')).not.toContainText('UNKNOWN_SURFACE');
        const liveMilliseconds = Math.round(performance.now() - started);
        console.log(`CUSTOMIZE_REHEARSAL_LIVE_MS ${String(liveMilliseconds)}`);
        expect(liveMilliseconds).toBeLessThan(600_000);

        await page.goto(`${application.baseUrl}/?customize`);
        await expect(page.locator('[data-customize-live]')).toContainText(
          'New record type "Equipment"',
        );
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click();
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        const hidden = await page.goto(
          `${application.baseUrl}/?surface=${encodeURIComponent(equipmentList)}`,
        );
        expect(hidden?.status()).toBe(404);
        console.log(
          `CUSTOMIZE_REHEARSAL_TOTAL_MS ${String(Math.round(performance.now() - started))}`,
        );
      } finally {
        await application.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

for (const target of ['purchase_order', 'party'] as const) {
  test(`a field added to ${target} can be entered under More details and read on the saved record`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await withEphemeralPostgres(
      'customize-' + target.replaceAll('_', '-'),
      async ({ connection }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-field',
          port: 0,
          seedProfile: 'distributor',
        });
        try {
          await page.goto(app.baseUrl + '/?customize');
          const form = page.locator('[data-customize-form="addField"]');
          await form
            .locator('[name="entity"]')
            .selectOption('northstar.app:entity.' + target);
          await form.locator('[name="field_1_label"]').fill('Person ordering');
          await form.getByRole('button', { name: 'Draft this field' }).click();
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click({ timeout: 180_000 });
          await page
            .getByRole('button', { name: 'Activate now' })
            .click({ timeout: 180_000 });
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toBeVisible({ timeout: 180_000 });
          const surface = (role: string) =>
            app.baseUrl +
            '/?surface=' +
            encodeURIComponent('northstar.app:surface.' + target + '_' + role);
          await page.goto(surface('list'));
          await page.getByRole('link', { name: 'New', exact: true }).click();
          if (target === 'purchase_order') {
            for (const [label, term, result] of [
              ['Vendor', 'Cascade', 'Cascade Fastener Works'],
              ['Line 1 product', 'OFF-100', 'Field notebook'],
            ] as const) {
              const box = page.getByRole('combobox', {
                name: label,
                exact: true,
              });
              await box.fill(term);
              await page
                .getByRole('option')
                .filter({ hasText: result })
                .click();
              await expect(box).toHaveAttribute('data-selected-label', result);
            }
            await page.getByLabel('Order date *').fill('2026-11-18');
            await page.getByLabel('Line 1 quantity', { exact: true }).fill('2');
            await page
              .getByLabel('Line 1 unit cost', { exact: true })
              .fill('12.5');
          } else {
            await page.getByLabel('Number', { exact: true }).fill('C2-PARTY');
            await page
              .getByLabel('Name', { exact: true })
              .fill('CUSTOMIZE-2 Party');
          }
          const details = page.locator('details').filter({
            has: page.getByLabel('Person ordering', { exact: true }),
          });
          await expect(details.locator('summary')).toContainText(
            'More details',
          );
          await details.locator('summary').click();
          await details
            .getByLabel('Person ordering', { exact: true })
            .fill('Morgan Bell');
          await page
            .getByRole('button', {
              name: target === 'party' ? 'Save' : 'Save draft',
              exact: true,
            })
            .click();
          if (target === 'party') {
            await expect(
              page.getByRole('status').filter({ hasText: 'Create complete' }),
            ).toBeVisible();
            await page.goto(surface('list') + '&q=C2-PARTY');
            await page.getByRole('link', { name: /C2-PARTY/u }).click();
          }
          await expect(page).toHaveURL(new RegExp(target + '_detail', 'u'));
          const panel = page.locator('[data-composition-fields]');
          const more = panel
            .locator('details')
            .filter({ has: page.getByText('Morgan Bell', { exact: true }) });
          if (await more.count()) await more.locator('summary').click();
          await expect(
            panel.getByText('Person ordering', { exact: true }),
          ).toBeVisible();
          await expect(
            panel.getByText('Morgan Bell', { exact: true }),
          ).toBeVisible();
          if (target === 'purchase_order') {
            await page.goto(app.baseUrl + '/?customize');
            const chooser = page.locator(
              '[data-customize-form="arrangeLayout"]',
            );
            await chooser
              .locator('[name="arrange"]')
              .selectOption('northstar.app:surface.purchase_order_list');
            await chooser
              .getByRole('button', { name: 'Choose columns' })
              .click();
            const arrangement = page.locator(
              '[data-customize-form="arrangeColumns"]',
            );
            for (const label of ['Person ordering', 'Notes']) {
              await arrangement
                .getByLabel('Hide ' + label, { exact: true })
                .uncheck();
            }
            await arrangement
              .getByRole('button', { name: 'Draft this arrangement' })
              .click();
            await page
              .getByRole('button', { name: 'Approve', exact: true })
              .click({ timeout: 180_000 });
            await page
              .getByRole('button', { name: 'Activate now' })
              .click({ timeout: 180_000 });
            await expect(
              page.locator('[data-customize-result="activated"]'),
            ).toBeVisible({ timeout: 180_000 });
            await page.goto(surface('list'));
            const grid = page.locator('[data-declared-list="true"]');
            const personOrdering = grid.getByRole('columnheader', {
              name: /^Person ordering\b/u,
            });
            const notes = grid.getByRole('columnheader', { name: /^Notes\b/u });
            await expect(personOrdering).toBeVisible();
            await expect(notes).toBeVisible();
            await expect(
              grid.getByRole('cell', { name: 'Morgan Bell', exact: true }),
            ).toBeVisible();
            await page.goto(app.baseUrl + '/?customize');
            await page
              .getByRole('button', { name: 'Roll back the latest change' })
              .click();
            await expect(
              page.locator('[data-customize-result="rolledBack"]'),
            ).toBeVisible({ timeout: 180_000 });
            await page.goto(surface('list'));
            await expect(grid.getByRole('columnheader').first()).toBeVisible();
            await expect(personOrdering).toHaveCount(0);
            await expect(notes).toHaveCount(0);
          }
        } finally {
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  });
}

test('a buyer saves and reopens a purchase order with a moved Vendor, totals and next step', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  await withEphemeralPostgres(
    'customize-layout-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-layout-browser',
        seedProfile: 'distributor',
        port: 0,
      });
      try {
        const customize = app.baseUrl + '/?customize';
        const arrange = async (target = 'purchase_order_form/create') => {
          await page.goto(customize);
          const chooser = page.getByRole('group', {
            name: 'Arrange a form or record page',
          });
          await chooser
            .getByLabel('Page', { exact: true })
            .selectOption('northstar.app:surface.' + target);
          await chooser.getByRole('button', { name: 'Choose page' }).click();
        };
        const activate = async () => {
          await expect(page.locator('[data-customize-result]')).toHaveAttribute(
            'data-customize-result',
            'drafted',
          );
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click({ timeout: 180_000 });
          await page
            .getByRole('button', { name: 'Activate now' })
            .click({ timeout: 180_000 });
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toBeVisible();
        };
        await arrange();
        await page.getByLabel('Section name').fill('Delivery');
        await page.getByRole('button', { name: 'Draft new section' }).click();
        await activate();
        await arrange();
        const vendor = page.getByRole('group', { name: 'Vendor', exact: true });
        await vendor
          .getByLabel('Destination')
          .selectOption({ label: 'Delivery' });
        await vendor.getByRole('button', { name: 'Move field' }).click();
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'Delivery (Vendor)',
        );
        await activate();
        await page.goto(
          app.baseUrl + '/?surface=northstar.app%3Asurface.purchase_order_list',
        );
        await page
          .getByRole('link', { name: 'New', exact: true })
          .first()
          .click();
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 840 });
          const group = page.getByRole('group', {
            name: 'Delivery',
            exact: true,
          });
          const picker = group.getByRole('combobox', {
            name: 'Vendor',
            exact: true,
          });
          await expect(picker).toBeVisible();
          await expect(
            page.getByRole('combobox', { name: 'Vendor', exact: true }),
          ).toHaveCount(1);
        }
        const picker = page.getByRole('combobox', {
          name: 'Vendor',
          exact: true,
        });
        await picker.fill('Cascade');
        await page
          .getByRole('option')
          .filter({ hasText: 'Cascade Fastener Works' })
          .first()
          .click();
        await expect(picker).toHaveAttribute(
          'data-selected-label',
          'Cascade Fastener Works',
        );
        const product = page.getByRole('combobox', {
          name: 'Line 1 product',
          exact: true,
        });
        await product.fill('OFF-100');
        await page
          .getByRole('option')
          .filter({ hasText: 'Field notebook' })
          .click();
        await expect(product).toHaveAttribute(
          'data-selected-label',
          'Field notebook',
        );
        await page.getByLabel('Order date *').fill('2026-11-18');
        await page.getByLabel('Line 1 quantity', { exact: true }).fill('2');
        await page.getByLabel('Line 1 unit cost', { exact: true }).fill('12.5');
        await page
          .getByRole('button', { name: 'Save draft', exact: true })
          .click();
        await expect(page).toHaveURL(/purchase_order_detail/u);
        const saved = page.url();
        const total = page.locator('.composition-totals > div:last-child dd');
        await expect(total).toHaveText(/\d/u);
        const savedTotal = await total.innerText();
        const next = page.locator('.composition-progression-next');
        await expect(next).toBeVisible();
        const savedNext = await next.innerText();

        await arrange('purchase_order_detail/detail');
        await page
          .getByRole('group', { name: 'Tables and totals', exact: true })
          .getByRole('button', { name: 'Move up' })
          .click();
        await activate();
        await page.goto(saved);
        await expect(page.locator('.composition-subtitle')).toContainText(
          'Cascade Fastener Works',
        );
        const movedTotal = page.locator(
          '.composed-record-body .composition-collection .composition-totals',
        );
        const movedNext = page.locator(
          '.composed-record-body [data-composition-progression] .composition-progression-next',
        );
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 840 });
          await expect(movedTotal).toBeVisible();
          await expect(total).toHaveText(savedTotal);
          await expect(movedNext).toBeVisible();
          await expect(movedNext).toHaveText(savedNext, { useInnerText: true });
        }
        await expect(
          page.locator(
            '.composed-record-body .composition-collection:has(.composition-totals) ~ [data-composition-progression]',
          ),
        ).toHaveCount(1);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

test('a keyboard user moves a card through its reviewed Task with JavaScript disabled', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  await withEphemeralPostgres(
    'customize-board-browser',
    async ({ connection }) => {
      const options = {
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-board-browser',
      };
      const app = await startComposedApplication({ ...options, port: 0 });
      const opened = await openCustomizeService(options);
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      try {
        const draft = await opened.service.draft(
          {
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Opportunity',
                fields: [{ label: 'Name', type: 'text', required: true }],
              },
              {
                kind: 'declareLifecycle',
                entity: 'northstar.app:entity.custom_opportunity',
                initial: 'Open',
                states: [{ label: 'Open' }, { label: 'Won', role: 'success' }],
                transitions: [{ from: 'Open', to: 'Won', label: 'Mark won' }],
              },
            ],
          },
          'visualBuilder',
        );
        if (draft.status !== 'drafted') throw new Error(JSON.stringify(draft));
        await opened.service.approve(draft.patchId);
        await opened.service.activate(draft.patchId);
        const {runtime}=app;
        const identity={headers:{cookie:'northstar-demo-actor=manager'}};
        const recordId=randomUUID();
        const createCard=(name:string,recordId:string)=>runtime.entry.run(identity,async view=>{
          const result=await runtime.operationGateway.invoke(view,{
            schemaVersion:SEMANTIC_OPERATION_REQUEST_VERSION,
            operationId:'northstar.app:operation.custom_opportunity_create',
            idempotencyKey:randomUUID(), confirmationGrant:null,
            input:{recordId,values:{'northstar.app:field.custom_opportunity_name':name}},
          },runtime.operationMediation.issueInvocation(view,'UI'));
          if (!result.readBack) throw new Error('The Opportunity fixture could not be created.');
          return result.readBack;
        });
        const card=await createCard('Westside renewal',recordId);
        const before=()=>runtime.entry.run(identity,async view=>{
          const result=await runtime.queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,
            queryId:'northstar.app:query.custom_opportunity_get',arguments:{recordId}});
          if (!result.records[0]) throw new Error('The Opportunity is unavailable.');
          return result.records[0];
        });
        const invocation=mock.method(SemanticOperationGateway.prototype,'invoke');
        const moves=()=>invocation.mock.calls.filter(call=>(call.arguments[1] as {operationId:string}).operationId==='northstar.app:operation.custom_opportunity_action_mark_won');
        const chooser = page.getByRole('group', {
          name: 'Add view',
          exact: true,
        });
        await page.goto(app.baseUrl + '/?customize');
        await chooser
          .getByLabel('Record type')
          .selectOption('northstar.app:surface.custom_opportunity_list');
        await chooser
          .getByRole('button', { name: 'Add Board view' })
          .press('Enter');
        await page.getByLabel('View name').fill('Pipeline');
        await page.getByRole('button', { name: 'Draft Board' }).press('Enter');
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .press('Enter');
        await page.getByRole('button', { name: 'Activate now' }).press('Enter');
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(
          app.baseUrl +
            '/?surface=northstar.app%3Asurface.custom_opportunity_list',
        );
        await page
          .getByRole('link', { name: 'Pipeline', exact: true })
          .press('Enter');
        const grid = page.locator('.surface-grid[data-surface-archetype="board"]');
        for (const slot of ['surface-title-slot','saved-views-slot','board-selector-slot','board-columns-slot'])
          await expect(grid.locator('.'+slot)).toHaveCount(1);
        await expect(grid.locator('.board-column:visible')).toHaveCount(1);
        const boardUrl = page.url();
        const measure=async()=>{
          const response=await page.goto(boardUrl);
          expect(response?.status()).toBe(200);
          const work=parseServerTiming(await response!.headerValue('server-timing'));
          expect(work).not.toBeNull();
          expect(work!.transactions).toBeLessThanOrEqual(2);
          expect(work!.statements).toBeLessThanOrEqual(40);
          expect(work!.authorization).toBeLessThanOrEqual(3);
          expect(work!.repeats).toBe(0);
          return work!;
        };
        const sparse=await measure();
        const other = await context.newPage();
        await other.goto(boardUrl);
        for (const tab of [page, other]) {
          await tab
            .getByRole('button', { name: 'Move card: Westside renewal' })
            .press('Enter');
          await expect(
            tab.getByRole('heading', { name: 'Move card' }),
          ).toBeVisible();
          expect((await before()).revision).toBe(card.revision);
          expect(moves()).toHaveLength(0);
          await tab
            .getByLabel('Destination and action')
            .selectOption({ label: 'Won · Mark won' });
          await tab.getByRole('button', { name: 'Review move' }).press('Enter');
          await expect(
            tab.getByRole('button', { name: 'Confirm Mark won' }),
          ).toBeVisible();
          expect((await before()).revision).toBe(card.revision);
          expect(moves()).toHaveLength(0);
        }
        await page
          .getByRole('button', { name: 'Confirm Mark won' })
          .press('Enter');
        await expect(
          page.getByRole('status').filter({ hasText: 'Mark won completed' }),
        ).toBeVisible();
        expect(moves()).toHaveLength(1);
        const moved = await before();
        expect(moved.revision).toBe(card.revision + 1);
        await other
          .getByRole('button', { name: 'Confirm Mark won' })
          .press('Enter');
        await expect(other.getByRole('alert')).toContainText(
          'This card changed',
        );
        await expect(other.getByRole('alert')).toContainText('Won');
        expect((await before()).revision).toBe(moved.revision);
        await page
          .getByRole('navigation', { name: 'Select stage' })
          .getByRole('link', { name: 'Won', exact: true })
          .press('Enter');
        await expect(
          page.getByRole('link', { name: 'Westside renewal', exact: true }),
        ).toBeVisible();
        expect(
          await page
            .locator('html')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        for(let n=0;n<11;n++)await createCard('Prospect '+String(n+1),randomUUID());
        const full=await measure();
        expect(full.statements).toBe(sparse.statements);
        process.stdout.write('Board page work '+JSON.stringify({sparse,full})+'\n');
        const compactCards=page.locator('.board-column:visible li');
        await expect(compactCards).toHaveCount(10);
        await page.getByRole('link',{name:'More Open cards'}).press('Enter');
        await expect(compactCards).toHaveCount(1);
        await page.setViewportSize({width:1280,height:840});
        await page.goto(boardUrl);
        await expect(page.locator('.board-column:visible')).toHaveCount(2);
        await page.goto(app.baseUrl+'/?customize');
        await page.getByRole('button',{name:'Roll back the latest change'}).press('Enter');
        await expect(page.locator('[data-customize-result="rolledBack"]')).toBeVisible({timeout:180_000});
        await page.goto(boardUrl);
        await expect(page.getByRole('heading',{name:'View not available'})).toBeVisible();
        await page.getByRole('link',{name:'Open Opportunity'}).press('Enter');
        await expect(page.getByRole('link',{name:'Pipeline',exact:true})).toHaveCount(0);
        expect((await before()).revision).toBe(moved.revision);
      } finally {
        mock.restoreAll();
        await context.close();
        await opened.close();
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});
