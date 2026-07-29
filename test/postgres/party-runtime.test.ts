import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  PROJECTION_FAMILY_IDS,
  executeVerificationPlan,
  validateExecutedVerificationPlan,
  type StorageTargetPayloadV1,
  type VerificationPlanPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  ModuleRuntimeInterpreterError,
  translateModuleProviderError,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { releaseVerificationBinding } from '../../packages/postgres-provider/src/release-verification-service.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import { projectionPayload } from '../fixtures/g2/party/compiler.js';
import {
  PARTY_TEST_SCOPE,
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import { resolvePartyName } from '../fixtures/g2/party/resolver-harness.js';

test('Party executes the compiled declared-semantics contract on real PostgreSQL', async () => {
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
    await assertInternalEvidence(
      runtime.adminPool,
      createdTrust.changeDocumentId,
    );

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
        values: partyValues('p-001', 'Duplicate number', ''),
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_UNIQUE_VIOLATION',
          PARTY_IDS.fieldIds.number,
        ),
    );
    assert.equal(await trustCount(runtime.adminPool), trustBeforeDuplicate + 1);
    const partyStorage = runtime.storage.entities.find(
      (entity) => entity.entityId === PARTY_IDS.entityIds.party,
    );
    assert.ok(partyStorage);
    const uniqueNames = [
      ...partyStorage.uniqueKeys.map((unique) => unique.physicalName),
      ...partyStorage.indexes
        .filter((index) => index.indexKind === 'caseInsensitiveUnique')
        .map((index) => index.physicalName),
    ];
    assert.equal(uniqueNames.length, 2);
    for (const constraint of uniqueNames) {
      assertTypedError(
        translateModuleProviderError(
          { code: '23505', constraint },
          runtime.storage,
          PARTY_IDS.entityIds.party,
        ),
        'MODULE_UNIQUE_VIOLATION',
        PARTY_IDS.fieldIds.number,
      );
    }
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        values: {
          [PARTY_IDS.fieldIds.number]: 'P-MISSING-NAME',
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_REQUIRED_FIELD_MISSING',
          PARTY_IDS.fieldIds.name,
        ),
    );
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        unexpected: true,
        values: partyValues('P-UNKNOWN-INPUT', 'Unknown input', ''),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ModuleRuntimeInterpreterError);
        assert.equal(error.code, 'MODULE_INPUT_MALFORMED');
        assert.equal(error.subjectId, null);
        assertNoPhysicalDetails(error);
        return true;
      },
    );
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: randomUUID(),
        values: partyValues('P-BOUND', 'x'.repeat(241), ''),
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_FIELD_VALUE_INVALID',
          PARTY_IDS.fieldIds.name,
        ),
    );
    assert.equal(await trustCount(runtime.adminPool), trustBeforeDuplicate + 4);

    const compatibilityDistinctIds = [randomUUID(), randomUUID()] as const;
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: compatibilityDistinctIds[0],
      values: partyValues('Ｐ－１００', 'Fullwidth identifier', ''),
    });
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: compatibilityDistinctIds[1],
      values: partyValues('P-100', 'ASCII identifier', ''),
    });
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'Ｐ－１００')).outcome,
      'exact',
    );
    assert.equal(
      (await resolvePartyName(runtime, runtime.views.a, 'P-100')).outcome,
      'exact',
    );

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
    const confidentialSearch = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_search',
      { text: 'secret@example.test' },
    );
    assert.equal(confidentialSearch.records.length, 0);
    const publicSearch = await invokePartyQuery(
      runtime,
      runtime.views.a,
      'party_search',
      { text: 'NORTHWIND' },
    );
    assert.equal(
      publicSearch.records.some((record) => record.recordId === partyId),
      true,
    );

    const trustBeforeInvalidEnum = await trustCount(runtime.adminPool);
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_role_create', {
        recordId: randomUUID(),
        relations: { [PARTY_IDS.relationIds.roleParty]: partyId },
        values: {
          [PARTY_IDS.fieldIds.roleKind]:
            `${PARTY_IDS.namespace}:option.not-declared`,
          [PARTY_IDS.fieldIds.roleStatus]:
            `${PARTY_IDS.namespace}:option.active`,
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_ENUM_VALUE_INVALID',
          PARTY_IDS.fieldIds.roleKind,
        ),
    );
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_role_create', {
        recordId: randomUUID(),
        relations: { [PARTY_IDS.relationIds.roleParty]: partyId },
        values: {
          [PARTY_IDS.fieldIds.roleKind]:
            `${PARTY_IDS.namespace}:option.supplier`,
          [PARTY_IDS.fieldIds.roleStatus]:
            `${PARTY_IDS.namespace}:option.not-declared`,
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_ENUM_VALUE_INVALID',
          PARTY_IDS.fieldIds.roleStatus,
        ),
    );
    assert.equal(
      await trustCount(runtime.adminPool),
      trustBeforeInvalidEnum + 2,
    );
    await assertProviderRejectsInvalidEnum(
      runtime.adminPool,
      runtime.storage,
      partyId,
    );

    const racingPartyId = randomUUID();
    await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
      recordId: racingPartyId,
      values: partyValues('P-RACE', 'Archive race', ''),
    });
    const archiveCreateRace = await Promise.allSettled([
      invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
        expectedRevision: 1,
        recordId: racingPartyId,
      }),
      invokePartyOperation(runtime, runtime.views.a, 'party_role_create', {
        recordId: randomUUID(),
        relations: {
          [PARTY_IDS.relationIds.roleParty]: racingPartyId,
        },
        values: {
          [PARTY_IDS.fieldIds.roleKind]:
            `${PARTY_IDS.namespace}:option.supplier`,
          [PARTY_IDS.fieldIds.roleStatus]:
            `${PARTY_IDS.namespace}:option.active`,
        },
      }),
    ]);
    assert.equal(
      archiveCreateRace.filter((result) => result.status === 'fulfilled')
        .length,
      1,
    );
    const rejectedRace = archiveCreateRace.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.ok(rejectedRace);
    assert.ok(rejectedRace.reason instanceof ModuleRuntimeInterpreterError);
    assert.ok(
      ['MODULE_ARCHIVE_RESTRICTED', 'MODULE_RELATION_VIOLATION'].includes(
        rejectedRace.reason.code,
      ),
    );
    assert.equal(
      rejectedRace.reason.subjectId,
      PARTY_IDS.relationIds.roleParty,
    );
    assertNoPhysicalDetails(rejectedRace.reason);

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

    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
        expectedRevision: 1,
        recordId: partyId,
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_ARCHIVE_RESTRICTED',
          PARTY_IDS.relationIds.roleParty,
        ),
    );

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
    assert.equal(
      await trustCount(runtime.adminPool),
      trustBeforeCrossTenant + 2,
    );
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
    await invokePartyOperation(runtime, runtime.views.a, 'party_role_archive', {
      expectedRevision: 4,
      recordId: supplierRoleId,
    });
    await invokePartyOperation(runtime, runtime.views.a, 'party_role_archive', {
      expectedRevision: 1,
      recordId: customerRoleId,
    });
    const archived = await invokePartyOperation(
      runtime,
      runtime.views.a,
      'party_archive',
      { expectedRevision: 2, recordId: partyId },
    );
    assert.equal(archived.readBack?.archived, true);
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_role_create', {
        recordId: randomUUID(),
        relations: { [PARTY_IDS.relationIds.roleParty]: partyId },
        values: {
          [PARTY_IDS.fieldIds.roleKind]:
            `${PARTY_IDS.namespace}:option.supplier`,
          [PARTY_IDS.fieldIds.roleStatus]:
            `${PARTY_IDS.namespace}:option.active`,
        },
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_RELATION_VIOLATION',
          PARTY_IDS.relationIds.roleParty,
        ),
    );
    await assert.rejects(
      invokePartyOperation(runtime, runtime.views.a, 'party_role_restore', {
        expectedRevision: 5,
        recordId: supplierRoleId,
      }),
      (error: unknown) =>
        assertTypedError(
          error,
          'MODULE_RELATION_VIOLATION',
          PARTY_IDS.relationIds.roleParty,
        ),
    );
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
    assert.equal(
      (
        await invokePartyOperation(
          runtime,
          runtime.views.a,
          'party_role_restore',
          { expectedRevision: 5, recordId: supplierRoleId },
        )
      ).readBack?.archived,
      false,
    );

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

    const verificationPlan = projectionPayload<VerificationPlanPayloadV1>(
      runtime.compiled,
      PROJECTION_FAMILY_IDS.verificationPlan,
    );
    assert.deepEqual(
      new Set(verificationPlan.scenarios.map((scenario) => scenario.kind)),
      new Set([
        'archiveRestrict',
        'declaredEvidence',
        'enumReject',
        'resolverAuthority',
        'searchableExclusion',
        'typedErrorSurface',
        'uniquenessFold',
      ]),
    );
    for (const entityId of Object.values(PARTY_IDS.entityIds)) {
      assert.deepEqual(
        verificationPlan.scenarios
          .filter(
            (scenario) =>
              scenario.kind === 'declaredEvidence' &&
              scenario.entityId === entityId,
          )
          .map((scenario) => scenario.evidenceKind)
          .sort(),
        [
          'agent',
          'migration',
          'provider',
          'recovery',
          'structure',
          'userInterface',
        ],
      );
    }
    const verificationBinding = releaseVerificationBinding(runtime.compiled);
    const executedResults = await executeVerificationPlan(
      verificationPlan,
      {
        artifactClosureDigest: verificationBinding.artifactClosureDigest,
        providerRunId: 'party-walking-slice',
        releaseRoot: verificationBinding.releaseRoot,
        verificationPlanArtifactRoot:
          verificationBinding.verificationPlanArtifactRoot,
        verificationPlanSemanticDigest:
          verificationBinding.verificationPlanSemanticDigest,
      },
      async (scenario) => {
        const party = scenario.entityId === PARTY_IDS.entityIds.party;
        const localEntity = party ? 'party' : 'party_role';
        const scenarioRecordId = party ? partyId : supplierRoleId;
        if (scenario.kind === 'declaredEvidence') {
          if (scenario.evidenceKind === 'recovery') {
            const recoveryRecordId = randomUUID();
            if (party) {
              await invokePartyOperation(
                runtime,
                runtime.views.a,
                'party_create',
                {
                  recordId: recoveryRecordId,
                  values: partyValues(
                    `R-${recoveryRecordId}`,
                    'Recovery probe',
                    '',
                  ),
                },
              );
            } else {
              await invokePartyOperation(
                runtime,
                runtime.views.a,
                'party_role_create',
                {
                  recordId: recoveryRecordId,
                  relations: {
                    [PARTY_IDS.relationIds.roleParty]: partyId,
                  },
                  values: {
                    [PARTY_IDS.fieldIds.roleKind]:
                      `${PARTY_IDS.namespace}:option.supplier`,
                    [PARTY_IDS.fieldIds.roleStatus]:
                      `${PARTY_IDS.namespace}:option.active`,
                  },
                },
              );
            }
            await invokePartyOperation(
              runtime,
              runtime.views.a,
              `${localEntity}_archive`,
              { expectedRevision: 1, recordId: recoveryRecordId },
            );
            const restored = await invokePartyOperation(
              runtime,
              runtime.views.a,
              `${localEntity}_restore`,
              { expectedRevision: 2, recordId: recoveryRecordId },
            );
            assert.equal(restored.readBack?.archived, false);
            return { positiveProbe: restored };
          }
          const invocation = scenario.invocation as {
            query: { targetId: string };
          };
          const result = await invokePartyQuery(
            runtime,
            runtime.views.a,
            invocation.query.targetId.split(':query.')[1]!,
            { recordId: scenarioRecordId },
          );
          assert.equal(result.outcome, 'exact');
          return { positiveProbe: result };
        }
        if (scenario.kind === 'searchableExclusion') {
          const excludedValue = new Map<string, string>([
            [PARTY_IDS.fieldIds.contactSummary, 'secret@example.test'],
            [
              PARTY_IDS.fieldIds.roleKind,
              `${PARTY_IDS.namespace}:option.supplier`,
            ],
            [
              PARTY_IDS.fieldIds.roleStatus,
              `${PARTY_IDS.namespace}:option.inactive`,
            ],
          ]).get(scenario.subjectId);
          assert.ok(excludedValue);
          const excluded = await invokePartyQuery(
            runtime,
            runtime.views.a,
            `${localEntity}_search`,
            { text: excludedValue },
          );
          assert.equal(excluded.records.length, 0);
          const included = await invokePartyQuery(
            runtime,
            runtime.views.a,
            'party_search',
            { text: 'NORTHWIND EQUIPMENT' },
          );
          assert.equal(included.records.length, 1);
          return { negativeProbe: excluded, positiveProbe: included };
        }
        if (scenario.kind === 'enumReject') {
          const current = await invokePartyQuery(
            runtime,
            runtime.views.a,
            'party_role_get',
            { recordId: supplierRoleId },
          );
          const invalid = await rejectedTypedError(
            invokePartyOperation(
              runtime,
              runtime.views.a,
              'party_role_update',
              {
                expectedRevision: current.records[0]!.revision,
                patch: {
                  [scenario.subjectId]: `${PARTY_IDS.namespace}:option.not-declared`,
                },
                recordId: supplierRoleId,
              },
            ),
            'MODULE_ENUM_VALUE_INVALID',
            scenario.subjectId,
          );
          const accepted = await invokePartyOperation(
            runtime,
            runtime.views.a,
            'party_role_update',
            {
              expectedRevision: current.records[0]!.revision,
              patch: {
                [scenario.subjectId]:
                  scenario.subjectId === PARTY_IDS.fieldIds.roleKind
                    ? `${PARTY_IDS.namespace}:option.supplier`
                    : `${PARTY_IDS.namespace}:option.inactive`,
              },
              recordId: supplierRoleId,
            },
          );
          return { negativeProbe: invalid, positiveProbe: accepted };
        }
        if (scenario.kind === 'resolverAuthority') {
          const current = await invokePartyQuery(
            runtime,
            runtime.views.a,
            `${localEntity}_get`,
            { recordId: scenarioRecordId },
          );
          const text = party
            ? 'P-001'
            : String(current.records[0]?.values[PARTY_IDS.fieldIds.roleKind]);
          const resolved = await invokePartyQuery(
            runtime,
            runtime.views.a,
            `${localEntity}_resolve`,
            { text },
          );
          assert.equal(resolved.outcome, party ? 'exact' : 'ambiguous');
          const missing = await invokePartyQuery(
            runtime,
            runtime.views.a,
            `${localEntity}_resolve`,
            { text: `missing-${randomUUID()}` },
          );
          assert.equal(missing.outcome, 'not-found');
          return { negativeProbe: missing, positiveProbe: resolved };
        }
        if (scenario.kind === 'typedErrorSurface') {
          const read = await invokePartyQuery(
            runtime,
            runtime.views.a,
            `${localEntity}_get`,
            { recordId: scenarioRecordId },
          );
          const rejected = party
            ? await rejectedTypedError(
                invokePartyOperation(runtime, runtime.views.a, 'party_create', {
                  recordId: randomUUID(),
                  values: partyValues('p-001', 'Typed duplicate', ''),
                }),
                'MODULE_UNIQUE_VIOLATION',
                PARTY_IDS.fieldIds.number,
              )
            : await rejectedTypedError(
                invokePartyOperation(
                  runtime,
                  runtime.views.a,
                  'party_role_create',
                  {
                    recordId: randomUUID(),
                    relations: {
                      [PARTY_IDS.relationIds.roleParty]: randomUUID(),
                    },
                    values: {
                      [PARTY_IDS.fieldIds.roleKind]:
                        `${PARTY_IDS.namespace}:option.supplier`,
                      [PARTY_IDS.fieldIds.roleStatus]:
                        `${PARTY_IDS.namespace}:option.active`,
                    },
                  },
                ),
                'MODULE_RELATION_TARGET_NOT_FOUND',
                null,
              );
          return { negativeProbe: rejected, positiveProbe: read };
        }
        if (scenario.kind === 'archiveRestrict') {
          const parentId = randomUUID();
          const dependentId = randomUUID();
          await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
            recordId: parentId,
            values: partyValues(`R-${parentId}`, 'Restrict parent', ''),
          });
          await invokePartyOperation(
            runtime,
            runtime.views.a,
            'party_role_create',
            {
              recordId: dependentId,
              relations: { [PARTY_IDS.relationIds.roleParty]: parentId },
              values: {
                [PARTY_IDS.fieldIds.roleKind]:
                  `${PARTY_IDS.namespace}:option.supplier`,
                [PARTY_IDS.fieldIds.roleStatus]:
                  `${PARTY_IDS.namespace}:option.active`,
              },
            },
          );
          const rejected = await rejectedTypedError(
            invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
              expectedRevision: 1,
              recordId: parentId,
            }),
            'MODULE_ARCHIVE_RESTRICTED',
            scenario.subjectId,
          );
          const accepted = await invokePartyOperation(
            runtime,
            runtime.views.a,
            'party_role_archive',
            { expectedRevision: 1, recordId: dependentId },
          );
          return { negativeProbe: rejected, positiveProbe: accepted };
        }
        const uniqueId = randomUUID();
        const uniqueValue = `V-${uniqueId}`;
        const accepted = await invokePartyOperation(
          runtime,
          runtime.views.a,
          'party_create',
          {
            recordId: uniqueId,
            values: partyValues(uniqueValue, 'Fold probe', ''),
          },
        );
        const rejected = await rejectedTypedError(
          invokePartyOperation(runtime, runtime.views.a, 'party_create', {
            recordId: randomUUID(),
            values: partyValues(
              uniqueValue.toLowerCase(),
              'Fold duplicate',
              '',
            ),
          }),
          'MODULE_UNIQUE_VIOLATION',
          scenario.subjectId,
        );
        return { negativeProbe: rejected, positiveProbe: accepted };
      },
    );
    assert.deepEqual(
      validateExecutedVerificationPlan(verificationPlan, executedResults),
      { diagnostics: [], status: 'passed' },
    );
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

