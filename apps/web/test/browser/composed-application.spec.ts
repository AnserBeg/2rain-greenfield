import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import { trustedContextForRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../../api/src/composition-root.js';
import {
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
} from '../../../../packages/postgres-provider/src/inventory-posting-service.js';
import { TrustedActorEnvelopeIssuer } from '../../../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const applicationNamespace = 'northstar.app';

test('composed Party, Catalog, Location, and Inventory product reads a real posting and persists a record', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const externalBaseUrl = process.env.COMPOSED_APPLICATION_BASE_URL;
  if (externalBaseUrl) {
    await productJourney(page, externalBaseUrl);
    return;
  }

  await withEphemeralPostgres(
    'g2-p5da-browser',
    async ({ connection, pool }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      let application = await startComposedApplication({
        databaseUrl,
        port: 0,
        tenantSlug: 'composed-browser-tenant',
      });
      try {
        await assertSeedTrust(pool, application);
        await seedPostedInventory(pool, databaseUrl, application);
        await productJourney(page, application.baseUrl);
        await application.close();
        application = await startComposedApplication({
          databaseUrl,
          port: 0,
          tenantSlug: 'composed-browser-tenant',
        });
        await page.goto(surfaceUrl(application.baseUrl, 'party_list'));
        await expect(
          page.getByRole('cell', { name: 'Browser-persisted Party' }),
        ).toBeVisible();
      } finally {
        await application.close();
      }
    },
  );
});

