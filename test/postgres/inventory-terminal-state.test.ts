import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  APPLICATION_NAMESPACE,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantId = 'aa100000-0000-4000-8000-000000000001';
const environmentId = 'aa200000-0000-4000-8000-000000000002';
const principalId = 'aa300000-0000-4000-8000-000000000003';
const legalEntityId = 'aa400000-0000-4000-8000-000000000004';
const itemId = 'aa500000-0000-4000-8000-000000000005';
const locationId = 'aa600000-0000-4000-8000-000000000006';
const transactionId = 'aa700000-0000-4000-8000-000000000007';
const transactionLineId = 'aa800000-0000-4000-8000-000000000008';
const postedTransactionId = 'aa900000-0000-4000-8000-000000000009';
const reversedTransactionId = 'aaa00000-0000-4000-8000-00000000000a';
const postedTransactionLineId = 'aab00000-0000-4000-8000-00000000000b';
const postedParentTransactionId = 'aac00000-0000-4000-8000-00000000000c';

type StorageEntity = StorageTargetPayloadV1['entities'][number];

test('draft transaction and terminal stock-count evidence is enforced by the real gateway and PostgreSQL interpreter', async () => {
  const definition = inventoryApplicationDefinition();
  const emptyDefinition = emptyApplicationDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const stockCount = requiredEntity(storage, 'stock_count');
  const stockCountLine = requiredEntity(storage, 'stock_count_line');
  const transaction = requiredEntity(storage, 'inventory_transaction');
  const transactionLine = requiredEntity(storage, 'inventory_transaction_line');
  const item = requiredEntity(storage, 'item');
  const location = requiredEntity(storage, 'location');
  const legalEntity = storage.entities.find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  assert.ok(legalEntity?.legalEntityMaster);

  const postedSessionId = 'ab100000-0000-4000-8000-000000000001';
  const countingSessionId = 'ab200000-0000-4000-8000-000000000002';
  const reviewedSessionId = 'ab300000-0000-4000-8000-000000000003';
  const correctionSessionId = 'ab400000-0000-4000-8000-000000000004';
  const postedLineId = 'ab500000-0000-4000-8000-000000000005';
  const archivedPostedLineId = 'ab600000-0000-4000-8000-000000000006';

  await withEphemeralPostgres(
    'inventory-terminal-state',
    async ({ connection, pool }) => {
      await migrateAndProvision(pool, compiled.releaseRoot);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 4,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = await trustedContext();
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition],
          [compiled, definition],
        ]);
        await setPointer(pool, releases[0]!);
        await grantExecutorAuthority(pool);
        const prepared = await new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        ).prepare({
          context,
          expiresAt: '2099-01-01T00:00:00.000Z',
          generationId: randomUUID(),
          initiatedBy: principalId,
          preparationId: randomUUID(),
          targetReleaseId: releases[1]!,
        });
        assert.equal(prepared.schemaState, 'APPLIED');

        await seedLegalEntityMaster(pool, legalEntity);
        await insertRecord(pool, storage, item, itemId, null, {}, {});
        await insertRecord(pool, storage, location, locationId, null, {}, {});
        await insertRecord(
          pool,
          storage,
          transaction,
          transactionId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_state')]: optionId(
              'inventory_transaction_state_draft',
            ),
          },
          {},
        );
        await insertRecord(
          pool,
          storage,
          transactionLine,
          transactionLineId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_line_item_id')]: itemId,
          },
          {
            [relationId('inventory_transaction_line_transaction')]:
              transactionId,
          },
        );
        await insertRecord(
          pool,
          storage,
          transaction,
          postedTransactionId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_number')]: 'POSTED-TRANSACTION',
            [fieldId('inventory_transaction_state')]: optionId(
              'inventory_transaction_state_posted',
            ),
          },
          {},
        );
        await insertRecord(
          pool,
          storage,
          transaction,
          postedParentTransactionId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_number')]: 'POSTED-PARENT',
            [fieldId('inventory_transaction_state')]: optionId(
              'inventory_transaction_state_posted',
            ),
          },
          {},
        );
        await insertRecord(
          pool,
          storage,
          transactionLine,
          postedTransactionLineId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_line_item_id')]: itemId,
          },
          {
            [relationId('inventory_transaction_line_transaction')]:
              postedParentTransactionId,
          },
        );
        await insertRecord(
          pool,
          storage,
          transaction,
          reversedTransactionId,
          legalEntityId,
          {
            [fieldId('inventory_transaction_number')]: 'REVERSED-TRANSACTION',
            [fieldId('inventory_transaction_state')]: optionId(
              'inventory_transaction_state_reversed',
            ),
          },
          {},
        );

        await seedStockCount(
          pool,
          storage,
          stockCount,
          postedSessionId,
          'POSTED-1',
          'posted',
          null,
        );
        await seedStockCount(
          pool,
          storage,
          stockCount,
          countingSessionId,
          'COUNTING-1',
          'counting',
          null,
        );
        await seedStockCount(
          pool,
          storage,
          stockCount,
          reviewedSessionId,
          'REVIEWED-1',
          'reviewed',
          null,
        );
        await seedStockCount(
          pool,
          storage,
          stockCount,
          correctionSessionId,
          'CORRECTION-1',
          'counting',
          postedSessionId,
        );
        await seedStockCountLine(
          pool,
          storage,
          stockCountLine,
          postedLineId,
          postedSessionId,
          1,
        );
        await seedStockCountLine(
          pool,
          storage,
          stockCountLine,
          archivedPostedLineId,
          postedSessionId,
          2,
        );
        await pool.query(
          `UPDATE north_star_module.${quoted(stockCountLine.physicalTableName)}
              SET ${quoted(stockCountLine.archive.archivedAtColumn)} = '2026-07-30T00:00:00.000Z'
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(stockCountLine.recordIdentity.column)} = $3`,
          [tenantId, environmentId, archivedPostedLineId],
        );

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const mediation = new SemanticOperationMediationAuthority();
        const gateway = new SemanticOperationGateway(
          policy,
          interpreter,
          mediation,
        );
        const pointer = await activePointer(pool);
        const view = await issuedCandidateView(
          compiled,
          releases[1]!,
          pointer,
          policy,
        );

        // T1: a draft candidate is admitted. Both non-draft options are then
        // refused so this control distinguishes `equals draft` from the weaker
        // `not equals posted`, which would silently admit a reversed source.
        const admittedTransactionId = randomUUID();
        const draftCreate = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_create',
          {
            legalEntityId,
            recordId: admittedTransactionId,
            relations: {},
            values: requiredOperationValues(transaction, {
              [fieldId('inventory_transaction_number')]: 'DRAFT-CANDIDATE',
              [fieldId('inventory_transaction_state')]: optionId(
                'inventory_transaction_state_draft',
              ),
            }),
          },
        );
        assert.equal(draftCreate.outcome, 'succeeded');
        assert.equal(draftCreate.readBack?.revision, 1);
        assert.equal(
          draftCreate.readBack?.values[fieldId('inventory_transaction_state')],
          optionId('inventory_transaction_state_draft'),
        );
        for (const terminalState of ['posted', 'reversed'] as const) {
          await assertOperationRefused(
            invokeOperation(
              gateway,
              mediation,
              view,
              'inventory_transaction_create',
              {
                legalEntityId,
                recordId: randomUUID(),
                relations: {},
                values: requiredOperationValues(transaction, {
                  [fieldId('inventory_transaction_number')]:
                    `FORGED-${terminalState.toUpperCase()}`,
                  [fieldId('inventory_transaction_state')]: optionId(
                    `inventory_transaction_state_${terminalState}`,
                  ),
                }),
              },
            ),
          );
        }

        // T2: an ordinary draft-to-draft update succeeds, while both terminal
        // projected images refuse. The second refusal is the non-vacuity twin
        // that rules out a merely `not posted` predicate.
        const draftUpdate = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_update',
          {
            expectedRevision: 1,
            patch: {
              [fieldId('inventory_transaction_number')]: 'DRAFT-REWRITE',
            },
            recordId: transactionId,
          },
        );
        assert.equal(draftUpdate.outcome, 'succeeded');
        assert.equal(draftUpdate.readBack?.revision, 2);
        for (const terminalState of ['posted', 'reversed'] as const) {
          await assertOperationRefused(
            invokeOperation(
              gateway,
              mediation,
              view,
              'inventory_transaction_update',
              {
                expectedRevision: 2,
                patch: {
                  [fieldId('inventory_transaction_state')]: optionId(
                    `inventory_transaction_state_${terminalState}`,
                  ),
                },
                recordId: transactionId,
              },
            ),
          );
        }

        // T3: archive and restore are visibility lifecycle operations, not
        // draft mutation. They remain admitted for a posted source and preserve
        // its state. Applying the transaction predicate to all four generic
        // operations would make this admission twin red.
        const postedArchive = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_archive',
          { expectedRevision: 1, recordId: postedTransactionId },
        );
        assert.equal(postedArchive.outcome, 'succeeded');
        assert.equal(postedArchive.readBack?.archived, true);
        assert.equal(postedArchive.readBack?.revision, 2);
        assert.equal(
          postedArchive.readBack?.values[
            fieldId('inventory_transaction_state')
          ],
          optionId('inventory_transaction_state_posted'),
        );
        const postedRestore = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_restore',
          { expectedRevision: 2, recordId: postedTransactionId },
        );
        assert.equal(postedRestore.outcome, 'succeeded');
        assert.equal(postedRestore.readBack?.archived, false);
        assert.equal(postedRestore.readBack?.revision, 3);
        assert.equal(
          postedRestore.readBack?.values[
            fieldId('inventory_transaction_state')
          ],
          optionId('inventory_transaction_state_posted'),
        );

        // T4: prior-image evaluation refuses attempts to turn either terminal
        // state back into a draft. The projected image is deliberately valid,
        // so removing the prior-image check makes these controls go green for
        // the wrong tree and then fail here.
        for (const [recordId, expectedRevision] of [
          [postedTransactionId, 3],
          [reversedTransactionId, 1],
        ] as const) {
          await assertOperationRefused(
            invokeOperation(
              gateway,
              mediation,
              view,
              'inventory_transaction_update',
              {
                expectedRevision,
                patch: {
                  [fieldId('inventory_transaction_state')]: optionId(
                    'inventory_transaction_state_draft',
                  ),
                },
                recordId,
              },
            ),
          );
        }

        // T5: transaction lines are parentScopedChild. ADR-0034 resolves the
        // target transaction's UPDATE predicate for every child mutation, so a
        // draft parent's line remains writable and a posted parent's line does
        // not. This is an inherited effect of the transaction guard, not a
        // second predicate authored on the line operations.
        const draftLineUpdate = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_line_update',
          {
            expectedRevision: 1,
            patch: {
              [fieldId('inventory_transaction_line_quantity')]: '2',
            },
            recordId: transactionLineId,
          },
        );
        assert.equal(draftLineUpdate.outcome, 'succeeded');
        assert.equal(draftLineUpdate.readBack?.revision, 2);
        await assertOperationRefused(
          invokeOperation(
            gateway,
            mediation,
            view,
            'inventory_transaction_line_update',
            {
              expectedRevision: 1,
              patch: {
                [fieldId('inventory_transaction_line_quantity')]: '2',
              },
              recordId: postedTransactionLineId,
            },
          ),
        );
        const draftLineCreate = await invokeOperation(
          gateway,
          mediation,
          view,
          'inventory_transaction_line_create',
          {
            legalEntityId,
            recordId: randomUUID(),
            relations: {
              [relationId('inventory_transaction_line_transaction')]:
                transactionId,
            },
            values: requiredOperationValues(transactionLine, {
              [fieldId('inventory_transaction_line_item_id')]: itemId,
              [fieldId('inventory_transaction_line_line_number')]: '2',
            }),
          },
        );
        assert.equal(draftLineCreate.outcome, 'succeeded');
        await assertOperationRefused(
          invokeOperation(
            gateway,
            mediation,
            view,
            'inventory_transaction_line_create',
            {
              legalEntityId,
              recordId: randomUUID(),
              relations: {
                [relationId('inventory_transaction_line_transaction')]:
                  postedParentTransactionId,
              },
              values: requiredOperationValues(transactionLine, {
                [fieldId('inventory_transaction_line_item_id')]: itemId,
                [fieldId('inventory_transaction_line_line_number')]: '2',
              }),
            },
          ),
        );

        // C1: prior-image evaluation refuses a generic update of posted
        // evidence. The patch un-posts the session deliberately, so the
        // PROJECTED image satisfies not(equals posted) and ONLY the prior-image
        // check can refuse it. Patching an unrelated field instead would leave
        // the projected image posted, and the control would stay red even if
        // prior-image evaluation were removed entirely -- red for the wrong
        // reason, which is what this control was sent back for.
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_update', {
            expectedRevision: 1,
            patch: {
              [fieldId('stock_count_number')]: 'POSTED-REWRITE',
              [fieldId('stock_count_state')]: optionId(
                'stock_count_state_draft',
              ),
            },
            recordId: postedSessionId,
          }),
        );

        // C2: the identical operation on counting evidence succeeds.
        const countingUpdate = await invokeOperation(
          gateway,
          mediation,
          view,
          'stock_count_update',
          {
            expectedRevision: 1,
            patch: { [fieldId('stock_count_number')]: 'COUNTING-REWRITE' },
            recordId: countingSessionId,
          },
        );
        assert.equal(countingUpdate.outcome, 'succeeded');
        assert.equal(countingUpdate.readBack?.revision, 2);

        // C3: projected and candidate images cannot forge posted state.
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_update', {
            expectedRevision: 1,
            patch: {
              [fieldId('stock_count_state')]: optionId(
                'stock_count_state_posted',
              ),
            },
            recordId: reviewedSessionId,
          }),
        );
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_create', {
            legalEntityId,
            recordId: randomUUID(),
            relations: {
              [relationId('stock_count_transaction')]: transactionId,
            },
            values: requiredOperationValues(stockCount, {
              [fieldId('stock_count_location_id')]: locationId,
              [fieldId('stock_count_number')]: 'FORGED-POSTED',
              [fieldId('stock_count_state')]: optionId(
                'stock_count_state_posted',
              ),
            }),
          }),
        );

        // C4: archive/restore paths evaluate terminal state too.
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_archive', {
            expectedRevision: 1,
            recordId: postedSessionId,
          }),
        );
        await assertOperationRefused(
          invokeOperation(
            gateway,
            mediation,
            view,
            'stock_count_line_restore',
            { expectedRevision: 1, recordId: archivedPostedLineId },
          ),
        );

        // C5: create resolves and guards a parentScopedChild target.
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_line_create', {
            legalEntityId,
            recordId: randomUUID(),
            relations: {
              [relationId('stock_count_line_session')]: postedSessionId,
              [relationId('stock_count_line_transaction_line')]:
                transactionLineId,
            },
            values: requiredOperationValues(stockCountLine, {
              [fieldId('stock_count_line_item_id')]: itemId,
              [fieldId('stock_count_line_line_number')]: '3',
            }),
          }),
        );

        // C6: existing child update and archive resolve the stored parent ID.
        await assertOperationRefused(
          invokeOperation(gateway, mediation, view, 'stock_count_line_update', {
            expectedRevision: 1,
            patch: {
              [fieldId('stock_count_line_counted_quantity')]: '2',
            },
            recordId: postedLineId,
          }),
        );
        await assertOperationRefused(
          invokeOperation(
            gateway,
            mediation,
            view,
            'stock_count_line_archive',
            { expectedRevision: 1, recordId: postedLineId },
          ),
        );

        // C7: references are not aggregate ownership. The correction remains
        // writable even though its supersedes reference targets posted evidence.
        const correctionUpdate = await invokeOperation(
          gateway,
          mediation,
          view,
          'stock_count_update',
          {
            expectedRevision: 1,
            patch: { [fieldId('stock_count_number')]: 'CORRECTION-REWRITE' },
            recordId: correctionSessionId,
          },
        );
        assert.equal(correctionUpdate.outcome, 'succeeded');
        assert.equal(correctionUpdate.readBack?.revision, 2);
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('C8 compiler ratchets the exact stock-count terminal guard and required state', () => {
  const baseline = inventoryApplicationDefinition();
  const empty = mustCompile(moduleInput(emptyApplicationDefinition(baseline)));
  const mutants: Array<{
    label: string;
    mutate(definition: Record<string, unknown>): void;
  }> = [
    // Every one of the four generic operations gets its own missing-guard and
    // wrong-option mutant. Mutating only stock_count_update left the other
    // three arms untested: dropping the restore arm from the conformance rule
    // would have compiled silently, and no runtime control covers it either --
    // C4 restores a LINE under a guarded parent, not a session.
    ...(['archive', 'create', 'restore', 'update'] as const).flatMap(
      (action) => [
        {
          label: `missing precondition on stock_count_${action}`,
          mutate(definition: Record<string, unknown>) {
            delete operation(definition, `stock_count_${action}`).precondition;
          },
        },
        {
          label: `wrong terminal option on stock_count_${action}`,
          mutate(definition: Record<string, unknown>) {
            const guard = operation(definition, `stock_count_${action}`)
              .precondition as {
              term: { value: { value: string } };
            };
            guard.term.value.value = optionId('stock_count_state_draft');
          },
        },
      ],
    ),
    {
      label: 'optional state operand',
      mutate(definition) {
        const fields = definition.fields as Array<Record<string, unknown>>;
        const state = fields.find(
          (field) => field.fieldId === fieldId('stock_count_state'),
        );
        assert.ok(state);
        state.presence = 'optional';
      },
    },
  ];
  for (const mutant of mutants) {
    const definition = structuredClone(baseline);
    mutant.mutate(definition);
    const result = compileApplication(
      moduleInput(definition, expectedActiveReleaseFrom(empty)),
    );
    assert.equal(result.status, 'failed', mutant.label);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'INVENTORY_TERMINAL_GUARD_MISSING',
      ),
      mutant.label,
    );
  }
});

