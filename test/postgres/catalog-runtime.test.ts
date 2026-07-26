import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { CATALOG_IDS } from '../../packages/domain/src/catalog/index.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { resolveByName } from '../../packages/runtime/src/resolve-by-name.js';
import type { SemanticQueryResultEnvelope } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import {
  CATALOG_TEST_SCOPE,
  invokeCatalogOperation,
  invokeCatalogQuery,
  type RealCatalogRuntime,
  withRealCatalogRuntime,
} from '../fixtures/g2/catalog/runtime-harness.js';

test('Catalog executes tenant SKU, resolver, lifecycle, and DTO contracts on real PostgreSQL', async () => {
  await withRealCatalogRuntime('catalog-walking-slice', async (runtime) => {
    assert.equal(
      await persistedItemCount(runtime.adminPool, runtime, 'a'),
      0,
      'negative control requires a genuinely empty Catalog table',
    );
    const initialList = await invokeCatalogQuery(
      runtime,
      runtime.views.a,
      'item_list',
      { limit: 100 },
    );
    assert.deepEqual(initialList.records, []);

    const itemId = randomUUID();
    const created = await invokeCatalogOperation(
      runtime,
      runtime.views.a,
      'item_create',
      {
        recordId: itemId,
        values: itemValues(
          'SKU-001',
          'Galvanized bolt',
          'M8 hex-head fastener',
        ),
      },
    );
    assert.equal(created.outcome, 'succeeded');
    assert.ok(created.trust);
    assert.deepEqual(
      created.readBack?.values,
      itemValues('SKU-001', 'Galvanized bolt', 'M8 hex-head fastener'),
    );
    assert.equal(await persistedItemCount(runtime.adminPool, runtime, 'a'), 1);
    await assertPersistedItem(runtime.adminPool, runtime, itemId, {
      archived: false,
      description: 'M8 hex-head fastener',
      name: 'Galvanized bolt',
      revision: 1,
      sku: 'SKU-001',
    });
    await assertLinkedTrust(runtime.adminPool, created.trust.invocationId);

    const tenantBItemId = randomUUID();
    await invokeCatalogOperation(runtime, runtime.views.b, 'item_create', {
      recordId: tenantBItemId,
      values: itemValues('SKU-001', 'Tenant B item', 'isolated'),
    });
    assert.equal(await persistedItemCount(runtime.adminPool, runtime, 'b'), 1);
    assert.equal(
      (
        await invokeCatalogQuery(runtime, runtime.views.a, 'item_get', {
          recordId: tenantBItemId,
        })
      ).outcome,
      'not-found',
    );

    await assert.rejects(
      invokeCatalogOperation(runtime, runtime.views.a, 'item_create', {
        recordId: randomUUID(),
        values: itemValues('sku-001', 'Duplicate SKU', 'must not persist'),
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_UNIQUE_VIOLATION',
          CATALOG_IDS.fieldIds.sku,
        ),
    );
    assert.equal(await persistedItemCount(runtime.adminPool, runtime, 'a'), 1);

    await assert.rejects(
      invokeCatalogOperation(runtime, runtime.views.a, 'item_create', {
        recordId: randomUUID(),
        values: {
          [CATALOG_IDS.fieldIds.description]: 'missing required name',
          [CATALOG_IDS.fieldIds.sku]: 'SKU-BAD',
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_REQUIRED_FIELD_MISSING',
          CATALOG_IDS.fieldIds.name,
        ),
    );
    assert.equal(await persistedItemCount(runtime.adminPool, runtime, 'a'), 1);

    for (const sku of ['SKU-002', 'SKU-003']) {
      await invokeCatalogOperation(runtime, runtime.views.a, 'item_create', {
        recordId: randomUUID(),
        values: itemValues(sku, 'Workshop gloves', 'advisory duplicate'),
      });
    }
    await invokeCatalogOperation(runtime, runtime.views.a, 'item_create', {
      recordId: randomUUID(),
      values: itemValues('SKU-004', 'Safety glasses', 'eye protection'),
    });
    await invokeCatalogOperation(runtime, runtime.views.a, 'item_create', {
      recordId: randomUUID(),
      values: itemValues('SKU-005', 'SKU-004', 'authority collision'),
    });
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'SKU-001')).outcome,
      'exact',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'Workshop gloves')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'Safety glasses')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'SKU-004')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'Saftey glases')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'Missing item')).outcome,
      'not-found',
    );
    assert.equal(
      (await resolveItem(runtime, runtime.views.a, 'Tenant B item')).outcome,
      'not-found',
    );

    const updated = await invokeCatalogOperation(
      runtime,
      runtime.views.a,
      'item_update',
      {
        expectedRevision: 1,
        patch: {
          [CATALOG_IDS.fieldIds.description]: 'M8 galvanized hex-head bolt',
        },
        recordId: itemId,
      },
    );
    assert.equal(updated.readBack?.revision, 2);
    const archived = await invokeCatalogOperation(
      runtime,
      runtime.views.a,
      'item_archive',
      { expectedRevision: 2, recordId: itemId },
    );
    assert.equal(archived.readBack?.archived, true);
    assert.equal(archived.readBack?.revision, 3);
    assert.equal(
      (
        await invokeCatalogQuery(runtime, runtime.views.a, 'item_get', {
          recordId: itemId,
        })
      ).outcome,
      'not-found',
    );
    assert.equal(
      (
        await invokeCatalogQuery(runtime, runtime.views.a, 'item_get', {
          includeArchived: true,
          recordId: itemId,
        })
      ).records[0]?.archived,
      true,
    );
    await assertPersistedItem(runtime.adminPool, runtime, itemId, {
      archived: true,
      description: 'M8 galvanized hex-head bolt',
      name: 'Galvanized bolt',
      revision: 3,
      sku: 'SKU-001',
    });

    const restored = await invokeCatalogOperation(
      runtime,
      runtime.views.a,
      'item_restore',
      { expectedRevision: 3, recordId: itemId },
    );
    assert.equal(restored.readBack?.archived, false);
    assert.equal(restored.readBack?.revision, 4);
    const queryDto = (
      await invokeCatalogQuery(runtime, runtime.views.a, 'item_get', {
        recordId: itemId,
      })
    ).records[0];
    assert.deepEqual(queryDto, restored.readBack);
    const agentQueryId = (
      runtime.views.a.projections.agent.payload as {
        queries: Array<{ queryId: string }>;
      }
    ).queries.find(
      (query) => query.queryId === `${CATALOG_IDS.namespace}:query.item_get`,
    )?.queryId;
    assert.ok(agentQueryId);
    const agentDto = (
      await runtime.queryGateway.invoke(runtime.views.a, {
        arguments: { recordId: itemId },
        queryId: agentQueryId,
        schemaVersion: 'northstar.semantic-query-request/v1',
      })
    ).records[0];
    assert.deepEqual(agentDto, queryDto);
    await assertPersistedItem(runtime.adminPool, runtime, itemId, {
      archived: false,
      description: 'M8 galvanized hex-head bolt',
      name: 'Galvanized bolt',
      revision: 4,
      sku: 'SKU-001',
    });
  });
});