async function productJourney(page: Page, baseUrl: string): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  const primaryEntries = navigation.locator('.navigation-tree > li');
  await expect(primaryEntries).toHaveCount(4);
  await expect(
    primaryEntries.locator(
      ':scope > a > span:nth-child(2), :scope > details > summary > span:nth-child(2)',
    ),
  ).toHaveText(['Party', 'Catalog', 'Location', 'Inventory']);
  await expect(navigation.locator('a > span:nth-child(2)')).toHaveText([
    'Party',
    'Party role',
    'Catalog',
    'Location',
    'Inventory movement',
    'Inventory period lock',
    'Inventory transaction line',
    'Inventory transaction',
    'Legal entity',
  ]);
  await expect(
    navigation.getByRole('link', { name: /detail|form/i }),
  ).toHaveCount(0);
  await expect(
    primaryEntries.getByRole('group').filter({ hasText: 'Party' }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Location', exact: true }),
  ).toBeVisible();
  const inventoryNavigation = primaryEntries
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  await expect(inventoryNavigation).toBeVisible();
  await inventoryNavigation.getByText('Inventory', { exact: true }).click();
  await expect(inventoryNavigation.locator('a > span:nth-child(2)')).toHaveText(
    [
      'Inventory movement',
      'Inventory period lock',
      'Inventory transaction line',
      'Inventory transaction',
      'Legal entity',
    ],
  );
  await inventoryNavigation.getByText('Inventory', { exact: true }).click();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-platform-slot="list:title"]')).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="list:dataGrid"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Alpine Office Supply' }),
  ).toBeVisible();
  const responsiveList = page.locator(
    '[data-list-rendering="responsive-single"]',
  );
  const firstResponsiveRow = responsiveList
    .locator('tr[data-compact-card="true"]')
    .first();
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'table-row');
  const priorities = await firstResponsiveRow
    .locator('[data-column-priority]')
    .evaluateAll((cells) =>
      cells.map((cell) => Number(cell.getAttribute('data-column-priority'))),
    );
  expect(priorities).toEqual(
    [...priorities].sort((left, right) => left - right),
  );

  const bulkBar = page.locator(
    '[data-platform-slot="list:bulkActions"] [data-bulk-selection-form]',
  );
  const firstSelector = firstResponsiveRow.getByRole('checkbox');
  await expect(bulkBar.getByText('Select records to begin')).toBeVisible();
  await expect(bulkBar.getByText('Selection ready')).toBeHidden();
  await firstSelector.check();
  await expect(bulkBar.getByText('Selection ready')).toBeVisible();
  await bulkBar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(firstSelector).not.toBeChecked();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'grid');
  await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.sidebar')).toHaveCSS('bottom', '0px');
  expect(
    await navigation.getByRole('link').evaluateAll(
      (links) =>
        links.filter((link) => {
          const item = link.closest('li');
          return (
            item !== null &&
            getComputedStyle(item).display !== 'none' &&
            getComputedStyle(link).display !== 'none'
          );
        }).length,
    ),
  ).toBeLessThanOrEqual(5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 720, width: 1280 });

  await navigation.getByRole('link', { name: 'Catalog', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Item list' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Field notebook' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Location', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Location list' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Calgary warehouse' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'inventory_movement_list'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inventory movement list' }),
  ).toBeVisible();
  const movementRow = page.locator('tr', {
    hasText: 'browser-posted-adjustment',
  });
  await expect(movementRow).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'New', exact: true }),
  ).toHaveCount(0);
  await movementRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'browser-posted-adjustment' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="record:commandBar"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'inventory_transaction_list'));
  const transactionRow = page.locator('tr', { hasText: 'ADJ-BROWSER-001' });
  await expect(transactionRow).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'New', exact: true }),
  ).toHaveCount(0);
  await transactionRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'ADJ-BROWSER-001' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="record:commandBar"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Archive|Restore/ }),
  ).toHaveCount(0);
  const inventoryTransactionDetailUrl = `${surfaceUrl(baseUrl, 'inventory_transaction_detail')}&record=${encodeURIComponent(browserTransactionId)}`;
  for (const [intent, idempotencyKey] of [
    ['archive', '74000000-0000-4000-8000-000000000007'],
    ['restore', '74000000-0000-4000-8000-000000000008'],
  ] as const) {
    const refusedLifecycleWrite = await page.request.post(
      inventoryTransactionDetailUrl,
      {
        form: {
          expectedRevision: '2',
          idempotencyKey,
          intent,
          recordId: browserTransactionId,
        },
      },
    );
    expect(refusedLifecycleWrite.status()).toBe(422);
    expect(await refusedLifecycleWrite.text()).toContain(
      'OPERATION_UNSUPPORTED',
    );
  }
  await page.goto(inventoryTransactionDetailUrl);
  await expect(
    page.getByRole('heading', { level: 1, name: 'ADJ-BROWSER-001' }),
  ).toBeVisible();
  await page.goto(surfaceUrl(baseUrl, 'inventory_transaction_form'));
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  const refusedWrite = await page.request.post(
    surfaceUrl(baseUrl, 'inventory_transaction_form'),
    {
      form: {
        idempotencyKey: '74000000-0000-4000-8000-000000000005',
        intent: 'create',
        recordId: '74000000-0000-4000-8000-000000000006',
      },
    },
  );
  expect(refusedWrite.status()).toBe(422);
  expect(await refusedWrite.text()).toContain('OPERATION_UNSUPPORTED');

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Party' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="record:keyFacts"]'),
  ).toContainText('New record');
  await expect(
    page.locator('[data-platform-slot="record:sections"]'),
  ).toBeVisible();
  await page.getByLabel('Party Number').fill('P-BROWSER-REAL-001');
  await page.getByLabel('Party Name').fill('Browser-persisted Party');
  await page
    .getByLabel('Party Contact Summary')
    .fill('browser-persisted@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.reload();
  await expect(
    page.getByRole('cell', { name: 'Browser-persisted Party' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'P-BROWSER-REAL-001' }),
  ).toBeVisible();
  const createdRow = page.locator('tr', { hasText: 'Browser-persisted Party' });
  const createdRecordId = await createdRow.getAttribute('data-record-id');
  expect(createdRecordId).not.toBeNull();
  await createdRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Browser-persisted Party',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }),
  ).toContainText('Party list');
  const keyFactsSlot = page.locator('[data-platform-slot="record:keyFacts"]');
  const sectionsSlot = page.locator('[data-platform-slot="record:sections"]');
  await expect(
    sectionsSlot.getByText('P-BROWSER-REAL-001', { exact: true }),
  ).toBeVisible();
  await expect(keyFactsSlot).toContainText('Revision');
  await expect(keyFactsSlot.locator('[data-field-id]')).toHaveCount(0);
  await expect(keyFactsSlot).not.toContainText(
    'browser-persisted@example.test',
  );
  await expect(sectionsSlot.locator('[data-field-id]')).toHaveCount(3);
  await expect(sectionsSlot).toContainText('browser-persisted@example.test');
  await page.setViewportSize({ height: 844, width: 390 });
  const compactSections = page.locator(
    '[data-platform-slot="record:sections"] details.record-section-group',
  );
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    page.locator('[data-platform-slot="record:commandBar"] .command-bar'),
  ).toHaveCSS('position', 'sticky');
  const compactSectionSummary = compactSections.locator('summary');
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).not.toHaveAttribute('open', '');
  await page.setViewportSize({ height: 720, width: 1280 });
  await expect(compactSectionSummary).toBeVisible();
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    compactSections.getByText('browser-persisted@example.test'),
  ).toBeVisible();
  const overflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  const archive = page.getByRole('button', { name: 'Archive' });
  await expect(overflow).toBeVisible();
  await expect(archive).toBeHidden();
  await overflow.locator('summary').click();
  await expect(archive).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Edit Party' }),
  ).toBeVisible();
  await page
    .getByLabel('Party Contact Summary')
    .fill('updated-after-navigation@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');

  const detailUrl = `${surfaceUrl(baseUrl, 'party_detail')}&record=${encodeURIComponent(createdRecordId ?? '')}`;
  await page.goto(detailUrl);
  const archiveOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await archiveOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm Archive' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive' }).click();
  await expect(page.getByRole('status')).toContainText('Archive complete');
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();

  await page.goto(detailUrl);
  await expect(
    page.locator('[data-diagnostic-code="QUERY_NOT_FOUND"]'),
  ).toHaveCount(1);
  await expect(page.locator('[data-platform-slot^="record:"]')).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  const showArchived = page.getByRole('link', { name: 'Show archived' });
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  const archivedRow = page.locator('tr', {
    hasText: 'Browser-persisted Party',
  });
  await expect(
    archivedRow.getByText('Archived', { exact: true }),
  ).toBeVisible();
  const hideArchived = page.getByRole('link', { name: 'Hide archived' });
  await expect(hideArchived).toBeVisible();
  await hideArchived.click();
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  await expect(archivedRow).toBeVisible();
  await archivedRow.getByRole('link').click();
  await expect(page).toHaveURL(/(?:\?|&)archived=yes(?:&|$)/);
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();
  const restoreOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await restoreOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status')).toContainText('Restore complete');

  await page.goto(detailUrl);
  await expect(page.getByText(/Active · revision 4/)).toBeVisible();
  await expect(
    page.getByText('updated-after-navigation@example.test', { exact: true }),
  ).toBeVisible();
}

const browserLegalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const browserTransactionId = '74000000-0000-4000-8000-000000000002';
const browserTransactionLineId = '74000000-0000-4000-8000-000000000003';
const browserPostingIdempotencyKey = '74000000-0000-4000-8000-000000000004';
const demoItemId = '71000000-0000-4000-8000-000000000011';
const demoLocationId = '71000000-0000-4000-8000-000000000021';
const browserPostingInstant = '2026-07-30T12:00:00.000Z';
type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

async function seedPostedInventory(
  adminPool: pg.Pool,
  databaseUrl: string,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  const projection = await loadPostingProjection(
    application.runtime.releaseRoot,
  );
  const identity = application.runtime.identity;
  const provisioned = await adminPool.query<{ contract_release_root: string }>(
    `SELECT contract_release_root
       FROM platform.inventory_posting_configurations
      WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
    [identity.tenantId, identity.environmentId, browserLegalEntityId],
  );
  expect(provisioned.rows).toEqual([
    { contract_release_root: application.runtime.releaseRoot },
  ]);

  await application.runtime.entry.run(
    { headers: { authorization: 'browser-inventory-posting' } },
    async (view) => {
      const context = trustedContextForRequestRuntimeView(view);
      await seedInventoryDraft(adminPool, context, projection.storageTarget);
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: {
            kind: 'HUMAN',
            principalId: context.principalId,
          },
          initiatingHumanId: context.principalId,
          subject: null,
        }),
      }).issue(context);
      const runtimePool = new pg.Pool({
        connectionString: databaseUrl,
        max: 2,
        user: 'north_star_runtime',
      });
      try {
        const service = new PostgresInventoryPostingService(
          runtimePool,
          {
            capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
            capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
            dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
            releaseContentHash: application.runtime.releaseRoot,
            releaseId: application.runtime.activeReleaseId,
            storageTarget: projection.storageTarget,
            storageTargetContentHash: projection.contentHash,
          },
          { currentInstant: () => browserPostingInstant },
        );
        await service.postAdjustment(context, actor, {
          authorization: {
            decision: 'ALLOW',
            evaluatorVersion: 'browser-inventory-fixture/v1',
            policyVersion: 'browser-inventory-fixture/v1',
          },
          channel: 'SYSTEM',
          effectiveAt: browserPostingInstant,
          idempotencyKey: browserPostingIdempotencyKey,
          legalEntityId: browserLegalEntityId,
          lines: [
            {
              itemId: demoItemId,
              locationId: demoLocationId,
              quantityDelta: '5',
              sourceLine: '1',
              transactionLineId: browserTransactionLineId,
              unitId: 'EA',
            },
          ],
          reason: {
            code: 'browser-seed',
            narrative: 'Posted through the admitted Inventory capability',
          },
          sourceId: 'browser-posted-adjustment',
          sourceRevision: 1,
          sourceType: 'browser-checkpoint',
          stockDimensionSetVersion: 'v1',
          transactionId: browserTransactionId,
        });
      } finally {
        await runtimePool.end();
      }
    },
  );
}

async function seedInventoryDraft(
  pool: pg.Pool,
  context: ReturnType<typeof trustedContextForRequestRuntimeView>,
  target: StorageTargetPayloadV1,
): Promise<void> {
  const transaction = storageEntity(target, 'inventory_transaction');
  const transactionLine = storageEntity(target, 'inventory_transaction_line');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        context.tenantId,
        context.environmentId,
        context.principalId,
        context.requestId,
      ],
    );
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    await insertStorageEntity(client, target, transaction, {
      legalEntityId: browserLegalEntityId,
      recordId: browserTransactionId,
      relations: {},
      values: {
        inventory_transaction_actor_id: context.principalId,
        inventory_transaction_effective_at: browserPostingInstant,
        inventory_transaction_number: 'ADJ-BROWSER-001',
        inventory_transaction_reason_code: 'browser-seed',
        inventory_transaction_reason_narrative:
          'Posted through the admitted Inventory capability',
        inventory_transaction_recorded_at: browserPostingInstant,
        inventory_transaction_source_id: 'browser-posted-adjustment',
        inventory_transaction_source_type: 'browser-checkpoint',
        inventory_transaction_state: enumOption(
          transaction,
          'inventory_transaction_state',
          'draft',
        ),
        inventory_transaction_type: enumOption(
          transaction,
          'inventory_transaction_type',
          'adjustment',
        ),
      },
      context,
    });
    await insertStorageEntity(client, target, transactionLine, {
      legalEntityId: browserLegalEntityId,
      recordId: browserTransactionLineId,
      relations: {
        'northstar.app:entity.inventory_transaction': browserTransactionId,
      },
      values: {
        inventory_transaction_line_from_location_id: null,
        inventory_transaction_line_item_id: demoItemId,
        inventory_transaction_line_line_number: 1,
        inventory_transaction_line_quantity: '5',
        inventory_transaction_line_to_location_id: demoLocationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      context,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertStorageEntity(
  client: pg.PoolClient,
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
  input: {
    readonly context: ReturnType<typeof trustedContextForRequestRuntimeView>;
    readonly legalEntityId: string | null;
    readonly recordId: string;
    readonly relations: Readonly<Record<string, string>>;
    readonly values: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const relations = target.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntity ? [entity.legalEntity.column] : []),
    entity.recordIdentity.column,
    ...entity.columns.map((column) => column.physicalName),
    ...relations.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    input.context.tenantId,
    input.context.environmentId,
    ...(entity.legalEntity ? [input.legalEntityId] : []),
    input.recordId,
    ...entity.columns.map((column) => {
      const local = localField(column);
      if (!Object.hasOwn(input.values, local)) {
        throw new TypeError(`missing browser fixture field ${local}`);
      }
      return input.values[local];
    }),
    ...relations.map((relation) => {
      const value = input.relations[relation.targetEntityId];
      if (!value) {
        throw new TypeError(
          `missing browser fixture relation ${relation.relationId}`,
        );
      }
      return value;
    }),
  ];
  await client.query(
    `INSERT INTO ${quoted(target.providerAbi.managedSchema)}.${quoted(entity.physicalTableName)}
       (${columns.map(quoted).join(',')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    values,
  );
}

function storageEntity(
  target: StorageTargetPayloadV1,
  localId: string,
): StorageEntityTarget {
  const entity = target.entities.find((candidate) =>
    candidate.entityId.endsWith(`:entity.${localId}`),
  );
  if (!entity) throw new TypeError(`missing storage entity ${localId}`);
  return entity;
}

function enumOption(
  entity: StorageEntityTarget,
  localId: string,
  suffix: string,
): string {
  const column = entity.columns.find(
    (candidate) => localField(candidate) === localId,
  );
  const options = column?.fieldContract.enumOptionIds.filter((option) =>
    option.endsWith(`_${suffix}`),
  );
  if (options?.length !== 1) {
    throw new TypeError(`missing enum option ${localId}.${suffix}`);
  }
  return options[0]!;
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function quoted(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new TypeError(`invalid generated identifier ${identifier}`);
  }
  return `"${identifier}"`;
}

async function loadPostingProjection(releaseRoot: string): Promise<{
  readonly contentHash: string;
  readonly storageTarget: StorageTargetPayloadV1;
}> {
  const compiled = JSON.parse(
    await readFile(
      new URL('../../release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as {
    readonly applications: readonly CompiledApplicationRelease[];
  };
  const application = compiled.applications.find(
    (candidate) => candidate.releaseRoot === releaseRoot,
  );
  if (!application)
    throw new TypeError('active application release is not checked in');
  const projection = application.releaseManifest.projections.find(
    (candidate) => candidate.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!projection)
    throw new TypeError('application storage projection is missing');
  const manifestArtifact = application.artifacts.find(
    (candidate) => candidate.contentHash === projection.artifactRoot,
  );
  if (!manifestArtifact)
    throw new TypeError('storage manifest artifact is missing');
  const manifest = JSON.parse(
    Buffer.from(manifestArtifact.canonicalBytesBase64, 'base64').toString(
      'utf8',
    ),
  ) as { readonly chunks: readonly { readonly contentHash: string }[] };
  const contentHash = manifest.chunks[0]?.contentHash;
  const chunk = application.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  if (!chunk || !contentHash)
    throw new TypeError('storage chunk artifact is missing');
  return {
    contentHash,
    storageTarget: JSON.parse(
      Buffer.from(chunk.canonicalBytesBase64, 'base64').toString('utf8'),
    ) as StorageTargetPayloadV1,
  };
}

interface CompiledApplicationRelease {
  readonly artifacts: readonly {
    readonly canonicalBytesBase64: string;
    readonly contentHash: string;
  }[];
  readonly releaseManifest: {
    readonly projections: readonly {
      readonly artifactRoot: string;
      readonly familyId: string;
    }[];
  };
  readonly releaseRoot: string;
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${applicationNamespace}:surface.${localSurface}`)}`;
}

async function assertSeedTrust(
  pool: pg.Pool,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  expect(application.seededRecords).toHaveLength(12);
  for (const seed of application.seededRecords) {
    const linked = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM platform.trust_action_invocations AS invocation
         JOIN platform.trust_business_change_documents AS change
           ON change.tenant_id = invocation.tenant_id
          AND change.environment_id = invocation.environment_id
          AND change.invocation_id = invocation.invocation_id
         JOIN platform.trust_domain_events AS event
           ON event.tenant_id = invocation.tenant_id
          AND event.environment_id = invocation.environment_id
          AND event.invocation_id = invocation.invocation_id
         JOIN platform.trust_outbox AS outbox
           ON outbox.tenant_id = invocation.tenant_id
          AND outbox.environment_id = invocation.environment_id
          AND outbox.invocation_id = invocation.invocation_id
        WHERE invocation.tenant_id = $1
          AND invocation.environment_id = $2
          AND invocation.invocation_id = $3
          AND invocation.change_document_id = $4
          AND invocation.domain_event_id = $5
          AND invocation.outbox_id = $6`,
      [
        application.runtime.identity.tenantId,
        application.runtime.identity.environmentId,
        seed.trust.invocationId,
        seed.trust.changeDocumentId,
        seed.trust.domainEventId,
        seed.trust.outboxId,
      ],
    );
    expect(linked.rows[0]?.count).toBe('1');
  }
}
