import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { LOCATION_IDS } from '../../packages/domain/src/location/index.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { resolveByName } from '../../packages/runtime/src/resolve-by-name.js';
import type { SemanticQueryResultEnvelope } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import {
  LOCATION_TEST_SCOPE,
  invokeLocationOperation,
  invokeLocationQuery,
  type RealLocationRuntime,
  withRealLocationRuntime,
} from '../fixtures/g2/location/runtime-harness.js';

const warehouseType = `${LOCATION_IDS.namespace}:option.warehouse`;
const storeType = `${LOCATION_IDS.namespace}:option.store`;

test('Location executes tenant code, resolver, lifecycle, and DTO contracts on real PostgreSQL', async () => {
  await withRealLocationRuntime('location-walking-slice', async (runtime) => {
    assert.equal(
      await persistedLocationCount(runtime.adminPool, runtime, 'a'),
      0,
      'negative control requires a genuinely empty Location table',
    );
    const initialList = await invokeLocationQuery(
      runtime,
      runtime.views.a,
      'location_list',
      { limit: 100 },
    );
    assert.deepEqual(initialList.records, []);

    const locationId = randomUUID();
    const created = await invokeLocationOperation(
      runtime,
      runtime.views.a,
      'location_create',
      {
        recordId: locationId,
        values: locationValues('LOC-001', 'North Warehouse', warehouseType),
      },
    );
    assert.equal(created.outcome, 'succeeded');
    assert.ok(created.trust);
    assert.deepEqual(
      created.readBack?.values,
      locationValues('LOC-001', 'North Warehouse', warehouseType),
    );
    assert.equal(
      await persistedLocationCount(runtime.adminPool, runtime, 'a'),
      1,
    );
    await assertPersistedLocation(runtime.adminPool, runtime, locationId, {
      archived: false,
      locationType: warehouseType,
      name: 'North Warehouse',
      revision: 1,
      code: 'LOC-001',
    });
    await assertLinkedTrust(runtime.adminPool, created.trust.invocationId);

    const tenantBLocationId = randomUUID();
    await invokeLocationOperation(runtime, runtime.views.b, 'location_create', {
      recordId: tenantBLocationId,
      values: locationValues('LOC-001', 'Tenant B location', storeType),
    });
    assert.equal(
      await persistedLocationCount(runtime.adminPool, runtime, 'b'),
      1,
    );
    assert.equal(
      (
        await invokeLocationQuery(runtime, runtime.views.a, 'location_get', {
          recordId: tenantBLocationId,
        })
      ).outcome,
      'not-found',
    );

    await assert.rejects(
      invokeLocationOperation(runtime, runtime.views.a, 'location_create', {
        recordId: randomUUID(),
        values: locationValues('loc-001', 'Duplicate code', warehouseType),
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_UNIQUE_VIOLATION',
          LOCATION_IDS.fieldIds.code,
        ),
    );
    assert.equal(
      await persistedLocationCount(runtime.adminPool, runtime, 'a'),
      1,
    );

    await assert.rejects(
      invokeLocationOperation(runtime, runtime.views.a, 'location_create', {
        recordId: randomUUID(),
        values: {
          [LOCATION_IDS.fieldIds.locationType]: warehouseType,
          [LOCATION_IDS.fieldIds.code]: 'LOC-BAD',
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_REQUIRED_FIELD_MISSING',
          LOCATION_IDS.fieldIds.name,
        ),
    );
    assert.equal(
      await persistedLocationCount(runtime.adminPool, runtime, 'a'),
      1,
    );

    for (const code of ['LOC-002', 'LOC-003']) {
      await invokeLocationOperation(
        runtime,
        runtime.views.a,
        'location_create',
        {
          recordId: randomUUID(),
          values: locationValues(code, 'North Annex', warehouseType),
        },
      );
    }
    await invokeLocationOperation(runtime, runtime.views.a, 'location_create', {
      recordId: randomUUID(),
      values: locationValues('LOC-004', 'South Store', storeType),
    });
    await invokeLocationOperation(runtime, runtime.views.a, 'location_create', {
      recordId: randomUUID(),
      values: locationValues('LOC-005', 'LOC-004', warehouseType),
    });
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'LOC-001')).outcome,
      'exact',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'North Annex')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'South Store')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'LOC-004')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'Noth Anex')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'Missing location'))
        .outcome,
      'not-found',
    );
    assert.equal(
      (await resolveLocation(runtime, runtime.views.a, 'Tenant B location'))
        .outcome,
      'not-found',
    );

    const updated = await invokeLocationOperation(
      runtime,
      runtime.views.a,
      'location_update',
      {
        expectedRevision: 1,
        patch: {
          [LOCATION_IDS.fieldIds.locationType]: storeType,
        },
        recordId: locationId,
      },
    );
    assert.equal(updated.readBack?.revision, 2);
    const archived = await invokeLocationOperation(
      runtime,
      runtime.views.a,
      'location_archive',
      { expectedRevision: 2, recordId: locationId },
    );
    assert.equal(archived.readBack?.archived, true);
    assert.equal(archived.readBack?.revision, 3);
    assert.equal(
      (
        await invokeLocationQuery(runtime, runtime.views.a, 'location_get', {
          recordId: locationId,
        })
      ).outcome,
      'not-found',
    );
    assert.equal(
      (
        await invokeLocationQuery(runtime, runtime.views.a, 'location_get', {
          includeArchived: true,
          recordId: locationId,
        })
      ).records[0]?.archived,
      true,
    );
    await assertPersistedLocation(runtime.adminPool, runtime, locationId, {
      archived: true,
      locationType: storeType,
      name: 'North Warehouse',
      revision: 3,
      code: 'LOC-001',
    });

    const restored = await invokeLocationOperation(
      runtime,
      runtime.views.a,
      'location_restore',
      { expectedRevision: 3, recordId: locationId },
    );
    assert.equal(restored.readBack?.archived, false);
    assert.equal(restored.readBack?.revision, 4);
    const queryDto = (
      await invokeLocationQuery(runtime, runtime.views.a, 'location_get', {
        recordId: locationId,
      })
    ).records[0];
    assert.deepEqual(queryDto, restored.readBack);
    const agentQueryId = (
      runtime.views.a.projections.agent.payload as {
        queries: Array<{ queryId: string }>;
      }
    ).queries.find(
      (query) =>
        query.queryId === `${LOCATION_IDS.namespace}:query.location_get`,
    )?.queryId;
    assert.ok(agentQueryId);
    const agentDto = (
      await runtime.queryGateway.invoke(runtime.views.a, {
        arguments: { recordId: locationId },
        queryId: agentQueryId,
        schemaVersion: 'northstar.semantic-query-request/v1',
      })
    ).records[0];
    assert.deepEqual(agentDto, queryDto);
    await assertPersistedLocation(runtime.adminPool, runtime, locationId, {
      archived: false,
      locationType: storeType,
      name: 'North Warehouse',
      revision: 4,
      code: 'LOC-001',
    });
  });
});

