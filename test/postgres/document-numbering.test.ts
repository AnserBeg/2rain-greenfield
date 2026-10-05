import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  SemanticQueryExecutionRequest,
  SemanticQueryExecutor,
  SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import {
  inspectPredicateForExecution,
  unicodeCaseFold,
} from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import type { MintedUuid } from '../../packages/platform-runtime/src/index.js';
import {
  fulfillmentColumn,
  fulfillmentTable,
  quoteFulfillmentIdentifier,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  PostgresModuleRuntimeInterpreter,
  verificationSentinelNumber,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  compilePartyFixture,
  projectionPayload,
} from '../fixtures/g2/party/compiler.js';
import {
  PARTY_IDS,
  partyModuleDefinition,
} from '../fixtures/g2/party/definition.js';
import {
  PARTY_TEST_SCOPE,
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
  type RealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import {
  governedProjection,
  governedReleaseRoot,
  governedStorageTarget,
} from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';

test(
  'document numbers are assigned by the server: sequential, concurrent-safe, retry-stable, never typed, never reused',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const target = await governedStorageTarget();
      const order = target.entities.find(
        (value) => value.entityId === `${ns}:entity.sales_order`,
      )!;
      const numberColumn = fulfillmentColumn(order, 'sales_order_number');
      const invoke = (
        operation: string,
        input: ImmutableJsonValue,
        key = randomUUID(),
      ) =>
        fixture.app.runtime.entry.run({ headers: {} }, (view) => {
          const operationId = `${ns}:operation.${operation}`;
          const definition = parsePinnedOperationCatalog(
            view.projections.operation.payload,
          ).find((value) => value.operationId === operationId)!;
          return fixture.app.runtime.operationGateway.invoke(
            view,
            {
              schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
              operationId,
              input,
              idempotencyKey: key,
              confirmationGrant:
                definition.confirmation === 'humanRequired'
                  ? fixture.app.runtime.operationMediation.issueConfirmationGrant(
                      view,
                      operationId,
                      input,
                    )
                  : null,
            },
            fixture.app.runtime.operationMediation.issueInvocation(view, 'UI'),
          );
        });
      const orderInput = (
        legalEntityId: string = fixture.scope,
        extra: Record<string, ImmutableJsonValue> = {},
      ) => ({
        recordId: randomUUID(),
        legalEntityId,
        values: {
          [`${ns}:field.sales_order_customer_party_id`]: fixture.customer,
          [`${ns}:field.sales_order_order_date`]: new Date().toISOString(),
          [`${ns}:field.sales_order_currency`]: 'CAD',
          ...extra,
        },
        relations: {},
      });
      const numberOf = (result: Awaited<ReturnType<typeof invoke>>) =>
        result.readBack?.values[`${ns}:field.sales_order_number`];
      const allNumbers = async () =>
        (
          await fixture.pool.query<{ number: string }>(
            `SELECT "${numberColumn}" AS number FROM ${fulfillmentTable(order)}
              WHERE tenant_id = $1 AND environment_id = $2 ORDER BY 1`,
            [
              fixture.app.runtime.identity.tenantId,
              fixture.app.runtime.identity.environmentId,
            ],
          )
        ).rows.map((row) => row.number);
      // Release verification arranged its own archived orders at activation;
      // they carry `V-` sentinels and never take a real number.
      // Asserted first so a verification that consumed real numbers fails by
      // this message rather than by the absence of its sentinels.
      assert.deepEqual(
        (await allNumbers()).filter((number) => !number.startsWith('V-')),
        [],
        'release verification must not consume real document numbers',
      );
      assert.ok(
        (await allNumbers()).some((number) => number.startsWith('V-')),
        'release verification arranged sentinel-numbered orders',
      );
      const storedNumbers = async () =>
        (await allNumbers()).filter((number) => !number.startsWith('V-'));

      // The published contract: no writable number, one assignment.
      const contract = await fixture.app.runtime.entry.run(
        { headers: {} },
        (view) =>
          Promise.resolve(
            parsePinnedOperationCatalog(view.projections.operation.payload),
          ),
      );
      for (const [operation, prefix] of [
        ['sales_order_create', 'SO'],
        ['purchase_order_create', 'PO'],
        ['shipment_create', 'SHP'],
        // PURCHASING-PARITY: a goods receipt is numbered the same way.
        ['goods_receipt_create', 'RCV'],
      ] as const) {
        const inputContract = contract.find(
          (value) => value.operationId === `${ns}:operation.${operation}`,
        )!.inputContract!;
        const field = `${ns}:field.${operation.replace(/_create$/u, '')}_number`;
        assert.ok(!inputContract.writableFieldIds.includes(field));
        assert.deepEqual(
          inputContract.assignedFields?.map((entry) => [
            entry.fieldId,
            entry.prefix,
            entry.minimumDigits,
          ]),
          [[field, prefix, 6]],
        );
      }
      const update = contract.find(
        (value) => value.operationId === `${ns}:operation.sales_order_update`,
      )!.inputContract!;
      assert.ok(
        !update.writableFieldIds.includes(`${ns}:field.sales_order_number`),
      );

      // Release verification EXECUTED every scenario of every numbered entity
      // when it admitted this release: the create writes an assigned number,
      // so the number needs no caller input; the probes that search, resolve
      // or compare it read the stored value back; and the number's uniqueness
      // probe is an assigned field's. None was derived for want of a number.
      const numbered = contract.flatMap(({ effect, inputContract }) => {
        if (effect.kind !== 'createRecordEffect') return [];
        const entityId = effect.entity.targetId;
        return (inputContract?.assignedFields ?? []).map((field) => ({
          entityId,
          fieldId: field.fieldId,
        }));
      });
      assert.deepEqual(
        numbered.map((entry) => entry.fieldId).toSorted(),
        [
          'customer_credit_number',
          'customer_invoice_number',
          'customer_payment_number',
          'goods_receipt_number',
          'purchase_order_number',
          'sales_order_number',
          'shipment_number',
        ].map((local) => `${ns}:field.${local}`),
      );
      const plan = (
        await governedProjection<{
          scenarios: {
            entityId: string;
            kind: string;
            scenarioId: string;
            subjectId: string;
          }[];
        }>('northstar.compiler:projection-family.verification-plan')
      ).payload;
      const numberedEntityIds = new Set(
        numbered.map((entry) => entry.entityId),
      );
      const numberedScenarioIds = plan.scenarios
        .filter((scenario) => numberedEntityIds.has(scenario.entityId))
        .map((scenario) => scenario.scenarioId);
      const releaseRoot = await governedReleaseRoot();
      const executed = new Set(
        (
          await fixture.pool.query<{ scenario_id: string }>(
            `SELECT result.scenario_id
               FROM platform.release_verification_results AS result
               JOIN platform.release_verification_evidence AS evidence
                 ON evidence.tenant_id = result.tenant_id
                AND evidence.environment_id = result.environment_id
                AND evidence.verification_evidence_id = result.verification_evidence_id
              WHERE evidence.release_root = $1`,
            [releaseRoot],
          )
        ).rows.map((row) => row.scenario_id),
      );
      assert.ok(executed.size > 0, 'the admitted release has executed results');
      assert.deepEqual(
        numberedScenarioIds.filter((scenarioId) => !executed.has(scenarioId)),
        [],
        'release verification executed every scenario of a numbered entity',
      );
      assert.deepEqual(
        plan.scenarios
          .filter(
            (scenario) =>
              scenario.kind === 'uniquenessFold' &&
              numbered.some((entry) => entry.fieldId === scenario.subjectId),
          )
          .map((scenario) => executed.has(scenario.scenarioId)),
        [true, true, true, true, true, true, true],
        'each number’s uniqueness probe executed',
      );
      const derivationCodes = (
        await fixture.pool.query<{ code: string }>(
          `SELECT derivation -> 'reason' ->> 'code' AS code
             FROM platform.release_verification_evidence AS evidence,
                  jsonb_array_elements(
                    coalesce(evidence.impact_analysis_derivation -> 'derivations', '[]'::jsonb)
                  ) AS derivation
            WHERE evidence.release_root = $1`,
          [releaseRoot],
        )
      ).rows.map((row) => row.code);
      assert.equal(
        derivationCodes.includes(
          'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
        ),
        false,
        'no scenario was derived for want of a caller-supplied input',
      );

      // Sequential from SO-000001.
      const first = await invoke('sales_order_create', orderInput());
      const second = await invoke('sales_order_create', orderInput());
      assert.equal(numberOf(first), 'SO-000001');
      assert.equal(numberOf(second), 'SO-000002');

      // The change document records the assigned number.
      const documents = await fixture.pool.query<{ changes: string }>(
        `SELECT changes::text AS changes FROM platform.trust_business_change_documents
          WHERE record_id = $1`,
        [first.readBack!.recordId],
      );
      assert.equal(documents.rows.length, 1);
      assert.match(documents.rows[0]!.changes, /SO-000001/u);

      // A typed number is refused and writes nothing.
      const before = await storedNumbers();
      await assert.rejects(
        invoke(
          'sales_order_create',
          orderInput(fixture.scope, {
            [`${ns}:field.sales_order_number`]: 'SO-999999',
          }),
        ),
      );
      assert.deepEqual(await storedNumbers(), before);
      // An update cannot change an assigned number.
      await assert.rejects(
        invoke('sales_order_update', {
          recordId: first.readBack!.recordId,
          expectedRevision: first.readBack!.revision,
          patch: { [`${ns}:field.sales_order_number`]: 'SO-000777' },
        }),
      );
      assert.deepEqual(await storedNumbers(), before);

      // A retry of the same request keeps its record and number.
      const key = randomUUID();
      const retried = orderInput();
      const once = await invoke('sales_order_create', retried, key);
      const again = await invoke('sales_order_create', retried, key);
      assert.equal(numberOf(once), 'SO-000003');
      assert.equal(numberOf(again), 'SO-000003');
      assert.equal(again.readBack?.recordId, once.readBack?.recordId);
      assert.equal((await storedNumbers()).length, 3);

      // Concurrent creates serialize: ten distinct, consecutive numbers.
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () =>
          invoke('sales_order_create', orderInput()),
        ),
      );
      assert.deepEqual(
        concurrent.map((result) => String(numberOf(result))).sort(),
        Array.from(
          { length: 10 },
          (_, index) => `SO-${String(index + 4).padStart(6, '0')}`,
        ),
      );

      // Archiving keeps the number reserved: archive the order holding the
      // highest number, and the next still follows it.
      const highest = concurrent.find(
        (result) => numberOf(result) === 'SO-000013',
      )!;
      const archived = await invoke('sales_order_archive', {
        recordId: highest.readBack!.recordId,
        expectedRevision: highest.readBack!.revision,
      });
      assert.equal(archived.outcome, 'succeeded');
      const afterArchive = await invoke('sales_order_create', orderInput());
      assert.equal(numberOf(afterArchive), 'SO-000014');

      // One tenant sequence across companies.
      const company = await fixture.measure('second_company');
      const otherCompany = await invoke(
        'sales_order_create',
        orderInput(String((company as { companyId: string }).companyId)),
      );
      assert.equal(numberOf(otherCompany), 'SO-000015');
      const numbers = await storedNumbers();
      assert.equal(new Set(numbers).size, numbers.length);
      assert.equal(numbers.length, 15);

      // A different document type has its own sequence.
      const purchase = await invoke('purchase_order_create', {
        recordId: randomUUID(),
        legalEntityId: fixture.scope,
        values: {
          [`${ns}:field.purchase_order_supplier_party_id`]: fixture.customer,
          [`${ns}:field.purchase_order_order_date`]: new Date().toISOString(),
          [`${ns}:field.purchase_order_currency`]: 'CAD',
        },
        relations: {},
      });
      assert.equal(
        purchase.readBack?.values[`${ns}:field.purchase_order_number`],
        'PO-000001',
      );
      // Its receipt draft takes its own number (PURCHASING-PARITY).
      const receipt = await invoke('goods_receipt_create', {
        recordId: randomUUID(),
        legalEntityId: fixture.scope,
        values: {
          [`${ns}:field.goods_receipt_state`]: `${ns}:option.goods_receipt_state_draft`,
          [`${ns}:field.goods_receipt_kind`]: `${ns}:option.goods_receipt_kind_initial`,
          [`${ns}:field.goods_receipt_effective_at`]: new Date().toISOString(),
          [`${ns}:field.goods_receipt_location_id`]: fixture.location,
          [`${ns}:field.goods_receipt_reason_code`]: 'RECEIVE',
          [`${ns}:field.goods_receipt_reason_narrative`]: 'Numbered receipt',
        },
        relations: {
          [`${ns}:relation.goods_receipt_order`]: purchase.readBack!.recordId,
        },
      });
      assert.equal(
        receipt.readBack?.values[`${ns}:field.goods_receipt_number`],
        'RCV-000001',
      );

      // The scan reads a number of any digit count. Stored numbers are set
      // directly here, as an earlier release or an import could have left
      // them: more than eighteen digits (leading zeros) still sets the next.
      const renumber = (recordId: string, number: string) =>
        fixture.pool.query(
          `UPDATE ${fulfillmentTable(order)} SET "${numberColumn}" = $3
            WHERE tenant_id = $1 AND record_id = $2`,
          [fixture.app.runtime.identity.tenantId, recordId, number],
        );
      const created = async () =>
        numberOf(await invoke('sales_order_create', orderInput()));
      // Stored values are read the way the unique business key compares them,
      // by full Unicode case fold: `ſO-000016` (long s) folds to `so-000016`,
      // the key's spelling of SO-000016, so the next number is SO-000017.
      await renumber(afterArchive.readBack!.recordId, 'ſO-000016');
      assert.equal(await created(), 'SO-000017');
      // An expanding fold reads the same way. No prefix here contains one, so
      // the installed fold -- the function the stored companion is generated
      // by -- is asked directly: `ß-000001` is `ss-000001`, which the scan's
      // pattern for a prefix `SS` reads as number 1.
      const expanding = await fixture.pool.query<{ digits: string | null }>(
        `SELECT (regexp_match(north_star_module.nsm_unicode_case_fold_v1($1), $2))[1] AS digits`,
        ['ß-000001', `^${unicodeCaseFold('SS')}-([0-9]+)$`],
      );
      assert.equal(expanding.rows[0]?.digits, '000001');
      await renumber(otherCompany.readBack!.recordId, 'SO-0000000000000000042');
      assert.equal(await created(), 'SO-000043');
      // The allocator's own nineteen-digit output is read back next time.
      await renumber(otherCompany.readBack!.recordId, 'SO-999999999999999999');
      assert.equal(await created(), 'SO-1000000000000000000');
      assert.equal(await created(), 'SO-1000000000000000001');
      // A next number that no longer fits the 60-character field is refused
      // by name, and nothing is written.
      await renumber(otherCompany.readBack!.recordId, `SO-${'9'.repeat(57)}`);
      const stored = (await storedNumbers()).length;
      await assert.rejects(
        invoke('sales_order_create', orderInput()),
        (error: unknown) =>
          (error as { code?: unknown }).code ===
          'MODULE_DOCUMENT_SEQUENCE_EXHAUSTED',
      );
      assert.equal((await storedNumbers()).length, stored);
    });
  },
);

