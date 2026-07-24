import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import { projectionPayload } from '../fixtures/g2/party/compiler.js';
import {
  PARTY_TEST_SCOPE,
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import { resolvePartyName } from '../fixtures/g2/party/resolver-harness.js';

test('Party walking slice reaches real PostgreSQL with trust, lifecycle, resolver and tenant invariants', async () => {
  await withRealPartyRuntime('party-walking-slice', async (runtime) => {
    const partyId = randomUUID();
    const hiddenPartyId = randomUUID();
    const created = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_create',
      {
        recordId: partyId,
        values: partyValues(
          'P-001',
          'Northwind Rentals',
          'secret@example.test',
        ),
      },
    );
    assert.equal(created.outcome, 'succeeded');
    const createdTrust = created.trust;
    assert.ok(createdTrust);
    assert.deepEqual(
      created.readBack?.values,
      partyValues('P-001', 'Northwind Rentals', 'secret@example.test'),
    );
    await assertLinkedTrust(runtime.adminPool, createdTrust.invocationId);
    await assertRedacted(runtime.adminPool, createdTrust.changeDocumentId);

    await invokePartyOperation(runtime, runtime.views.b, 'party_create', {
      recordId: hiddenPartyId,
      values: partyValues('P-001', 'Tenant B Hidden', ''),
    });
    for (const [recordId, number] of [
      [randomUUID(), 'P-002'],
      [randomUUID(), 'P-003'],
    ] as const) {
      await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId,
        values: partyValues(number, 'Duplicate Trading', ''),
      });
    }
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: randomUUID(),
      values: partyValues('P-004', 'Maximum Construction', ''),
    });
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: randomUUID(),
      values: partyValues('P-005', 'P-004', ''),
    });

    const trustBeforeDuplicate = await trustCount(runtime.adminPool);
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        values: partyValues('P-001', 'Duplicate number', ''),
      }),
      /duplicate key|unique constraint/i,
    );
    assert.equal(await trustCount(runtime.adminPool), trustBeforeDuplicate);
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        values: {
          [PARTY_IDS.fieldIds.number]: 'P-MISSING-NAME',
        },
      }),
      /required field .*party_name.* is missing/i,
    );
    assert.equal(await trustCount(runtime.adminPool), trustBeforeDuplicate);

    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'P-001')).outcome,
      'exact',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Maximum Construction'))
        .outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Duplicate Trading'))
        .outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'P-004')).outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Maxmium Constructon'))
        .outcome,
      'ambiguous',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Missing')).outcome,
      'not-found',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Tenant B Hidden'))
        .outcome,
      'not-found',
    );
    const tenantAList = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_list',
      { limit: 100 },
    );
    assert.equal(
      tenantAList.records.some((record) => record.recordId === hiddenPartyId),
      false,
    );
    assertNoPhysicalDetails(tenantAList);

    const supplierRoleId = randomUUID();
    const customerRoleId = randomUUID();
    for (const [recordId, role] of [
      [supplierRoleId, `${PARTY_IDS.namespace}:option.supplier`],
      [customerRoleId, `${PARTY_IDS.namespace}:option.customer`],
    ]) {
      const roleCreated = await invokePartyOperation(
        runtime,
        runtime.views.a,
        'party_role_create',
        {
          recordId,
          relations: { [PARTY_IDS.relationIds.roleParty]: partyId },
          values: {
            [PARTY_IDS.fieldIds.roleKind]: role,
            [PARTY_IDS.fieldIds.roleStatus]:
              `${PARTY_IDS.namespace}:option.active`,
          },
        },
      );
      assert.equal(roleCreated.outcome, 'succeeded');
      assert.ok(roleCreated.trust);
    }
    const roleList = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_role_list',
      { limit: 100 },
    );
    assert.equal(roleList.records.length, 2);
    const updatedRole = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_role_update',
      {
        expectedRevision: 1,
        patch: {
          [PARTY_IDS.fieldIds.roleStatus]:
            `${PARTY_IDS.namespace}:option.inactive`,
        },
        recordId: supplierRoleId,
      },
    );
    assert.equal(updatedRole.readBack?.revision, 2);
    const archivedRole = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_role_archive',
      { expectedRevision: 2, recordId: supplierRoleId },
    );
    assert.equal(archivedRole.readBack?.archived, true);
    assert.equal(
      (
        await invokePartyQuery(runtime, runtime.views.a, 'party_role_list', {
          limit: 100,
        })
      ).records.length,
      1,
    );
    const restoredRole = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_role_restore',
      { expectedRevision: 3, recordId: supplierRoleId },
    );
    assert.equal(restoredRole.readBack?.archived, false);

    const trustBeforeCrossTenant = await trustCount(runtime.adminPool);
    for (const targetId of [hiddenPartyId, randomUUID()]) {
      await assert.rejects(
        invokePartyOperation(runtime, runtime.views.a, 'party_role_create', {
          recordId: randomUUID(),
          relations: { [PARTY_IDS.relationIds.roleParty]: targetId },
          values: {
            [PARTY_IDS.fieldIds.roleKind]:
              `${PARTY_IDS.namespace}:option.supplier`,
            [PARTY_IDS.fieldIds.roleStatus]:
              `${PARTY_IDS.namespace}:option.active`,
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ModuleRuntimeInterpreterError);
          assert.equal(error.code, 'MODULE_RELATION_TARGET_NOT_FOUND');
          assert.equal(error.message, 'relation target was not found');
          return true;
        },
      );
    }
    assert.equal(await trustCount(runtime.adminPool), trustBeforeCrossTenant);
    await assertProviderRejectsCrossTenantRelation(
      runtime.adminPool,
      runtime.storage,
      hiddenPartyId,
    );

    const updated = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_update',
      {
        expectedRevision: 1,
        patch: {
          [PARTY_IDS.fieldIds.name]: 'Northwind Equipment',
        },
        recordId: partyId,
      },
    );
    assert.equal(updated.readBack?.revision, 2);
    const archived = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_archive',
      { expectedRevision: 2, recordId: partyId },
    );
    assert.equal(archived.readBack?.archived, true);
    assert.equal(
      (
        await invokePartyQuery(runtime, runtime.views.a, 'party_get', {
          recordId: partyId,
        })
      ).outcome,
      'not-found',
    );
    assert.equal(
      (
        await invokePartyQuery(runtime, runtime.views.a, 'party_get', {
          includeArchived: true,
          recordId: partyId,
        })
      ).outcome,
      'exact',
    );
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_restore', {
        expectedRevision: 2,
        recordId: partyId,
      }),
      /revision does not match expectedRevision/i,
    );
    const restored = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_restore',
      { expectedRevision: 3, recordId: partyId },
    );
    assert.equal(restored.readBack?.archived, false);

    const queryDto = (
      await invokePartyQuery(runtime, runtime.views.a, 'party_get', {
        recordId: partyId,
      })
    ).records[0];
    assert.deepEqual(queryDto, restored.readBack);
    const agent = projectionPayload<{
      queries: Array<{ queryId: string }>;
    }>(runtime.compiled, PROJECTION_FAMILY_IDS.agentDiscovery);
    assert.equal(
      agent.queries.some(
        (query) => query.queryId === `${PARTY_IDS.namespace}:query.party_get`,
      ),
      true,
    );
    const agentDto = (
      await runtime.queryGateway.invoke(runtime.views.a, {
        arguments: { recordId: partyId },
        queryId: `${PARTY_IDS.namespace}:query.party_get`,
        schemaVersion: 'northstar.semantic-query-request/v1',
      })
    ).records[0];
    assert.deepEqual(agentDto, queryDto);
  });
});