test('Location reuses an archived code while active uniqueness and restore conflicts stay closed', async () => {
  await withRealLocationRuntime(
    'location-archive-key-reuse',
    async (runtime) => {
      const archivedLocationId = randomUUID();
      await invokeLocationOperation(
        runtime,
        runtime.views.a,
        'location_create',
        {
          recordId: archivedLocationId,
          values: locationValues('WH-A', 'Original warehouse', warehouseType),
        },
      );

      await assert.rejects(
        invokeLocationOperation(runtime, runtime.views.a, 'location_create', {
          recordId: randomUUID(),
          values: locationValues('wh-a', 'Active duplicate', warehouseType),
        }),
        (error: unknown) =>
          assertTypedError(
            error,
            'MODULE_UNIQUE_VIOLATION',
            LOCATION_IDS.fieldIds.code,
          ),
      );

      await invokeLocationOperation(
        runtime,
        runtime.views.a,
        'location_archive',
        {
          expectedRevision: 1,
          recordId: archivedLocationId,
        },
      );
      const replacementLocationId = randomUUID();
      const replacement = await invokeLocationOperation(
        runtime,
        runtime.views.a,
        'location_create',
        {
          recordId: replacementLocationId,
          values: locationValues(
            'wh-a',
            'Replacement warehouse',
            warehouseType,
          ),
        },
      );
      assert.equal(replacement.outcome, 'succeeded');
      assert.equal(
        await persistedLocationCount(runtime.adminPool, runtime, 'a'),
        2,
      );

      await assert.rejects(
        invokeLocationOperation(runtime, runtime.views.a, 'location_restore', {
          expectedRevision: 2,
          recordId: archivedLocationId,
        }),
        (error: unknown) =>
          assertTypedError(
            error,
            'MODULE_UNIQUE_VIOLATION',
            LOCATION_IDS.fieldIds.code,
          ),
      );
      await assertPersistedLocation(
        runtime.adminPool,
        runtime,
        archivedLocationId,
        {
          archived: true,
          locationType: warehouseType,
          name: 'Original warehouse',
          revision: 2,
          code: 'WH-A',
        },
      );
      await assertPersistedLocation(
        runtime.adminPool,
        runtime,
        replacementLocationId,
        {
          archived: false,
          locationType: warehouseType,
          name: 'Replacement warehouse',
          revision: 1,
          code: 'wh-a',
        },
      );
    },
  );
});