// A create's read-back is the get its operation names -- a declared projection,
// not the record -- and nothing makes it select an assigned number. Party is
// numbered here three ways: `party_number`, which the create's read-back
// selects; `party_account_number`, which only a second get selects; and the
// role's `party_role_number`, which no get selects at all (the role's list,
// search and resolve do, and the resolve matches it first).
const partyNumber = PARTY_IDS.fieldIds.number;
const accountNumber = `${PARTY_IDS.namespace}:field.party_account_number`;
const roleNumber = `${PARTY_IDS.namespace}:field.party_role_number`;

test(
  'release verification reads assigned numbers its create read-back omits, and archives every record it creates',
  { timeout: 300_000 },
  async () => {
    await withRealPartyRuntime(
      'verification-assigned-witness',
      async (runtime) => {
        const party = storageEntity(runtime.storage, PARTY_IDS.entityIds.party);
        const role = storageEntity(runtime.storage, PARTY_IDS.entityIds.role);
        const stored = (
          entity: StorageEntity,
          tenantId: string,
          environmentId: string,
          fieldIds: readonly string[],
        ) => storedRecords(runtime, entity, tenantId, environmentId, fieldIds);

        // The premise: each create's read-back omits a number it assigns.
        const operations = projectionPayload<{
          operations: { operationId: string; readBackQueryId: string }[];
        }>(runtime.compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
        const queries = projectionPayload<{
          queries: {
            queryId: string;
            queryType: string;
            selections: { fieldId: string }[];
          }[];
        }>(runtime.compiled, PROJECTION_FAMILY_IDS.queryCatalog).queries;
        const selecting = (fieldId: string, queryType?: string) =>
          queries
            .filter(
              (query) =>
                (queryType === undefined || query.queryType === queryType) &&
                query.selections.some(
                  (selection) => selection.fieldId === fieldId,
                ),
            )
            .map((query) => query.queryId);
        const readBackOf = (local: string) =>
          operations.find(
            (operation) =>
              operation.operationId ===
              `${PARTY_IDS.namespace}:operation.${local}`,
          )?.readBackQueryId;
        assert.ok(selecting(partyNumber).includes(readBackOf('party_create')!));
        assert.ok(
          !selecting(accountNumber).includes(readBackOf('party_create')!),
        );
        assert.deepEqual(selecting(accountNumber, 'get'), [
          `${PARTY_IDS.namespace}:query.party_account_get`,
        ]);
        assert.ok(
          !selecting(roleNumber).includes(readBackOf('party_role_create')!),
        );
        assert.deepEqual(selecting(roleNumber, 'get'), []);

        // Activation admitted the release: its verification executed every
        // scenario and derived none, the probes that consume a number included.
        const plan = releaseVerificationBinding(runtime.compiled).plan;
        const probes = plan.scenarios.map(
          (scenario) => `${scenario.kind} ${scenario.subjectId}`,
        );
        for (const probe of [
          `uniquenessFold ${partyNumber}`,
          `uniquenessFold ${accountNumber}`,
          `uniquenessFold ${roleNumber}`,
          `searchableExclusion ${accountNumber}`,
          `resolverAuthority ${PARTY_IDS.namespace}:query.party_resolve`,
          `resolverAuthority ${PARTY_IDS.namespace}:query.party_role_resolve`,
        ]) {
          assert.ok(probes.includes(probe), probe);
        }
        const executedIn = await admittedEvidence(runtime);
        assert.equal(executedIn.execution_scope, 'FULL', 'nothing was derived');
        assert.deepEqual(
          executedIn.scenarioIds,
          plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
          'release verification executed every scenario',
        );

        // Every number verification arranged is its record's sentinel -- read
        // back, read through the second get, or (the role's) used unread --
        // and no record it arranged is left live.
        const arranged = [
          [
            party,
            await stored(
              party,
              executedIn.executed_tenant_id,
              executedIn.executed_environment_id,
              [partyNumber, accountNumber],
            ),
            [partyNumber, accountNumber],
          ],
          [
            role,
            await stored(
              role,
              executedIn.executed_tenant_id,
              executedIn.executed_environment_id,
              [roleNumber],
            ),
            [roleNumber],
          ],
        ] as const;
        for (const [entity, records, fieldIds] of arranged) {
          assert.ok(
            records.length > 0,
            `verification arranged ${entity.entityId}`,
          );
          for (const record of records) {
            for (const fieldId of fieldIds) {
              assert.equal(
                record.values[fieldId],
                verificationSentinelNumber(
                  record.recordId,
                  fieldId,
                  storageColumn(entity, fieldId).fieldContract.bounds
                    .maximumLength,
                ),
              );
            }
          }
          assert.deepEqual(
            records
              .filter((record) => !record.archived)
              .map((record) => record.recordId),
            [],
            `verification left no ${entity.entityId} record live`,
          );
        }

        // A verification whose creates take real numbers stops at its first
        // numbered create: the read-back says `PTY-000001`, not the record's
        // sentinel. The record was registered for archiving before its numbers
        // were read, so it is archived all the same.
        const staged = await stagedInTenantA(runtime);
        await assert.rejects(
          new PostgresReleaseVerificationService(
            runtime.runtimePool,
          ).executeSemanticCandidateWithExecutor(
            runtime.contexts.a,
            staged,
            new PostgresModuleRuntimeInterpreter(
              runtime.runtimePool,
              humanActorIssuer(),
            ),
          ),
          (error: unknown) => {
            assert.equal(
              (error as { code?: unknown }).code,
              'VERIFICATION_ASSIGNED_VALUE_MISMATCH',
              String(error),
            );
            return true;
          },
        );
        assert.deepEqual(
          (
            await stored(
              party,
              PARTY_TEST_SCOPE.a.tenantId,
              PARTY_TEST_SCOPE.a.environmentId,
              [partyNumber, accountNumber],
            )
          ).map((record) => [
            record.values[partyNumber],
            record.values[accountNumber],
            record.archived,
          ]),
          [['PTY-000001', 'ACC-000001', true]],
          'the record a stopped verification created is archived',
        );
        assert.deepEqual(
          await stored(
            role,
            PARTY_TEST_SCOPE.a.tenantId,
            PARTY_TEST_SCOPE.a.environmentId,
            [roleNumber],
          ),
          [],
        );
      },
      numberedPartyDefinition(),
    );
  },
);

// A get the compiler admits need not be one the gateway runs: a Q0 get whose
// filter is not the literal `true` is answered `unsupported`, without a read.
// Party is numbered as above, but its `party_account_get` -- the entity's first
// get, ahead of `party_get` -- is filtered `false`; the account number is also
// selected by `party_z_account_get`, which runs, and the role's number only by
// `party_role_number_get`, filtered `false`.
const partyGet = `${PARTY_IDS.namespace}:query.party_get`;
const unexecutedAccountGet = `${PARTY_IDS.namespace}:query.party_account_get`;
const executedAccountGet = `${PARTY_IDS.namespace}:query.party_z_account_get`;
const unexecutedRoleGet = `${PARTY_IDS.namespace}:query.party_role_number_get`;

test(
  'release verification reads numbers and archives records only through gets the gateway executes, and refuses a probe record it cannot read',
  { timeout: 300_000 },
  async () => {
    await withRealPartyRuntime(
      'verification-executed-gets',
      async (runtime) => {
        const party = storageEntity(runtime.storage, PARTY_IDS.entityIds.party);
        const role = storageEntity(runtime.storage, PARTY_IDS.entityIds.role);

        // The premise: the compiler admitted both gets that do not run, the
        // party's sorts first, and the gateway answers it without reading.
        type Query = {
          filter: unknown;
          lifecycle: string;
          queryId: string;
          queryType: string;
          selections: { fieldId: string }[];
          sourceEntityId: string;
          tier: string;
        };
        const gets = (predicate: (query: Query) => boolean) =>
          projectionPayload<{ queries: Query[] }>(
            runtime.compiled,
            PROJECTION_FAMILY_IDS.queryCatalog,
          )
            .queries.filter(
              (query) => query.queryType === 'get' && predicate(query),
            )
            .map((query) => query.queryId);
        const selecting = (fieldId: string) => (query: Query) =>
          query.selections.some((selection) => selection.fieldId === fieldId);
        assert.deepEqual(
          gets((query) => query.sourceEntityId === PARTY_IDS.entityIds.party),
          [unexecutedAccountGet, partyGet, executedAccountGet],
        );
        assert.deepEqual(gets(selecting(accountNumber)), [
          unexecutedAccountGet,
          executedAccountGet,
        ]);
        assert.deepEqual(gets(selecting(roleNumber)), [unexecutedRoleGet]);
        assert.deepEqual(
          gets(
            (query) =>
              query.lifecycle !== 'active' ||
              query.tier !== 'q0' ||
              inspectPredicateForExecution(query.filter).outcome !== 'accepted',
          ),
          [unexecutedAccountGet, unexecutedRoleGet],
        );
        const unexecuted = await invokePartyQuery(
          runtime,
          runtime.views.a,
          'party_account_get',
          { recordId: randomUUID() },
        );
        assert.deepEqual(
          [unexecuted.outcome, unexecuted.unsupportedReason],
          ['unsupported', 'query-filter-unsupported'],
        );

        // Activation admitted the release and executed every scenario: no
        // number read as missing, the account number read through the get
        // that runs and the role's used unread, as its sentinel; and cleanup
        // archived every record, although the party's first get does not run.
        const plan = releaseVerificationBinding(runtime.compiled).plan;
        const executedIn = await admittedEvidence(runtime);
        assert.equal(executedIn.execution_scope, 'FULL', 'nothing was derived');
        assert.deepEqual(
          executedIn.scenarioIds,
          plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
          'release verification executed every scenario',
        );
        for (const [entity, fieldIds] of [
          [party, [partyNumber, accountNumber]],
          [role, [roleNumber]],
        ] as const) {
          const records = await storedRecords(
            runtime,
            entity,
            executedIn.executed_tenant_id,
            executedIn.executed_environment_id,
            fieldIds,
          );
          assert.ok(
            records.length > 0,
            `verification arranged ${entity.entityId}`,
          );
          for (const record of records) {
            for (const fieldId of fieldIds) {
              assert.equal(
                record.values[fieldId],
                verificationSentinelNumber(
                  record.recordId,
                  fieldId,
                  storageColumn(entity, fieldId).fieldContract.bounds
                    .maximumLength,
                ),
              );
            }
          }
          assert.deepEqual(
            records
              .filter((record) => !record.archived)
              .map((record) => record.recordId),
            [],
            `verification left no ${entity.entityId} record live`,
          );
        }

        // A probe record the cleanup get cannot read is refused by name, not
        // skipped, after every record that can be read is archived. Here
        // `party_get` is answered as the interpreter answers a get whose
        // pinned contract it does not support: `unsupported`, with no record.
        const executor = new UnsupportedGetExecutor(runtime, partyGet);
        const staged = await stagedInTenantA(runtime);
        let refusal = '';
        await assert.rejects(
          new PostgresReleaseVerificationService(
            runtime.runtimePool,
          ).executeSemanticCandidateWithExecutor(
            runtime.contexts.a,
            staged,
            executor,
          ),
          (error: unknown) => {
            assert.equal(
              (error as { code?: unknown }).code,
              'VERIFICATION_PROBE_RECORD_UNREADABLE',
              String(error),
            );
            refusal = String(error);
            return true;
          },
        );
        assert.ok(
          executor.queryIds.has(executedAccountGet),
          'the account number was read through the get that runs',
        );
        const roles = await storedRecords(
          runtime,
          role,
          PARTY_TEST_SCOPE.a.tenantId,
          PARTY_TEST_SCOPE.a.environmentId,
          [roleNumber],
        );
        assert.ok(roles.length > 0, 'the stopped verification arranged roles');
        assert.deepEqual(
          roles
            .filter((record) => !record.archived)
            .map((record) => record.recordId),
          [],
          'every record cleanup could read is archived',
        );
        const liveParties = (
          await storedRecords(
            runtime,
            party,
            PARTY_TEST_SCOPE.a.tenantId,
            PARTY_TEST_SCOPE.a.environmentId,
            [partyNumber],
          )
        ).filter((record) => !record.archived);
        assert.ok(
          liveParties.length > 0,
          'the records cleanup could not read are left live',
        );
        assert.deepEqual(
          liveParties
            .map((record) => record.recordId)
            .filter(
              (recordId) =>
                !refusal.includes(
                  `${recordId} of ${PARTY_IDS.entityIds.party} through ${partyGet} (unsupported: query-contract-unsupported)`,
                ),
            ),
          [],
          'the refusal names every record it leaves live',
        );
      },
      numberedPartyDefinition({ unexecutedGets: true }),
    );
  },
);

// A search the gateway executes need not be Q0: the gateway runs a Q1 query
// through its compiled filter plan, and the search probe's positive read
// needs the record back. Party's `party_search` is Q1 here with the literal
// `true` filter, keeping its id and sorting first; `party_z_search`, a Q0 copy
// filtered `false` with fresh ids, sorts after it. Party's gets and its
// operations' read-backs are unchanged.
const q1Search = `${PARTY_IDS.namespace}:query.party_search`;
const unexecutedSearch = `${PARTY_IDS.namespace}:query.party_z_search`;

test(
  'release verification probes search through an executable Q1 search, ahead of a Q0 search the gateway does not run',
  { timeout: 300_000 },
  async () => {
    const definition = q1SearchPartyDefinition();

    // The premise, compiled: the Q1 search carries a lowering plan, the Q0
    // search a filter the gateway's fence refuses, and every get is Q0.
    type Query = {
      filter: unknown;
      filterPlan?: unknown;
      queryId: string;
      queryType: string;
      sourceEntityId: string;
      tier: string;
    };
    const queries = projectionPayload<{ queries: Query[] }>(
      compilePartyFixture(definition).compiled,
      PROJECTION_FAMILY_IDS.queryCatalog,
    ).queries.filter(
      (query) => query.sourceEntityId === PARTY_IDS.entityIds.party,
    );
    assert.deepEqual(
      queries
        .filter((query) => query.queryType === 'search')
        .map((query) => [
          query.queryId,
          query.tier,
          query.filterPlan !== undefined,
          inspectPredicateForExecution(query.filter).outcome,
        ]),
      [
        [q1Search, 'q1', true, 'accepted'],
        [unexecutedSearch, 'q0', false, 'rejected'],
      ],
    );
    assert.deepEqual(
      queries
        .filter((query) => query.queryType === 'get')
        .map((query) => query.tier),
      ['q0'],
    );

    await withRealPartyRuntime(
      'verification-q1-search',
      async (runtime) => {
        // The Q1 search reads through the real gateway: it returns a party
        // by its name. The Q0 search is answered without a read.
        const partyId = randomUUID();
        const created = await invokePartyOperation(
          runtime,
          runtime.views.a,
          'party_create',
          {
            recordId: partyId,
            values: {
              [PARTY_IDS.fieldIds.contactSummary]: 'q1@example.test',
              [PARTY_IDS.fieldIds.name]: 'Quarry Rentals',
              [PARTY_IDS.fieldIds.number]: 'P-Q1',
            },
          },
        );
        assert.equal(created.outcome, 'succeeded');
        const found = await invokePartyQuery(
          runtime,
          runtime.views.a,
          'party_search',
          { text: 'QUARRY' },
        );
        assert.ok(
          found.records.some((record) => record.recordId === partyId),
          `the Q1 search did not return the party: ${found.outcome}`,
        );
        const unexecuted = await invokePartyQuery(
          runtime,
          runtime.views.a,
          'party_z_search',
          { text: 'QUARRY' },
        );
        assert.deepEqual(
          [unexecuted.outcome, unexecuted.unsupportedReason],
          ['unsupported', 'query-filter-unsupported'],
        );

        // Activation's full release verification succeeded, executing every
        // scenario, the party's search-exclusion probe included.
        const plan = releaseVerificationBinding(runtime.compiled).plan;
        assert.ok(
          plan.scenarios.some(
            (scenario) =>
              scenario.kind === 'searchableExclusion' &&
              scenario.entityId === PARTY_IDS.entityIds.party,
          ),
          'the plan probes the party search',
        );
        const executedIn = await admittedEvidence(runtime);
        assert.equal(executedIn.execution_scope, 'FULL', 'nothing was derived');
        assert.deepEqual(
          executedIn.scenarioIds,
          plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
          'release verification executed every scenario',
        );
      },
      definition,
    );
  },
);

// A Q1 get whose filter is the literal `true` returns any live record by id:
// the gateway executes it through its compiled plan, and the plan restricts
// nothing. Party's only plain get, `party_get`, is such a get here (its id
// kept). The operation gateway reads a write back only through a Q0 get, so
// Party's operations read back through `party_read_back_get`, a Q0 copy of
// `party_get` with a read model, which verification never reads through.
const q1Get = `${PARTY_IDS.namespace}:query.party_get`;
const readModelGet = `${PARTY_IDS.namespace}:query.party_read_back_get`;

test(
  'release verification archives its probe records through a literal-true Q1 get when the entity has no plain Q0 get',
  { timeout: 300_000 },
  async () => {
    const definition = q1GetPartyDefinition();

    // The premise, compiled: Party's plain get is Q1 with a lowering plan and
    // a filter the gateway's fence accepts; its only Q0 get has a read model,
    // and every Party operation reads back through it.
    type Query = {
      filter: unknown;
      filterPlan?: unknown;
      queryId: string;
      queryType: string;
      readModel?: unknown;
      sourceEntityId: string;
      tier: string;
    };
    const compiled = compilePartyFixture(definition).compiled;
    assert.deepEqual(
      projectionPayload<{ queries: Query[] }>(
        compiled,
        PROJECTION_FAMILY_IDS.queryCatalog,
      )
        .queries.filter(
          (query) =>
            query.sourceEntityId === PARTY_IDS.entityIds.party &&
            query.queryType === 'get',
        )
        .map((query) => [
          query.queryId,
          query.tier,
          query.filterPlan !== undefined,
          inspectPredicateForExecution(query.filter).outcome,
          query.readModel !== undefined,
        ]),
      [
        [q1Get, 'q1', true, 'accepted', false],
        [readModelGet, 'q0', false, 'accepted', true],
      ],
    );
    assert.deepEqual(
      [
        ...new Set(
          projectionPayload<{
            operations: { operationId: string; readBackQueryId: string }[];
          }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog)
            .operations.filter((operation) =>
              /:operation\.party_(create|update|archive|restore)$/u.test(
                operation.operationId,
              ),
            )
            .map((operation) => operation.readBackQueryId),
        ),
      ],
      [readModelGet],
    );

    await withRealPartyRuntime(
      'verification-q1-get',
      async (runtime) => {
        const party = storageEntity(runtime.storage, PARTY_IDS.entityIds.party);
        const role = storageEntity(runtime.storage, PARTY_IDS.entityIds.role);

        // The Q1 get reads a live party by id through the real gateway.
        const partyId = randomUUID();
        const created = await invokePartyOperation(
          runtime,
          runtime.views.a,
          'party_create',
          {
            recordId: partyId,
            values: {
              [PARTY_IDS.fieldIds.contactSummary]: 'q1-get@example.test',
              [PARTY_IDS.fieldIds.name]: 'Quarry Freight',
              [PARTY_IDS.fieldIds.number]: 'P-Q1G',
            },
          },
        );
        assert.equal(created.outcome, 'succeeded');
        const read = await invokePartyQuery(
          runtime,
          runtime.views.a,
          'party_get',
          { recordId: partyId },
        );
        assert.deepEqual(
          [read.outcome, read.records.map((record) => record.recordId)],
          ['exact', [partyId]],
        );

        // Activation's release verification succeeded, executing every
        // scenario, and archived every record it arranged.
        const plan = releaseVerificationBinding(runtime.compiled).plan;
        const executedIn = await admittedEvidence(runtime);
        assert.equal(executedIn.execution_scope, 'FULL', 'nothing was derived');
        assert.deepEqual(
          executedIn.scenarioIds,
          plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
          'release verification executed every scenario',
        );
        for (const [entity, fieldId] of [
          [party, PARTY_IDS.fieldIds.name],
          [role, PARTY_IDS.fieldIds.roleKind],
        ] as const) {
          const records = await storedRecords(
            runtime,
            entity,
            executedIn.executed_tenant_id,
            executedIn.executed_environment_id,
            [fieldId],
          );
          assert.ok(
            records.length > 0,
            `verification arranged ${entity.entityId}`,
          );
          assert.deepEqual(
            records
              .filter((record) => !record.archived)
              .map((record) => record.recordId),
            [],
            `verification left no ${entity.entityId} record live`,
          );
        }
      },
      definition,
    );
  },
);