function partyValues(
  number: string,
  name: string,
  contactSummary: string,
): Record<string, string> {
  return {
    [PARTY_IDS.fieldIds.contactSummary]: contactSummary,
    [PARTY_IDS.fieldIds.name]: name,
    [PARTY_IDS.fieldIds.number]: number,
  };
}

async function trustCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM platform.trust_action_invocations',
  );
  return Number(result.rows[0]?.count ?? 0);
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

async function assertRedacted(
  pool: Pool,
  changeDocumentId: string,
): Promise<void> {
  const result = await pool.query<{ changes: unknown }>(
    `SELECT changes
       FROM platform.trust_business_change_documents
      WHERE change_document_id = $1`,
    [changeDocumentId],
  );
  const serialized = JSON.stringify(result.rows[0]?.changes);
  assert.doesNotMatch(serialized, /Northwind|secret@example\.test|P-001/);
  assert.match(serialized, /REDACTED/);
}

async function assertProviderRejectsCrossTenantRelation(
  pool: Pool,
  storage: import('../../packages/compiler/src/index.js').StorageTargetPayloadV1,
  hiddenPartyId: string,
): Promise<void> {
  const role = storage.entities.find(
    (entity) => entity.entityId === PARTY_IDS.entityIds.role,
  );
  const relation = storage.relations.find(
    (entry) => entry.relationId === PARTY_IDS.relationIds.roleParty,
  );
  assert.ok(role);
  assert.ok(relation);
  const roleKind = role.columns.find(
    (column) => column.canonicalFieldId === PARTY_IDS.fieldIds.roleKind,
  );
  const roleStatus = role.columns.find(
    (column) => column.canonicalFieldId === PARTY_IDS.fieldIds.roleStatus,
  );
  assert.ok(roleKind);
  assert.ok(roleStatus);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true)`,
      [PARTY_TEST_SCOPE.a.tenantId, PARTY_TEST_SCOPE.a.environmentId],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO north_star_module.${quoted(role.physicalTableName)}
          (tenant_id, environment_id, ${quoted(role.recordIdentity.column)},
           ${quoted(roleKind.physicalName)}, ${quoted(roleStatus.physicalName)},
           ${quoted(relation.relationColumn.physicalName)})
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          PARTY_TEST_SCOPE.a.tenantId,
          PARTY_TEST_SCOPE.a.environmentId,
          randomUUID(),
          `${PARTY_IDS.namespace}:option.supplier`,
          `${PARTY_IDS.namespace}:option.active`,
          hiddenPartyId,
        ],
      ),
      /foreign key constraint/i,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertNoPhysicalDetails(value: unknown): void {
  assert.doesNotMatch(
    JSON.stringify(value),
    /north_star_module|nsm_[ctik]_|storageClass/,
  );
}