function resolveItem(
  runtime: RealCatalogRuntime,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return resolveByName(
    runtime.queryGateway,
    view,
    {
      exactIdentifierFieldIds: [CATALOG_IDS.fieldIds.sku],
      listQueryId: `${CATALOG_IDS.namespace}:query.item_list`,
      nameFieldIds: [CATALOG_IDS.fieldIds.name],
      resolveQueryId: `${CATALOG_IDS.namespace}:query.item_resolve`,
    },
    text,
  );
}

function itemValues(
  sku: string,
  name: string,
  description: string,
): Record<string, string> {
  return {
    [CATALOG_IDS.fieldIds.description]: description,
    [CATALOG_IDS.fieldIds.name]: name,
    [CATALOG_IDS.fieldIds.sku]: sku,
  };
}

async function persistedItemCount(
  pool: Pool,
  runtime: RealCatalogRuntime,
  scope: 'a' | 'b',
): Promise<number> {
  const entity = itemStorage(runtime);
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM north_star_module.${quoted(entity.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2`,
    [
      CATALOG_TEST_SCOPE[scope].tenantId,
      CATALOG_TEST_SCOPE[scope].environmentId,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertPersistedItem(
  pool: Pool,
  runtime: RealCatalogRuntime,
  recordId: string,
  expected: {
    archived: boolean;
    description: string;
    name: string;
    revision: number;
    sku: string;
  },
): Promise<void> {
  const entity = itemStorage(runtime);
  const fieldColumn = (fieldId: string): string => {
    const column = entity.columns.find(
      (candidate) => candidate.canonicalFieldId === fieldId,
    );
    assert.ok(column, `missing storage column for ${fieldId}`);
    return column.physicalName;
  };
  const result = await pool.query<{
    archived: boolean;
    description: string;
    name: string;
    revision: number;
    sku: string;
  }>(
    `SELECT ${quoted(entity.archive.archivedAtColumn)} IS NOT NULL AS archived,
            ${quoted(fieldColumn(CATALOG_IDS.fieldIds.description))} AS description,
            ${quoted(fieldColumn(CATALOG_IDS.fieldIds.name))} AS name,
            ${quoted(entity.optimisticRevision.column)} AS revision,
            ${quoted(fieldColumn(CATALOG_IDS.fieldIds.sku))} AS sku
       FROM north_star_module.${quoted(entity.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(entity.recordIdentity.column)} = $3`,
    [
      CATALOG_TEST_SCOPE.a.tenantId,
      CATALOG_TEST_SCOPE.a.environmentId,
      recordId,
    ],
  );
  assert.equal(result.rowCount, 1, 'persisted item subject is absent');
  assert.deepEqual(
    { ...result.rows[0], revision: Number(result.rows[0]?.revision) },
    expected,
  );
}

function itemStorage(runtime: RealCatalogRuntime) {
  const entity = runtime.storage.entities.find(
    (candidate) => candidate.entityId === CATALOG_IDS.entityIds.item,
  );
  assert.ok(entity, 'compiled Catalog item storage is absent');
  return entity;
}

async function assertLinkedTrust(
  pool: Pool,
  invocationId: string,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
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
      WHERE invocation.invocation_id = $1`,
    [invocationId],
  );
  assert.equal(result.rows[0]?.count, '1');
}

function assertTypedError(
  error: unknown,
  code: string,
  subjectId: string | null,
): true {
  assert.ok(error instanceof ModuleRuntimeInterpreterError);
  assert.equal(error.code, code);
  assert.equal(error.subjectId, subjectId);
  assert.doesNotMatch(
    JSON.stringify({ code: error.code, message: error.message, subjectId }),
    /north_star_module|nsm_[ctik]_|storageClass/,
  );
  return true;
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