type StorageEntity = StorageTargetPayloadV1['entities'][number];

/** Every record of an entity in one tenant environment, with field values. */
async function storedRecords(
  runtime: RealPartyRuntime,
  entity: StorageEntity,
  tenantId: string,
  environmentId: string,
  fieldIds: readonly string[],
) {
  return (
    await runtime.adminPool.query<Record<string, unknown>>(
      `SELECT ${quoteFulfillmentIdentifier(entity.recordIdentity.column)}::text AS record_id,
              ${quoteFulfillmentIdentifier(entity.archive.archivedAtColumn)} IS NOT NULL AS archived,
              ${fieldIds
                .map(
                  (fieldId, index) =>
                    `${quoteFulfillmentIdentifier(storageColumn(entity, fieldId).physicalName)} AS value_${String(index)}`,
                )
                .join(', ')}
         FROM ${fulfillmentTable(entity)}
        WHERE tenant_id = $1 AND environment_id = $2
        ORDER BY 1`,
      [tenantId, environmentId],
    )
  ).rows.map((row) => ({
    archived: row.archived === true,
    recordId: String(row.record_id),
    values: Object.fromEntries(
      fieldIds.map((fieldId, index) => [
        fieldId,
        row[`value_${String(index)}`],
      ]),
    ),
  }));
}