function resolveLocation(
  runtime: RealLocationRuntime,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return resolveByName(
    runtime.queryGateway,
    view,
    {
      exactIdentifierFieldIds: [LOCATION_IDS.fieldIds.code],
      listQueryId: `${LOCATION_IDS.namespace}:query.location_list`,
      nameFieldIds: [LOCATION_IDS.fieldIds.name],
      resolveQueryId: `${LOCATION_IDS.namespace}:query.location_resolve`,
    },
    text,
  );
}

function locationValues(
  code: string,
  name: string,
  locationType: string,
): Record<string, string> {
  return {
    [LOCATION_IDS.fieldIds.locationType]: locationType,
    [LOCATION_IDS.fieldIds.name]: name,
    [LOCATION_IDS.fieldIds.code]: code,
  };
}

async function persistedLocationCount(
  pool: Pool,
  runtime: RealLocationRuntime,
  scope: 'a' | 'b',
): Promise<number> {
  const entity = locationStorage(runtime);
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM north_star_module.${quoted(entity.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2`,
    [
      LOCATION_TEST_SCOPE[scope].tenantId,
      LOCATION_TEST_SCOPE[scope].environmentId,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertPersistedLocation(
  pool: Pool,
  runtime: RealLocationRuntime,
  recordId: string,
  expected: {
    archived: boolean;
    locationType: string;
    name: string;
    revision: number;
    code: string;
  },
): Promise<void> {
  const entity = locationStorage(runtime);
  const fieldColumn = (fieldId: string): string => {
    const column = entity.columns.find(
      (candidate) => candidate.canonicalFieldId === fieldId,
    );
    assert.ok(column, `missing storage column for ${fieldId}`);
    return column.physicalName;
  };
  const result = await pool.query<{
    archived: boolean;
    locationType: string;
    name: string;
    revision: number;
    code: string;
  }>(
    `SELECT ${quoted(entity.archive.archivedAtColumn)} IS NOT NULL AS archived,
            ${quoted(fieldColumn(LOCATION_IDS.fieldIds.locationType))} AS "locationType",
            ${quoted(fieldColumn(LOCATION_IDS.fieldIds.name))} AS name,
            ${quoted(entity.optimisticRevision.column)} AS revision,
            ${quoted(fieldColumn(LOCATION_IDS.fieldIds.code))} AS code
       FROM north_star_module.${quoted(entity.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(entity.recordIdentity.column)} = $3`,
    [
      LOCATION_TEST_SCOPE.a.tenantId,
      LOCATION_TEST_SCOPE.a.environmentId,
      recordId,
    ],
  );
  assert.equal(result.rowCount, 1, 'persisted location subject is absent');
  assert.deepEqual(
    { ...result.rows[0], revision: Number(result.rows[0]?.revision) },
    expected,
  );
}

function locationStorage(runtime: RealLocationRuntime) {
  const entity = runtime.storage.entities.find(
    (candidate) => candidate.entityId === LOCATION_IDS.entityIds.location,
  );
  assert.ok(entity, 'compiled Location location storage is absent');
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