test('C9 an unparseable operation precondition still refuses before execution', async () => {
  const definition = inventoryApplicationDefinition();
  const compiled = mustCompile(moduleInput(definition));
  const policy = new AllowPolicy();
  const executor = new RecordingOperationExecutor();
  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(policy, executor, mediation);
  const operationProjection = runtimeProjection(
    compiled,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
  );
  const payload = structuredClone(operationProjection.payload);
  assertJsonObject(payload);
  const operations = payload.operations;
  assert.ok(Array.isArray(operations));
  let corrupted = false;
  const corruptedOperations = operations.map((candidate) => {
    assertJsonObject(candidate);
    if (candidate.operationId !== operationId('stock_count_update')) {
      return candidate;
    }
    corrupted = true;
    return Object.freeze({
      ...candidate,
      precondition: Object.freeze({
        kind: 'notPredicate',
        schemaVersion: compiled.bundle.releaseManifest.languageVersion,
      }),
    });
  });
  assert.equal(
    corrupted,
    true,
    'stock_count_update must be present in the operation catalog',
  );
  const corruptedPayload: ImmutableJsonValue = Object.freeze({
    ...payload,
    operations: Object.freeze(corruptedOperations),
  });
  const view = await issuedCandidateView(
    compiled,
    randomUUID(),
    { fence: 1, pointerId: randomUUID() },
    policy,
    Object.freeze({
      ...operationProjection,
      payload: corruptedPayload,
    }),
  );
  const result = await invokeOperation(
    gateway,
    mediation,
    view,
    'stock_count_update',
    { expectedRevision: 1, patch: {}, recordId: randomUUID() },
  );
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.unsupportedReason, 'operation-precondition-unsupported');
  assert.equal(executor.calls.length, 0);
  assert.deepEqual(
    executor.nonAccepted.map(({ failureCode }) => failureCode),
    ['SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED'],
  );
});

class AllowPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest): Promise<{
    decision: 'ALLOW';
    decisionVersion: typeof CURRENT_POLICY_DECISION_VERSION;
    policyVersion: string;
  }> {
    void _request;
    return {
      decision: 'ALLOW',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'inventory-terminal-state-policy/v1',
    };
  }

  async readCurrentVersion(
    _subject: CurrentPolicySubject,
  ): Promise<{ policyVersion: string }> {
    void _subject;
    return { policyVersion: 'inventory-terminal-state-policy/v1' };
  }
}

class RecordingOperationExecutor implements SemanticOperationExecutor {
  readonly calls: SemanticOperationExecutionRequest[] = [];
  readonly nonAccepted: SemanticOperationNonAcceptedRequest[] = [];

  async execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.calls.push(request);
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: null,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: null,
      unsupportedReason: null,
    };
  }

  async recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    this.nonAccepted.push(request);
  }
}

function assertJsonObject(
  value: ImmutableJsonValue,
): asserts value is { readonly [key: string]: ImmutableJsonValue } {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

async function assertOperationRefused(
  operationResult: Promise<SemanticOperationResultEnvelope>,
): Promise<void> {
  await assert.rejects(operationResult, (error: unknown) => {
    assert.ok(error instanceof ModuleRuntimeInterpreterError);
    assert.equal(
      error.code,
      'MODULE_OPERATION_PRECONDITION_REFUSED',
      error.subjectId ?? undefined,
    );
    return true;
  });
}

async function invokeOperation(
  gateway: SemanticOperationGateway,
  mediation: SemanticOperationMediationAuthority,
  view: RequestRuntimeView,
  localId: string,
  input: Record<string, unknown>,
): Promise<SemanticOperationResultEnvelope> {
  const id = operationId(localId);
  const confirmationRequired = (
    view.projections.operation.payload as {
      operations: Array<{ confirmation: string; operationId: string }>;
    }
  ).operations.some(
    (candidate) =>
      candidate.operationId === id &&
      candidate.confirmation === 'humanRequired',
  );
  return gateway.invoke(
    view,
    {
      confirmationGrant: confirmationRequired
        ? mediation.issueConfirmationGrant(
            view,
            id,
            input as ImmutableJsonValue,
          )
        : null,
      idempotencyKey: randomUUID(),
      input,
      operationId: id,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    mediation.issueInvocation(view, 'API'),
  );
}

function inventoryApplicationDefinition(): Record<string, unknown> {
  const application = composedApplicationDefinition();
  const inventory = inventoryModuleDefinition(APPLICATION_NAMESPACE);
  for (const collection of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ] as const) {
    const composed = application[collection] as unknown[];
    for (const entry of inventory[collection] as unknown[]) {
      assert.equal(
        composed.filter(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(entry),
        ).length,
        1,
        `composed application must contain each inventory ${collection} entry exactly once`,
      );
    }
  }
  const inventoryModule = (
    inventory.modules as Array<Record<string, unknown>>
  )[0];
  assert.ok(inventoryModule);
  assert.equal(
    (application.modules as Array<Record<string, unknown>>).filter(
      (candidate) => candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return application;
}

function emptyApplicationDefinition(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const definition = structuredClone(source);
  for (const collection of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    definition[collection] = [];
  }
  return definition;
}

function operation(
  definition: Record<string, unknown>,
  localId: string,
): Record<string, unknown> {
  const operations = definition.operations as Array<Record<string, unknown>>;
  const selected = operations.find(
    (candidate) => candidate.operationId === operationId(localId),
  );
  assert.ok(selected);
  return selected;
}

function operationId(localId: string): string {
  return `${APPLICATION_NAMESPACE}:operation.${localId}`;
}

function fieldId(localId: string): string {
  return `${APPLICATION_NAMESPACE}:field.${localId}`;
}

function relationId(localId: string): string {
  return `${APPLICATION_NAMESPACE}:relation.${localId}`;
}

function optionId(localId: string): string {
  return `${APPLICATION_NAMESPACE}:option.${localId}`;
}

function requiredEntity(
  storage: StorageTargetPayloadV1,
  localId: string,
): StorageEntity {
  const entity = storage.entities.find(
    (candidate) =>
      candidate.entityId === `${APPLICATION_NAMESPACE}:entity.${localId}`,
  );
  assert.ok(entity, `missing ${localId} storage entity`);
  return entity;
}

function requiredOperationValues(
  entity: StorageEntity,
  overrides: Readonly<Record<string, ImmutableJsonValue>>,
): Record<string, ImmutableJsonValue> {
  return Object.fromEntries(
    entity.columns
      .filter((column) => column.fieldContract.required)
      .map((column) => [
        column.canonicalFieldId,
        Object.hasOwn(overrides, column.canonicalFieldId)
          ? overrides[column.canonicalFieldId]!
          : operationDefaultValue(column),
      ]),
  );
}

function operationDefaultValue(
  column: StorageEntity['columns'][number],
): ImmutableJsonValue {
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return false;
    case 'dateFieldType':
      return '2026-07-30';
    case 'dateTimeFieldType':
      return '2026-07-30T12:00:00.000Z';
    case 'enumFieldType':
      return column.fieldContract.enumOptionIds[0]!;
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return '1';
    case 'integerFieldType':
      return '1';
    case 'textFieldType': {
      const maximumLength = column.fieldContract.bounds.maximumLength ?? 80;
      return column.physicalName.slice(0, maximumLength);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

async function seedStockCount(
  pool: pg.Pool,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
  number: string,
  state: 'counting' | 'posted' | 'reviewed',
  supersedesId: string | null,
): Promise<void> {
  await insertRecord(
    pool,
    storage,
    entity,
    recordId,
    legalEntityId,
    {
      [fieldId('stock_count_location_id')]: locationId,
      [fieldId('stock_count_number')]: number,
      [fieldId('stock_count_state')]: optionId(`stock_count_state_${state}`),
    },
    {
      [relationId('stock_count_supersedes')]: supersedesId,
      [relationId('stock_count_transaction')]: transactionId,
    },
  );
}

async function seedStockCountLine(
  pool: pg.Pool,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
  stockCountId: string,
  lineNumber: number,
): Promise<void> {
  await insertRecord(
    pool,
    storage,
    entity,
    recordId,
    legalEntityId,
    {
      [fieldId('stock_count_line_item_id')]: itemId,
      [fieldId('stock_count_line_line_number')]: lineNumber,
    },
    {
      [relationId('stock_count_line_session')]: stockCountId,
      [relationId('stock_count_line_transaction_line')]: transactionLineId,
    },
  );
}

async function insertRecord(
  pool: pg.Pool,
  storage: StorageTargetPayloadV1,
  entity: StorageEntity,
  recordId: string,
  scopedLegalEntityId: string | null,
  overrides: Readonly<Record<string, unknown>>,
  relationValues: Readonly<Record<string, string | null>>,
): Promise<void> {
  const relations = storage.relations.filter(
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
    tenantId,
    environmentId,
    ...(entity.legalEntity ? [scopedLegalEntityId] : []),
    recordId,
    ...entity.columns.map((column) =>
      Object.hasOwn(overrides, column.canonicalFieldId)
        ? overrides[column.canonicalFieldId]
        : databaseDefaultValue(column, recordId),
    ),
    ...relations.map((relation) => {
      const value = relationValues[relation.relationId];
      if (value !== undefined) return value;
      assert.equal(
        relation.relationColumn.nullable,
        true,
        `missing required relation ${relation.relationId}`,
      );
      return null;
    }),
  ];
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (${columns.map(quoted).join(', ')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
}

function databaseDefaultValue(
  column: StorageEntity['columns'][number],
  recordId: string,
): unknown {
  if (!column.fieldContract.required) return null;
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return false;
    case 'dateFieldType':
      return '2026-07-30';
    case 'dateTimeFieldType':
      return '2026-07-30T12:00:00.000Z';
    case 'enumFieldType':
      return column.fieldContract.enumOptionIds[0];
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return '1';
    case 'integerFieldType':
      return 1;
    case 'textFieldType': {
      const maximumLength = column.fieldContract.bounds.maximumLength ?? 80;
      return `${column.physicalName}-${recordId.slice(0, 8)}`.slice(
        0,
        maximumLength,
      );
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

async function seedLegalEntityMaster(
  pool: pg.Pool,
  entity: StorageEntity,
): Promise<void> {
  assert.ok(entity.legalEntityMaster);
  const master = entity.legalEntityMaster;
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)} (
       tenant_id,
       environment_id,
       ${quoted(entity.recordIdentity.column)},
       ${quoted(entity.optimisticRevision.column)},
       ${quoted(master.fieldColumns.code)},
       ${quoted(master.fieldColumns.name)},
       ${quoted(master.fieldColumns.status)},
       ${quoted(master.fieldColumns.isDefault)}
     ) VALUES ($1, $2, $3, 1, 'LE-TERM', 'Terminal state entity', $4, false)
     ON CONFLICT (tenant_id, environment_id, ${quoted(entity.recordIdentity.column)})
     DO NOTHING`,
    [tenantId, environmentId, legalEntityId, master.activeStatusValue],
  );
}

async function migrateAndProvision(
  pool: pg.Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(migrations);
    const result = await runMigrations(client, loaded);
    assert.equal(result.applied.length, loaded.length);
    assert.equal(result.verified.length, loaded.length);
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-terminal-state'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-TERM','Terminal state entity','UTC','00:00:00',$4,
         1::smallint,'reject',0,'codeOnly','codeOnly','codeOnly','codeOnly',
         'codeOnly',NULL,NULL,NULL,NULL,NULL
       )`,
      [tenantId, environmentId, legalEntityId, contractReleaseRoot],
    );
  } finally {
    client.release();
  }
}

async function trustedContext(): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(
    async (): Promise<AuthenticatedIdentity> => ({
      environmentId,
      principalId,
      tenantId,
    }),
  ).enter({ headers: { authorization: 'inventory-terminal-state' } });
}

async function persistSequence(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = randomUUID() as MintedUuid;
    const releaseId = randomUUID() as MintedUuid;
    const bytes = definitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, bytes),
    );
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    });
    if (releaseVerificationBinding(compiled).plan.scenarios.length === 0) {
      await new PostgresReleaseVerificationService(
        runtimePool,
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: compiled,
        evidenceId: staged.verificationEvidenceId,
        releaseId,
      });
      await repository.registerTenantRelease(
        context,
        releaseCommand(
          context,
          releaseId,
          revisionId,
          staged.verificationEvidenceId,
          compiled,
        ),
      );
    }
    releases.push(releaseId);
  }
  return releases;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = parseNormalizedApplicationPackageJson(desiredState);
  const digest = canonicalizeAndHash(normalized);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalized.languageVersion,
    normalizationProfileVersion: normalized.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalized.schemaVersion,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  revisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