/**
 * The evidence activation persisted where verification executed, with the
 * scenarios it executed.
 */
async function admittedEvidence(runtime: RealPartyRuntime) {
  const evidence = await runtime.adminPool.query<{
    execution_scope: string;
    executed_environment_id: string;
    executed_tenant_id: string;
    verification_evidence_id: string;
  }>(
    `SELECT verification_evidence_id, executed_tenant_id,
            executed_environment_id, execution_scope
       FROM platform.release_verification_evidence
      WHERE release_root = $1
        AND tenant_id = executed_tenant_id
        AND environment_id = executed_environment_id`,
    [runtime.compiled.releaseRoot],
  );
  assert.equal(evidence.rows.length, 1);
  const executedIn = evidence.rows[0]!;
  const executed = await runtime.adminPool.query<{ scenario_id: string }>(
    `SELECT scenario_id FROM platform.release_verification_results
      WHERE tenant_id = $1 AND environment_id = $2
        AND verification_evidence_id = $3
      ORDER BY scenario_id`,
    [
      executedIn.executed_tenant_id,
      executedIn.executed_environment_id,
      executedIn.verification_evidence_id,
    ],
  );
  return {
    ...executedIn,
    scenarioIds: executed.rows.map((row) => row.scenario_id),
  };
}

/** Tenant a's staged candidate, which verification can execute again. */
async function stagedInTenantA(runtime: RealPartyRuntime) {
  const staged = await runtime.adminPool.query<{
    release_id: MintedUuid;
    verification_evidence_id: MintedUuid;
  }>(
    `SELECT release_id, verification_evidence_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1 AND environment_id = $2 AND content_hash = $3`,
    [
      PARTY_TEST_SCOPE.a.tenantId,
      PARTY_TEST_SCOPE.a.environmentId,
      runtime.compiled.releaseRoot,
    ],
  );
  assert.equal(staged.rows.length, 1);
  return {
    compiledRelease: runtime.compiled,
    evidenceId: staged.rows[0]!.verification_evidence_id,
    releaseId: staged.rows[0]!.release_id,
  };
}