async function assertInternalEvidence(
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
  assert.match(serialized, /Northwind Rentals/);
  assert.match(serialized, /secret@example\.test/);
  assert.match(serialized, /P-001/);
  assert.match(serialized, /INTERNAL/);
  assert.doesNotMatch(serialized, /REDACTED|SENSITIVE|SECRET/);
}

async function assertProviderRejectsCrossTenantRelation(
  pool: Pool,
  storage: StorageTargetPayloadV1,
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
    let providerError: unknown;
    try {
      await client.query(
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
      );
      assert.fail('cross-tenant relation insert unexpectedly succeeded');
    } catch (error) {
      providerError = error;
    }
    assertTypedError(
      translateModuleProviderError(
        providerError,
        storage,
        PARTY_IDS.entityIds.role,
      ),
      'MODULE_RELATION_VIOLATION',
      PARTY_IDS.relationIds.roleParty,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function assertProviderRejectsInvalidEnum(
  pool: Pool,
  storage: StorageTargetPayloadV1,
  partyId: string,
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
          `${PARTY_IDS.namespace}:option.not-declared`,
          `${PARTY_IDS.namespace}:option.active`,
          partyId,
        ],
      ),
      /check constraint/i,
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

function assertTypedError(
  error: unknown,
  code: string,
  subjectId: string | null,
): true {
  assert.ok(error instanceof ModuleRuntimeInterpreterError);
  assert.equal(error.code, code);
  assert.equal(error.subjectId, subjectId);
  assertNoPhysicalDetails({
    code: error.code,
    message: error.message,
    subjectId: error.subjectId,
  });
  return true;
}

async function rejectedTypedError(
  promise: Promise<unknown>,
  code: string,
  subjectId: string | null,
): Promise<{ code: string; subjectId: string | null }> {
  try {
    await promise;
  } catch (error) {
    assertTypedError(error, code, subjectId);
    return { code, subjectId };
  }
  assert.fail(`expected ${code}`);
}