async function setPointer(pool: pg.Pool, releaseId: MintedUuid): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id=$3, fence=fence+1
        WHERE tenant_id=$1 AND environment_id=$2`,
      [tenantId, environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(pool: pg.Pool): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
    [tenantId, principalId, randomUUID()],
  );
}

async function activePointer(
  pool: pg.Pool,
): Promise<LoadedRequestRuntimeDefinition['pointer']> {
  const result = await pool.query<{ fence: string; pointer_id: string }>(
    `SELECT pointer_id, fence::text
       FROM platform.active_release_pointers
      WHERE tenant_id=$1 AND environment_id=$2`,
    [tenantId, environmentId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    fence: Number(row.fence),
    pointerId: row.pointer_id,
  };
}

async function issuedCandidateView(
  compiled: CompileSuccess,
  releaseId: string,
  pointer: LoadedRequestRuntimeDefinition['pointer'],
  policy: CurrentPolicyGateway,
  operationProjection = runtimeProjection(
    compiled,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
  ),
): Promise<RequestRuntimeView> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId,
          pointer,
          projections: {
            agent: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
            ),
            catalog: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
            ),
            operation: operationProjection,
            query: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
            ),
            surface: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
            ),
          },
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, async (view) => view);
}

function humanActorIssuer(): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: {
          kind: 'HUMAN',
          principalId: context.principalId,
        },
        initiatingHumanId: context.principalId,
        subject: null,
      };
    },
  });
}

function definitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function moduleInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: definitionBytes(definition),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: Array<{ contentHash: string }> };
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  return Object.freeze({
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: projectionPayload<ImmutableJsonValue>(compiled, familyId),
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  });
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}