/**
 * Verification's interpreter, in sentinel mode, except that it answers one get
 * as it answers a get whose pinned contract it does not support (no
 * `infrastructure`): `unsupported`, with no record. It records every query it
 * runs; the gateway passes it only the queries the gateway executes.
 */
class UnsupportedGetExecutor
  implements SemanticOperationExecutor, SemanticQueryExecutor
{
  readonly queryIds = new Set<string>();
  readonly #interpreter: PostgresModuleRuntimeInterpreter;

  constructor(
    runtime: RealPartyRuntime,
    private readonly unsupportedQueryId: string,
  ) {
    this.#interpreter = new PostgresModuleRuntimeInterpreter(
      runtime.runtimePool,
      humanActorIssuer(),
      [],
      undefined,
      undefined,
      { documentNumbers: 'verificationSentinel' },
    );
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest | SemanticQueryExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope | SemanticQueryResultEnvelope> {
    if (!('arguments' in request)) return this.#interpreter.execute(request);
    this.queryIds.add(request.definition.queryId);
    if (request.definition.queryId !== this.unsupportedQueryId) {
      return this.#interpreter.execute(request);
    }
    const { infrastructure, ...definition } = request.definition;
    void infrastructure;
    return this.#interpreter.execute({ ...request, definition });
  }

  recordNonAccepted(request: SemanticOperationNonAcceptedRequest) {
    return this.#interpreter.recordNonAccepted(request);
  }
}

function storageEntity(
  storage: StorageTargetPayloadV1,
  entityId: string,
): StorageEntity {
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  assert.ok(entity, `the storage target has no ${entityId}`);
  return entity;
}

function storageColumn(entity: StorageEntity, fieldId: string) {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column, `${entity.entityId} has no column for ${fieldId}`);
  return column;
}

/**
 * Party's own definition, numbered three ways (see `partyNumber` above); with
 * `unexecutedGets`, also the gets the gateway does not run (see
 * `unexecutedAccountGet` above).
 */
function numberedPartyDefinition({
  unexecutedGets = false,
}: { readonly unexecutedGets?: boolean } = {}): Record<string, unknown> {
  type Json = Record<string, unknown>;
  type Query = Json & {
    queryId: string;
    resolveMatchKeys?: Json[];
    selections: Json[];
  };
  const ns = PARTY_IDS.namespace;
  const definition = structuredClone(partyModuleDefinition()) as Json & {
    fields: Json[];
    queries: Query[];
  };
  const numbering = (local: string, prefix: string) => ({
    kind: 'documentSequence',
    minimumDigits: 6,
    prefix,
    sequenceId: `${ns}:document_sequence.${local}`,
    start: 1,
  });
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const query = (local: string) =>
    definition.queries.find(
      (entry) => entry.queryId === `${ns}:query.${local}`,
    )!;
  const selection = (queryId: string, fieldId: string, ordinal: number) => ({
    field: reference('fieldReference', fieldId),
    kind: 'querySelection',
    orderKey: ordinal * 10,
    schemaVersion: 'v6',
    selectionId: `${queryId.replace(':query.', ':selection.')}_${String(ordinal)}`,
  });
  const number = definition.fields.find(
    (entry) => entry.fieldId === partyNumber,
  )!;
  number.numbering = numbering('party', 'PTY');
  definition.fields.push(
    {
      ...structuredClone(number),
      fieldId: accountNumber,
      label: 'Account number',
      numbering: numbering('party_account', 'ACC'),
      orderKey: 40,
      searchable: false,
    },
    {
      ...structuredClone(number),
      entity: reference('entityReference', PARTY_IDS.entityIds.role),
      fieldId: roleNumber,
      label: 'Role number',
      numbering: numbering('party_role', 'ROLE'),
      orderKey: 30,
    },
  );
  const accountGet = structuredClone(query('party_get'));
  accountGet.queryId = `${ns}:query.party_account_get`;
  accountGet.selections = [
    selection(accountGet.queryId, accountNumber, 1),
    selection(accountGet.queryId, PARTY_IDS.fieldIds.name, 2),
  ];
  definition.queries.push(accountGet);
  if (unexecutedGets) {
    const never = {
      kind: 'booleanPredicate',
      schemaVersion: 'v6',
      value: false,
    };
    const executedGet = structuredClone(query('party_get'));
    executedGet.queryId = executedAccountGet;
    executedGet.selections = [
      selection(executedGet.queryId, accountNumber, 1),
      selection(executedGet.queryId, PARTY_IDS.fieldIds.name, 2),
    ];
    accountGet.filter = never;
    const roleGet = structuredClone(query('party_role_get'));
    roleGet.queryId = unexecutedRoleGet;
    roleGet.filter = never;
    roleGet.selections = [selection(roleGet.queryId, roleNumber, 1)];
    definition.queries.push(executedGet, roleGet);
  }
  for (const local of [
    'party_role_list',
    'party_role_search',
    'party_role_resolve',
  ]) {
    const entry = query(local);
    entry.selections.push(
      selection(entry.queryId, roleNumber, entry.selections.length + 1),
    );
  }
  const resolve = query('party_role_resolve');
  resolve.resolveMatchKeys = [
    {
      authority: 'identifier',
      field: reference('fieldReference', roleNumber),
      kind: 'resolveMatchKey',
      matchKeyId: `${ns}:resolve-key.party_role_number`,
      orderKey: 10,
      schemaVersion: 'v6',
    },
    ...(resolve.resolveMatchKeys ?? []).map((key) => ({
      ...key,
      orderKey: Number(key.orderKey) + 10,
    })),
  ];
  return definition;
}

/**
 * Party's own definition with its search made Q1 (the literal `true` filter,
 * its id and selections kept) and a later Q0 copy filtered `false` with fresh
 * ids (see `q1Search` above).
 */
function q1SearchPartyDefinition(): Record<string, unknown> {
  type Json = Record<string, unknown>;
  type Query = Json & { queryId: string; selections: Json[] };
  const definition = structuredClone(partyModuleDefinition()) as Json & {
    queries: Query[];
  };
  const search = definition.queries.find(
    (entry) => entry.queryId === q1Search,
  )!;
  const unexecuted = structuredClone(search);
  unexecuted.queryId = unexecutedSearch;
  unexecuted.selections = unexecuted.selections.map((selection) => ({
    ...selection,
    selectionId: String(selection.selectionId).replace(
      '.party_search_',
      '.party_z_search_',
    ),
  }));
  unexecuted.filter = {
    kind: 'booleanPredicate',
    schemaVersion: 'v6',
    value: false,
  };
  search.tier = 'q1';
  definition.queries.push(unexecuted);
  return definition;
}

/**
 * Party's own definition with its plain get made Q1 (the literal `true`
 * filter, its id and selections kept) and Party's operations reading back
 * through a Q0 copy with a read model (see `q1Get` above).
 */
function q1GetPartyDefinition(): Record<string, unknown> {
  type Json = Record<string, unknown>;
  type Query = Json & { queryId: string; selections: Json[] };
  type Operation = Json & { effect: Json & { entity?: { targetId: string } } };
  const definition = structuredClone(partyModuleDefinition()) as Json & {
    operations: Operation[];
    queries: Query[];
  };
  const get = definition.queries.find((entry) => entry.queryId === q1Get)!;
  const readBack = structuredClone(get);
  readBack.queryId = readModelGet;
  readBack.selections = readBack.selections.map((selection) => ({
    ...selection,
    selectionId: String(selection.selectionId).replace(
      '.party_get_',
      '.party_read_back_get_',
    ),
  }));
  readBack.readModel = {
    binding: `${PARTY_IDS.namespace}:binding.party_read_back`,
    capability: {
      kind: 'capabilityReference',
      schemaVersion: 'v6',
      targetId: `${PARTY_IDS.namespace}:capability.standard_surface_content`,
    },
    queries: {},
    resultFields: {},
  };
  get.tier = 'q1';
  definition.queries.push(readBack);
  for (const operation of definition.operations) {
    if (operation.effect.entity?.targetId !== PARTY_IDS.entityIds.party) {
      continue;
    }
    operation.readBack = {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: readModelGet,
    };
  }
  return definition;
}

function humanActorIssuer(): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: { kind: 'HUMAN', principalId: context.principalId },
        initiatingHumanId: context.principalId,
        subject: null,
      };
    },
  });
}
