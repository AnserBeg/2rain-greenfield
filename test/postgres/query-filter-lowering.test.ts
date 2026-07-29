import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUERY_AGGREGATE_PROFILE_VERSION,
  evaluateQueryAggregateSemantics,
  inspectPredicateForExecution,
  type ParameterizedPredicateLoweringPlan,
  type PredicateExpression,
  type PredicateLoweringPlan,
  type QueryAggregateLoweringPlan,
  type QueryFilterLoweringPlan,
} from '../../packages/canonical-model/src/index.js';
import {
  PREDICATE_LOWERING_TABLE,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/index.js';
import {
  buildQueryFilterPredicate,
  PostgresModuleRuntimeInterpreter,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  MalformedSemanticQueryRequestError,
  MalformedQueryPolicyNarrowingError,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type QueryPolicyNarrowingGateway,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
} from '../../packages/runtime/src/request-runtime-view.js';
import type { Pool, PoolClient } from 'pg';

import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  PARTY_TEST_SCOPE,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';

const demonstrateMissingIndex =
  process.env.Q1P1_DEMONSTRATE_MISSING_INDEX === 'foldedEquality';
const demonstrateUnboundedScan =
  process.env.Q1P1_DEMONSTRATE_UNBOUNDED_SCAN === 'tenant';
const demonstrateRawTotalization =
  process.env.Q1P1_DEMONSTRATE_RAW_TOTALIZATION === '1';
const demonstrateMissingPolicy =
  process.env.Q1P1_DEMONSTRATE_MISSING_POLICY === '1';
const demonstrateMissingTenantRls =
  process.env.Q1P1_DEMONSTRATE_MISSING_TENANT_RLS === '1';
const demonstrateAggregateMissingArchive =
  process.env.Q1P3B_DEMONSTRATE_MISSING_ARCHIVE === '1';
const demonstrateAggregateMissingIndex =
  process.env.Q1P3B_DEMONSTRATE_MISSING_INDEX === '1';
const demonstrateAggregateMissingPolicy =
  process.env.Q1P3B_DEMONSTRATE_MISSING_POLICY === '1';

const differentialRows = [
  {
    contact: null,
    id: 'd1000000-0000-4000-8000-000000000001',
    name: 'Absent contact',
    number: 'Q1-DIFF-1',
  },
  {
    contact: 'Alpha',
    id: 'd1000000-0000-4000-8000-000000000002',
    name: 'Low contact',
    number: 'Q1-DIFF-2',
  },
  {
    contact: 'm',
    id: 'd1000000-0000-4000-8000-000000000003',
    name: 'Equal contact',
    number: 'Q1-DIFF-3',
  },
  {
    contact: 'zulu',
    id: 'd1000000-0000-4000-8000-000000000004',
    name: 'High contact',
    number: 'Q1-DIFF-4',
  },
] as const;

const aggregateIds = Object.freeze({
  amountField: `${PARTY_IDS.namespace}:field.q1_aggregate_amount`,
  atTimeParameter: `${PARTY_IDS.namespace}:parameter.q1_aggregate_at_time`,
  effectiveAtField: `${PARTY_IDS.namespace}:field.q1_aggregate_effective_at`,
  policyQuery: `${PARTY_IDS.namespace}:query.party_q1_aggregate_policy`,
  query: `${PARTY_IDS.namespace}:query.party_q1_aggregate_sum`,
  selection: `${PARTY_IDS.namespace}:selection.party_q1_aggregate_sum`,
  stockField: `${PARTY_IDS.namespace}:field.q1_aggregate_stock`,
  stockParameter: `${PARTY_IDS.namespace}:parameter.q1_aggregate_stock`,
});

test('q1 filters preserve total semantics, cost classes, policy narrowing, and provider conjunctions', async () => {
  const definition = q1PartyDefinition();
  await withRealPartyRuntime(
    'q1-p1-query-filter-lowering',
    async (runtime) => {
      const party = runtime.storage.entities.find(
        (entity) => entity.entityId === PARTY_IDS.entityIds.party,
      );
      assert.ok(party);
      const nameColumn = requiredColumn(party, PARTY_IDS.fieldIds.name);
      const contactColumn = requiredColumn(
        party,
        PARTY_IDS.fieldIds.contactSummary,
      );
      const nameFolded = party.foldedColumns.find(
        (column) => column.canonicalFieldId === PARTY_IDS.fieldIds.name,
      );
      assert.ok(nameFolded);
      const nameIndex = party.indexes.find(
        (index) =>
          index.indexKind === 'foldedAccess' &&
          index.columnNames.includes(nameFolded.physicalName),
      );
      assert.ok(nameIndex);
      const tenantScopeIndexNames = [
        ...party.uniqueKeys.map((unique) => unique.physicalName),
        ...party.indexes
          .filter((index) => index.indexKind === 'caseInsensitiveUnique')
          .map((index) => index.physicalName),
      ];
      assert.equal(
        tenantScopeIndexNames.length,
        2,
        'the business key must expose both physical uniqueness enforcers',
      );

      for (const row of differentialRows) {
        await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
          recordId: row.id,
          values: {
            ...(row.contact === null
              ? {}
              : { [PARTY_IDS.fieldIds.contactSummary]: row.contact }),
            [PARTY_IDS.fieldIds.name]: row.name,
            [PARTY_IDS.fieldIds.number]: row.number,
          },
        });
      }

      const queryCases = [
        'q1_equals',
        'q1_not_equals',
        'q1_less',
        'q1_greater',
        'q1_not_less',
        'q1_all',
        'q1_any',
        'q1_false',
        'q1_true',
      ] as const;
      for (const localId of queryCases) {
        const compiled = compiledQuery(runtime.views.a, localId);
        const actual = await invokePartyQuery(
          runtime,
          runtime.views.a,
          `party_${localId}`,
          { limit: 100 },
        );
        const expected = differentialRows
          .filter((row) => evaluate(compiled.filter, row.contact))
          .map((row) => row.id)
          .sort();
        assert.deepEqual(
          actual.records
            .map((record) => record.recordId)
            .filter((recordId) =>
              differentialRows.some((row) => row.id === recordId),
            )
            .sort(),
          expected,
          localId,
        );
      }

      const totalized = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_q1_not_less',
        { limit: 100 },
      );
      const rawIds = await rawNegatedLessThan(
        runtime.runtimePool,
        runtime.contexts.a,
        party,
        contactColumn.physicalName,
        'm',
      );
      const totalizedIds = totalized.records
        .map((record) => record.recordId)
        .filter((recordId) =>
          differentialRows.some((row) => row.id === recordId),
        )
        .sort();
      assert.equal(rawIds.includes(differentialRows[0].id), false);
      assert.equal(totalizedIds.includes(differentialRows[0].id), true);
      assert.notDeepEqual(rawIds, totalizedIds);
      if (demonstrateRawTotalization) {
        assert.deepEqual(rawIds, totalizedIds);
      }

      await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
        recordId: 'd1000000-0000-4000-8000-000000000005',
        values: {
          [PARTY_IDS.fieldIds.contactSummary]: 'zulu',
          [PARTY_IDS.fieldIds.name]: 'Index Probe',
          [PARTY_IDS.fieldIds.number]: 'Q1-INDEX-1',
        },
      });
      const indexedResult = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_q1_indexed',
        { limit: 100 },
      );
      assert.deepEqual(
        indexedResult.records.map((record) => record.recordId),
        ['d1000000-0000-4000-8000-000000000005'],
      );
      await insertPlannerRows(
        runtime.adminPool,
        party,
        nameColumn.physicalName,
        contactColumn.physicalName,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(party.physicalTableName)}`,
      );

      const observedProbeIds = new Set<string>();
      const indexedPlan = compiledQuery(
        runtime.views.a,
        'q1_indexed',
      ).filterPlan;
      assert.ok(indexedPlan);
      if (demonstrateMissingIndex) {
        await runtime.adminPool.query(
          `DROP INDEX north_star_module.${quoted(nameIndex.physicalName)}`,
        );
        await runtime.adminPool.query(
          `ANALYZE north_star_module.${quoted(party.physicalTableName)}`,
        );
      }
      const indexedEvidence = await explainPlans(
        runtime.runtimePool,
        runtime.adminPool,
        runtime.contexts.a,
        party,
        [indexedPlan],
        [nameIndex.physicalName],
      );
      assert.equal(indexedEvidence.indexDeltas.get(nameIndex.physicalName), 1n);
      assert.equal(indexedEvidence.plan.rowsRemoved, 0);
      assert.ok(indexedEvidence.plan.indexNames.has(nameIndex.physicalName));
      observedProbeIds.add('Q1-P1/indexed-folded-equality');

      const boundedPlan = compiledQuery(runtime.views.a, 'q1_scan').filterPlan;
      assert.ok(boundedPlan);
      const boundedEvidence = await explainPlans(
        runtime.runtimePool,
        runtime.adminPool,
        runtime.contexts.a,
        party,
        [boundedPlan],
        tenantScopeIndexNames,
        demonstrateUnboundedScan,
      );
      const usedTenantScopeIndexes = tenantScopeIndexNames.filter(
        (indexName) =>
          boundedEvidence.plan.indexNames.has(indexName) &&
          boundedEvidence.indexDeltas.get(indexName) === 1n,
      );
      console.log(
        `Q1-P1 tenant probe candidates=${tenantScopeIndexNames.join(',')} observed=${[...boundedEvidence.plan.indexNames].join(',')} sequential=${String(boundedEvidence.plan.sequentialScan)} removed=${String(boundedEvidence.plan.rowsRemoved)} deltas=${tenantScopeIndexNames.map((indexName) => `${indexName}:${String(boundedEvidence.indexDeltas.get(indexName))}`).join(',')}`,
      );
      assert.equal(
        usedTenantScopeIndexes.length,
        1,
        'exactly one physical business-key index must execute as the tenant bound',
      );
      assert.deepEqual(
        [...boundedEvidence.plan.indexNames],
        usedTenantScopeIndexes,
      );
      for (const indexName of tenantScopeIndexNames) {
        assert.equal(
          boundedEvidence.indexDeltas.get(indexName),
          usedTenantScopeIndexes.includes(indexName) ? 1n : 0n,
        );
      }
      assert.equal(boundedEvidence.plan.sequentialScan, false);
      assert.ok(boundedEvidence.plan.rowsRemoved > 0);
      observedProbeIds.add('Q1-P1/tenant-bounded-scan');
      assert.deepEqual(
        [...observedProbeIds].sort(),
        PREDICATE_LOWERING_TABLE.filter((row) =>
          row.providerProbeId.startsWith('Q1-P1/'),
        )
          .map((row) => row.providerProbeId)
          .sort(),
      );

      const policyAllowed = 'e1000000-0000-4000-8000-000000000001';
      const policyBlocked = 'e1000000-0000-4000-8000-000000000002';
      const archived = 'e1000000-0000-4000-8000-000000000003';
      const otherTenant = 'e1000000-0000-4000-8000-000000000004';
      const otherEnvironment = 'e1000000-0000-4000-8000-000000000005';
      for (const [view, recordId, number, name, contact] of [
        [
          runtime.views.a,
          policyAllowed,
          'Q1-POLICY-1',
          'Policy Needle',
          'allowed',
        ],
        [
          runtime.views.a,
          policyBlocked,
          'Q1-POLICY-2',
          'Policy Needle',
          'blocked',
        ],
        [
          runtime.views.a,
          archived,
          'Q1-ARCHIVE-1',
          'Mandatory Needle',
          'allowed',
        ],
        [
          runtime.views.b,
          otherTenant,
          'Q1-TENANT-1',
          'Mandatory Needle',
          'allowed',
        ],
      ] as const) {
        await invokePartyOperation(runtime, view, 'party_create', {
          recordId,
          values: {
            [PARTY_IDS.fieldIds.contactSummary]: contact,
            [PARTY_IDS.fieldIds.name]: name,
            [PARTY_IDS.fieldIds.number]: number,
          },
        });
      }
      await insertCrossEnvironmentRow(
        runtime.adminPool,
        party,
        nameColumn.physicalName,
        contactColumn.physicalName,
        otherEnvironment,
      );
      await invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
        expectedRevision: 1,
        recordId: archived,
      });
      if (demonstrateMissingTenantRls) {
        await runtime.adminPool.query(
          `ALTER TABLE north_star_module.${quoted(party.physicalTableName)} DISABLE ROW LEVEL SECURITY`,
        );
      }

      const mandatoryDefault = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_q1_mandatory',
        { limit: 100 },
      );
      assert.deepEqual(mandatoryDefault.records, []);
      const mandatoryExplicit = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_q1_mandatory',
        { includeArchived: true, limit: 100 },
      );
      assert.deepEqual(
        mandatoryExplicit.records.map((record) => record.recordId),
        [archived],
      );

      const base = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_q1_policy_base',
        { limit: 100 },
      );
      assert.deepEqual(
        base.records.map((record) => record.recordId).sort(),
        [policyAllowed, policyBlocked].sort(),
      );
      const contribution = compiledQuery(
        runtime.views.a,
        'q1_policy_contribution',
      );
      const policyGateway: QueryPolicyNarrowingGateway = {
        async narrow() {
          return {
            filter: contribution.filter,
            filterPlan: contribution.filterPlan,
          };
        },
      };
      assert.ok(contribution.filterPlan);
      assert.equal(
        contribution.filterPlan.root.kind,
        'fieldComparisonPredicate',
      );
      if (contribution.filterPlan.root.kind !== 'fieldComparisonPredicate') {
        assert.fail('policy contribution must compile to a comparison');
      }
      const mismatchedPlan: PredicateLoweringPlan = {
        ...contribution.filterPlan,
        root: {
          ...contribution.filterPlan.root,
          value: {
            kind: 'textValue',
            schemaVersion: contribution.filterPlan.root.value.schemaVersion,
            value: 'blocked',
          },
        },
      };
      let malformedExecutorCount = 0;
      const malformedGateway = new SemanticQueryGateway(
        new AllowPolicy(),
        {
          async execute() {
            malformedExecutorCount += 1;
            throw new Error('malformed policy plan reached the provider');
          },
        },
        undefined,
        {
          async narrow() {
            return {
              filter: contribution.filter,
              filterPlan: mismatchedPlan,
            };
          },
        },
      );
      await assert.rejects(
        () =>
          malformedGateway.invoke(runtime.views.a, {
            arguments: { limit: 100 },
            queryId: `${PARTY_IDS.namespace}:query.party_q1_policy_base`,
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          }),
        (error: unknown) => error instanceof MalformedQueryPolicyNarrowingError,
      );
      assert.equal(malformedExecutorCount, 0);
      const narrowedGateway = new SemanticQueryGateway(
        new AllowPolicy(),
        new PostgresModuleRuntimeInterpreter(
          runtime.runtimePool,
          actorIssuer(),
        ),
        undefined,
        demonstrateMissingPolicy ? undefined : policyGateway,
      );
      const narrowed = await narrowedGateway.invoke(runtime.views.a, {
        arguments: { limit: 100 },
        queryId: `${PARTY_IDS.namespace}:query.party_q1_policy_base`,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      });
      assert.deepEqual(
        narrowed.records.map((record) => record.recordId),
        [policyAllowed],
      );
      const basePlan = compiledQuery(
        runtime.views.a,
        'q1_policy_base',
      ).filterPlan;
      assert.ok(basePlan);
      assert.ok(contribution.filterPlan);
      const policyEvidence = await explainPlans(
        runtime.runtimePool,
        runtime.adminPool,
        runtime.contexts.a,
        party,
        [basePlan, contribution.filterPlan],
        [nameIndex.physicalName],
      );
      assert.ok(policyEvidence.plan.indexNames.has(nameIndex.physicalName));
      assert.equal(policyEvidence.plan.rowsRemoved, 1);

      console.log(
        `Q1-P1 provider probes: indexed=${nameIndex.physicalName} delta=${String(indexedEvidence.indexDeltas.get(nameIndex.physicalName))} removed=${String(indexedEvidence.plan.rowsRemoved)} tenant=${usedTenantScopeIndexes[0]} delta=1 removed=${String(boundedEvidence.plan.rowsRemoved)} policy_removed=${String(policyEvidence.plan.rowsRemoved)} raw_absent=${String(rawIds.includes(differentialRows[0].id))} total_absent=${String(totalizedIds.includes(differentialRows[0].id))}`,
      );
    },
    definition,
  );
});

test('q1 required sum executes through the real gateway with typed parameters and provider-owned narrowing', async () => {
  const definition = q1AggregatePartyDefinition();
  await withRealPartyRuntime(
    'q1-p3b-required-sum-lowering',
    async (runtime) => {
      const party = runtime.storage.entities.find(
        (entity) => entity.entityId === PARTY_IDS.entityIds.party,
      );
      assert.ok(party);
      const amountColumn = requiredColumn(party, aggregateIds.amountField);
      const effectiveAtColumn = requiredColumn(
        party,
        aggregateIds.effectiveAtField,
      );
      const stockColumn = requiredColumn(party, aggregateIds.stockField);
      const stockFolded = party.foldedColumns.find(
        (column) => column.canonicalFieldId === aggregateIds.stockField,
      );
      assert.ok(stockFolded);
      const stockIndex = party.indexes.find(
        (index) =>
          index.indexKind === 'foldedAccess' &&
          index.columnNames.includes(stockFolded.physicalName),
      );
      assert.ok(stockIndex);
      const rls = await runtime.adminPool.query<{
        forced: boolean;
        policy_commands: string[];
      }>(
        `SELECT c.relforcerowsecurity AS forced,
                array_agg(p.cmd ORDER BY p.cmd) AS policy_commands
           FROM pg_catalog.pg_class AS c
           JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
           LEFT JOIN pg_catalog.pg_policies AS p
             ON p.schemaname = n.nspname AND p.tablename = c.relname
          WHERE n.nspname = 'north_star_module' AND c.relname = $1
          GROUP BY c.relforcerowsecurity`,
        [party.physicalTableName],
      );
      assert.deepEqual(rls.rows, [
        {
          forced: true,
          policy_commands: [
            ...runtime.storage.rlsGrantTemplate.policyCommands,
          ].sort(),
        },
      ]);

      const arguments_ = {
        [aggregateIds.atTimeParameter]: '2026-06-01T00:00:00.000Z',
        [aggregateIds.stockParameter]: 'STOCK-A',
      };
      const empty = await runtime.queryGateway.invokeAggregate(
        runtime.views.b,
        {
          arguments: arguments_,
          queryId: aggregateIds.query,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        },
      );
      assertAggregateValue(empty, '0');

      const activeAllowed = [
        ['a3000000-0000-4000-8000-000000000001', '-0.25'],
        ['a3000000-0000-4000-8000-000000000002', '1.000001'],
        ['a3000000-0000-4000-8000-000000000003', '0.000001'],
      ] as const;
      const policyBlocked = 'a3000000-0000-4000-8000-000000000004';
      const archived = 'a3000000-0000-4000-8000-000000000005';
      const later = 'a3000000-0000-4000-8000-000000000006';
      const otherStock = 'a3000000-0000-4000-8000-000000000007';
      for (const [recordId, amount] of activeAllowed) {
        await createAggregateParty(runtime, runtime.views.a, {
          amount,
          contact: 'allowed',
          effectiveAt: '2026-01-01T00:00:00.000Z',
          recordId,
          stock: 'STOCK-A',
        });
      }
      await createAggregateParty(runtime, runtime.views.a, {
        amount: '10',
        contact: 'blocked',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        recordId: policyBlocked,
        stock: 'STOCK-A',
      });
      await createAggregateParty(runtime, runtime.views.a, {
        amount: '100',
        contact: 'allowed',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        recordId: archived,
        stock: 'STOCK-A',
      });
      await createAggregateParty(runtime, runtime.views.a, {
        amount: '1000',
        contact: 'allowed',
        effectiveAt: '2027-01-01T00:00:00.000Z',
        recordId: later,
        stock: 'STOCK-A',
      });
      await createAggregateParty(runtime, runtime.views.a, {
        amount: '2000',
        contact: 'allowed',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        recordId: otherStock,
        stock: 'STOCK-B',
      });
      await invokePartyOperation(runtime, runtime.views.a, 'party_archive', {
        expectedRevision: 1,
        recordId: archived,
      });
      await createAggregateParty(runtime, runtime.views.b, {
        amount: '4000',
        contact: 'allowed',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        recordId: 'a3000000-0000-4000-8000-000000000008',
        stock: 'STOCK-A',
      });
      await insertAggregateCrossEnvironmentRow(runtime.adminPool, party, {
        amountColumn: amountColumn.physicalName,
        effectiveAtColumn: effectiveAtColumn.physicalName,
        recordId: 'a3000000-0000-4000-8000-000000000009',
        stockColumn: stockColumn.physicalName,
      });
      await insertAggregatePlannerRows(runtime.adminPool, party, {
        amountColumn: amountColumn.physicalName,
        effectiveAtColumn: effectiveAtColumn.physicalName,
        stockColumn: stockColumn.physicalName,
      });
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(party.physicalTableName)}`,
      );

      const compiled = compiledAggregateQuery(
        runtime.views.a,
        aggregateIds.query,
      );
      const policy = compiledAggregateQuery(
        runtime.views.a,
        aggregateIds.policyQuery,
      );
      const policyGateway: QueryPolicyNarrowingGateway = {
        async narrow() {
          return { filter: policy.filter, filterPlan: policy.filterPlan };
        },
      };
      let malformedExecutorCount = 0;
      const malformedGateway = new SemanticQueryGateway(new AllowPolicy(), {
        async execute() {
          throw new Error('record executor must not receive an aggregate');
        },
        async executeAggregate() {
          malformedExecutorCount += 1;
          throw new Error('malformed parameter reached the provider');
        },
      });
      await assert.rejects(
        () =>
          malformedGateway.invokeAggregate(runtime.views.a, {
            arguments: {
              ...arguments_,
              [aggregateIds.atTimeParameter]: false,
            },
            queryId: aggregateIds.query,
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          }),
        (error: unknown) => error instanceof MalformedSemanticQueryRequestError,
      );
      assert.equal(malformedExecutorCount, 0);

      const base = await runtime.queryGateway.invokeAggregate(runtime.views.a, {
        arguments: arguments_,
        queryId: aggregateIds.query,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      });
      assertAggregateValue(base, '10.750002');
      const narrowedGateway = new SemanticQueryGateway(
        new AllowPolicy(),
        new PostgresModuleRuntimeInterpreter(
          runtime.runtimePool,
          actorIssuer(),
        ),
        undefined,
        demonstrateAggregateMissingPolicy ? undefined : policyGateway,
      );

      if (demonstrateAggregateMissingIndex) {
        await runtime.adminPool.query(
          `DROP INDEX north_star_module.${quoted(stockIndex.physicalName)}`,
        );
        await runtime.adminPool.query(
          `ANALYZE north_star_module.${quoted(party.physicalTableName)}`,
        );
      }
      await runtime.runtimePool.query('SELECT pg_stat_force_next_flush()');
      const before = await readIndexCounters(runtime.adminPool, [
        stockIndex.physicalName,
      ]);
      const narrowed = await narrowedGateway.invokeAggregate(runtime.views.a, {
        arguments: arguments_,
        queryId: aggregateIds.query,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      });
      await runtime.runtimePool.query('SELECT pg_stat_force_next_flush()');
      const after = await readIndexCounters(runtime.adminPool, [
        stockIndex.physicalName,
      ]);
      const indexDelta =
        (after.get(stockIndex.physicalName) ?? 0n) -
        (before.get(stockIndex.physicalName) ?? 0n);
      assert.equal(indexDelta, 1n);

      const ir = evaluateQueryAggregateSemantics({
        elements: activeAllowed.map(([, value]) => ({
          presence: 'present',
          value,
        })),
        field: {
          fieldId: aggregateIds.amountField,
          kind: 'exactDecimalFieldType',
          precision: 20,
          presence: 'required',
          scale: 6,
        },
        operator: 'sum',
        profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
      });
      assert.equal(ir.outcome, 'evaluated');
      assertAggregateValue(
        narrowed,
        ir.outcome === 'evaluated' ? ir.result.value : 'unreachable',
      );

      const policyEvidence = await explainAggregatePlans(
        runtime.runtimePool,
        runtime.contexts.a,
        party,
        amountColumn.physicalName,
        [compiled.filterPlan, policy.filterPlan],
        arguments_,
      );
      assert.ok(policyEvidence.indexNames.has(stockIndex.physicalName));
      assert.ok(policyEvidence.rowsRemoved > 0);
      const archivedIncluded = await aggregateWithoutArchivePredicate(
        runtime.runtimePool,
        runtime.contexts.a,
        party,
        amountColumn.physicalName,
        [compiled.filterPlan, policy.filterPlan],
        arguments_,
      );
      assert.equal(archivedIncluded, '100.750002');
      assert.notEqual(archivedIncluded, aggregateValue(narrowed));
      if (demonstrateAggregateMissingArchive) {
        assert.equal(archivedIncluded, aggregateValue(narrowed));
      }

      const observedProbeIds = new Set([
        compiled.aggregatePlan.providerProbeId,
        'Q1-P3b/parameterized-comparison-tenant-bounded-scan',
      ]);
      assert.deepEqual(
        [...observedProbeIds].sort(),
        PREDICATE_LOWERING_TABLE.filter((row) =>
          row.providerProbeId.startsWith('Q1-P3b/'),
        )
          .map((row) => row.providerProbeId)
          .sort(),
      );
      console.log(
        `Q1-P3b aggregate probe index=${stockIndex.physicalName} delta=${String(indexDelta)} rows_removed=${String(policyEvidence.rowsRemoved)} empty=0 base=${aggregateValue(base)} policy=${aggregateValue(narrowed)} archive_removed=${archivedIncluded} signed_subunit=-0.25 boundary_scale=0.000001 tenant_other=4000 environment_other=8000 forced_rls=true`,
      );
    },
    definition,
  );
});

function q1AggregatePartyDefinition(): Record<string, unknown> {
  const definition = structuredClone(partyModuleDefinition()) as {
    fields: Array<Record<string, unknown>>;
    languageVersion: string;
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const schemaVersion = definition.languageVersion;
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion,
    targetId,
  });
  const fieldBase = (input: {
    fieldId: string;
    fieldType: Record<string, unknown>;
    label: string;
    orderKey: number;
    searchable: boolean;
  }) => ({
    classification: 'internal',
    collation:
      input.fieldType.kind === 'textFieldType'
        ? 'unicodeCaseInsensitive'
        : 'binary',
    defaultSemantics: 'none',
    entity: reference('entityReference', PARTY_IDS.entityIds.party),
    fieldId: input.fieldId,
    fieldType: { ...input.fieldType, schemaVersion },
    kind: 'fieldDefinition',
    label: input.label,
    orderKey: input.orderKey,
    presence: 'required',
    reportable: true,
    schemaVersion,
    searchable: input.searchable,
  });
  definition.fields.push(
    fieldBase({
      fieldId: aggregateIds.stockField,
      fieldType: { kind: 'textFieldType', maximumLength: 80 },
      label: 'Aggregate stock identity',
      orderKey: 40,
      searchable: true,
    }),
    fieldBase({
      fieldId: aggregateIds.effectiveAtField,
      fieldType: {
        kind: 'dateTimeFieldType',
        precision: 'millisecond',
        timezoneSemantics: 'utcInstant',
      },
      label: 'Aggregate effective at',
      orderKey: 50,
      searchable: false,
    }),
    fieldBase({
      fieldId: aggregateIds.amountField,
      fieldType: {
        kind: 'exactDecimalFieldType',
        precision: 20,
        representation: 'canonicalString',
        scale: 6,
      },
      label: 'Aggregate amount',
      orderKey: 60,
      searchable: false,
    }),
  );
  const contact = definition.fields.find(
    (field) => field.fieldId === PARTY_IDS.fieldIds.contactSummary,
  );
  assert.ok(contact);
  contact.collation = 'binary';
  const aggregateSelection = (selectionId: string) => ({
    field: reference('fieldReference', aggregateIds.amountField),
    kind: 'queryAggregateSelection',
    operator: 'sum',
    schemaVersion,
    selectionId,
  });
  const common = {
    kind: 'queryDefinition',
    maximumResultCount: 1,
    module: reference('moduleReference', PARTY_IDS.moduleId),
    permission: reference(
      'permissionReference',
      `${PARTY_IDS.namespace}:permission.party_read`,
    ),
    queryType: 'aggregate',
    schemaVersion,
    sourceEntity: reference('entityReference', PARTY_IDS.entityIds.party),
    tier: 'q1',
  };
  definition.queries.push(
    {
      ...common,
      aggregate: aggregateSelection(aggregateIds.selection),
      filter: {
        kind: 'allPredicate',
        schemaVersion,
        terms: [
          {
            field: reference('fieldReference', aggregateIds.stockField),
            kind: 'fieldComparisonPredicate',
            operator: 'equals',
            schemaVersion,
            value: {
              kind: 'queryParameterReference',
              parameterId: aggregateIds.stockParameter,
              schemaVersion,
            },
          },
          {
            field: reference('fieldReference', aggregateIds.effectiveAtField),
            kind: 'fieldComparisonPredicate',
            operator: 'lessThanOrEqual',
            schemaVersion,
            value: {
              kind: 'queryParameterReference',
              parameterId: aggregateIds.atTimeParameter,
              schemaVersion,
            },
          },
          {
            field: reference('fieldReference', aggregateIds.amountField),
            kind: 'fieldComparisonPredicate',
            operator: 'greaterThanOrEqual',
            schemaVersion,
            value: {
              kind: 'exactDecimalValue',
              schemaVersion,
              value: '-0.25',
            },
          },
        ],
      },
      parameters: [
        {
          kind: 'queryParameterDefinition',
          orderKey: 10,
          parameterId: aggregateIds.stockParameter,
          schemaVersion,
        },
        {
          kind: 'queryParameterDefinition',
          orderKey: 20,
          parameterId: aggregateIds.atTimeParameter,
          schemaVersion,
        },
      ],
      queryId: aggregateIds.query,
    },
    {
      ...common,
      aggregate: aggregateSelection(
        `${PARTY_IDS.namespace}:selection.party_q1_aggregate_policy`,
      ),
      filter: {
        field: reference('fieldReference', PARTY_IDS.fieldIds.contactSummary),
        kind: 'fieldComparisonPredicate',
        operator: 'equals',
        schemaVersion,
        value: { kind: 'textValue', schemaVersion, value: 'allowed' },
      },
      parameters: [],
      queryId: aggregateIds.policyQuery,
    },
  );
  return definition;
}

interface CompiledAggregateQuery {
  readonly aggregatePlan: QueryAggregateLoweringPlan;
  readonly filter: Readonly<Record<string, ImmutableJsonValue>>;
  readonly filterPlan: ParameterizedPredicateLoweringPlan;
}

function compiledAggregateQuery(
  view: Parameters<typeof invokePartyQuery>[1],
  queryId: string,
): CompiledAggregateQuery {
  const payload = view.projections.query.payload;
  assert.ok(isRecord(payload));
  assert.ok(Array.isArray(payload.queries));
  const query = payload.queries.find(
    (candidate) => isRecord(candidate) && candidate.queryId === queryId,
  );
  assert.ok(isRecord(query));
  assert.ok(isRecord(query.aggregatePlan));
  assert.ok(isRecord(query.filter));
  assert.ok(isRecord(query.filterPlan));
  return query as unknown as CompiledAggregateQuery;
}

async function createAggregateParty(
  runtime: Parameters<typeof invokePartyOperation>[0],
  view: Parameters<typeof invokePartyOperation>[1],
  input: {
    amount: string;
    contact: string;
    effectiveAt: string;
    recordId: string;
    stock: string;
  },
): Promise<void> {
  await invokePartyOperation(runtime, view, 'party_create', {
    recordId: input.recordId,
    values: {
      [aggregateIds.amountField]: input.amount,
      [aggregateIds.effectiveAtField]: input.effectiveAt,
      [aggregateIds.stockField]: input.stock,
      [PARTY_IDS.fieldIds.contactSummary]: input.contact,
      [PARTY_IDS.fieldIds.name]: `Aggregate ${input.recordId.slice(-4)}`,
      [PARTY_IDS.fieldIds.number]: `Q1-AGG-${input.recordId.slice(-12)}`,
    },
  });
}

function aggregateValue(result: {
  readonly value: { readonly value: string };
}): string {
  return result.value.value;
}

function assertAggregateValue(
  result: { readonly value: { readonly value: string } },
  expected: string,
): void {
  assert.equal(aggregateValue(result), expected);
}

function q1PartyDefinition(): Record<string, unknown> {
  const definition = structuredClone(partyModuleDefinition()) as {
    fields: Array<Record<string, unknown>>;
    languageVersion: string;
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const schemaVersion = definition.languageVersion;
  const compare = (
    operator: 'equals' | 'greaterThan' | 'lessThan' | 'notEquals',
    value: string,
    fieldId: string = PARTY_IDS.fieldIds.contactSummary,
  ) => comparison(operator, value, fieldId, schemaVersion);
  const contactField = definition.fields.find(
    (field) => field.fieldId === PARTY_IDS.fieldIds.contactSummary,
  );
  assert.ok(contactField);
  contactField.collation = 'binary';
  const template = definition.queries.find(
    (query) => query.queryId === `${PARTY_IDS.namespace}:query.party_list`,
  );
  assert.ok(template);
  const filters: Readonly<Record<string, unknown>> = {
    q1_all: {
      kind: 'allPredicate',
      schemaVersion,
      terms: [compare('greaterThan', 'a'), compare('lessThan', 'z')],
    },
    q1_any: {
      kind: 'anyPredicate',
      schemaVersion,
      terms: [compare('equals', 'alpha'), compare('equals', 'zulu')],
    },
    q1_equals: compare('equals', 'm'),
    q1_false: { kind: 'booleanPredicate', schemaVersion, value: false },
    q1_greater: compare('greaterThan', 'm'),
    q1_indexed: compare('equals', 'index probe', PARTY_IDS.fieldIds.name),
    q1_less: compare('lessThan', 'm'),
    q1_mandatory: compare(
      'equals',
      'Mandatory Needle',
      PARTY_IDS.fieldIds.name,
    ),
    q1_not_equals: compare('notEquals', 'm'),
    q1_not_less: {
      kind: 'notPredicate',
      schemaVersion,
      term: compare('lessThan', 'm'),
    },
    q1_policy_base: compare('equals', 'Policy Needle', PARTY_IDS.fieldIds.name),
    q1_policy_contribution: compare('equals', 'allowed'),
    q1_scan: compare('notEquals', 'alpha'),
    q1_true: { kind: 'booleanPredicate', schemaVersion, value: true },
  };
  for (const [localId, filter] of Object.entries(filters)) {
    const query = structuredClone(template);
    query.queryId = `${PARTY_IDS.namespace}:query.party_${localId}`;
    query.tier = 'q1';
    query.filter = filter;
    query.selections = (query.selections as Array<Record<string, unknown>>).map(
      (selection, index) => ({
        ...selection,
        selectionId: `${PARTY_IDS.namespace}:selection.party_${localId}_${String(index + 1)}`,
      }),
    );
    definition.queries.push(query);
  }
  return definition;
}

function comparison(
  operator: 'equals' | 'greaterThan' | 'lessThan' | 'notEquals',
  value: string,
  fieldId: string,
  schemaVersion: string,
): Record<string, unknown> {
  return {
    field: { kind: 'fieldReference', schemaVersion, targetId: fieldId },
    kind: 'fieldComparisonPredicate',
    operator,
    schemaVersion,
    value: { kind: 'textValue', schemaVersion, value },
  };
}

interface CompiledQuery {
  readonly filter: PredicateExpression;
  readonly filterPlan: PredicateLoweringPlan;
}

function compiledQuery(
  view: Parameters<typeof invokePartyQuery>[1],
  localId: string,
): CompiledQuery {
  const payload = view.projections.query.payload;
  assert.ok(isRecord(payload));
  assert.ok(Array.isArray(payload.queries));
  const query = payload.queries.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.queryId === `${PARTY_IDS.namespace}:query.party_${localId}`,
  );
  assert.ok(isRecord(query));
  assert.ok(isRecord(query.filter));
  assert.ok(isRecord(query.filterPlan));
  return query as unknown as CompiledQuery;
}

function evaluate(
  predicate: PredicateExpression,
  contact: string | null,
): boolean {
  const receipt = inspectPredicateForExecution(predicate, {
    bindingPosition: 'queryFilter',
    resolveComparison(comparison_) {
      if (contact === null) return { presence: 'absent' };
      assert.equal(comparison_.value.kind, 'textValue');
      const left = contact;
      const right = comparison_.value.value;
      const result = {
        equals: left === right,
        greaterThan: left > right,
        lessThan: left < right,
        notEquals: left !== right,
      }[comparison_.operator];
      return { presence: 'present', result };
    },
  });
  assert.equal(receipt.outcome, 'evaluated');
  return receipt.outcome === 'evaluated' && receipt.result;
}

async function insertPlannerRows(
  pool: Pool,
  entity: Parameters<typeof requiredColumn>[0],
  nameColumn: string,
  contactColumn: string,
): Promise<void> {
  const numberColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.number,
  ).physicalName;
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (tenant_id, environment_id, record_id, revision,
        ${quoted(numberColumn)}, ${quoted(nameColumn)}, ${quoted(contactColumn)})
     SELECT $1::uuid,
            $2::uuid,
            ('f1000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
            1,
            'Q1-BULK-' || lpad(row_number::text, 5, '0'),
            'Planner row ' || lpad(row_number::text, 5, '0'),
            CASE WHEN row_number % 2 = 0 THEN 'alpha' ELSE 'zulu' END
       FROM generate_series(1, 10000) AS row_number`,
    [PARTY_TEST_SCOPE.a.tenantId, PARTY_TEST_SCOPE.a.environmentId],
  );
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (tenant_id, environment_id, record_id, revision,
        ${quoted(numberColumn)}, ${quoted(nameColumn)}, ${quoted(contactColumn)})
     SELECT ('f2000000-0000-4000-8000-' || lpad(((row_number - 1) % 90 + 1)::text, 12, '0'))::uuid,
            $1::uuid,
            ('f3000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
            1,
            'Q1-OTHER-' || lpad(row_number::text, 5, '0'),
            'Other tenant row ' || lpad(row_number::text, 5, '0'),
            'other'
       FROM generate_series(1, 30000) AS row_number`,
    [PARTY_TEST_SCOPE.a.environmentId],
  );
}

async function insertCrossEnvironmentRow(
  pool: Pool,
  entity: Parameters<typeof requiredColumn>[0],
  nameColumn: string,
  contactColumn: string,
  recordId: string,
): Promise<void> {
  const numberColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.number,
  ).physicalName;
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (tenant_id, environment_id, record_id, revision,
        ${quoted(numberColumn)}, ${quoted(nameColumn)}, ${quoted(contactColumn)})
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'Q1-ENV-1', 'Mandatory Needle', 'allowed')`,
    [PARTY_TEST_SCOPE.a.tenantId, PARTY_TEST_SCOPE.b.environmentId, recordId],
  );
}

async function insertAggregateCrossEnvironmentRow(
  pool: Pool,
  entity: Parameters<typeof requiredColumn>[0],
  columns: {
    amountColumn: string;
    effectiveAtColumn: string;
    recordId: string;
    stockColumn: string;
  },
): Promise<void> {
  const contactColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.contactSummary,
  ).physicalName;
  const nameColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.name,
  ).physicalName;
  const numberColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.number,
  ).physicalName;
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (tenant_id, environment_id, record_id, revision,
        ${quoted(numberColumn)}, ${quoted(nameColumn)}, ${quoted(contactColumn)},
        ${quoted(columns.stockColumn)}, ${quoted(columns.effectiveAtColumn)},
        ${quoted(columns.amountColumn)})
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1,
             'Q1-AGG-OTHER-ENV', 'Other environment aggregate', 'allowed',
             'STOCK-A', '2026-01-01T00:00:00.000Z'::timestamptz, 8000::numeric)`,
    [
      PARTY_TEST_SCOPE.a.tenantId,
      PARTY_TEST_SCOPE.b.environmentId,
      columns.recordId,
    ],
  );
}

async function insertAggregatePlannerRows(
  pool: Pool,
  entity: Parameters<typeof requiredColumn>[0],
  columns: {
    amountColumn: string;
    effectiveAtColumn: string;
    stockColumn: string;
  },
): Promise<void> {
  const contactColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.contactSummary,
  ).physicalName;
  const nameColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.name,
  ).physicalName;
  const numberColumn = requiredColumn(
    entity,
    PARTY_IDS.fieldIds.number,
  ).physicalName;
  await pool.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)}
       (tenant_id, environment_id, record_id, revision,
        ${quoted(numberColumn)}, ${quoted(nameColumn)}, ${quoted(contactColumn)},
        ${quoted(columns.stockColumn)}, ${quoted(columns.effectiveAtColumn)},
        ${quoted(columns.amountColumn)})
     SELECT $1::uuid,
            $2::uuid,
            ('b3000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
            1,
            'Q1-AGG-BULK-' || lpad(row_number::text, 5, '0'),
            'Aggregate planner row ' || lpad(row_number::text, 5, '0'),
            'allowed',
            'OTHER-STOCK-' || lpad(row_number::text, 5, '0'),
            '2026-01-01T00:00:00.000Z'::timestamptz,
            1::numeric
       FROM generate_series(1, 10000) AS row_number`,
    [PARTY_TEST_SCOPE.a.tenantId, PARTY_TEST_SCOPE.a.environmentId],
  );
}

async function explainAggregatePlans(
  pool: Pool,
  context: Parameters<typeof withTrustedRequestTransaction>[1],
  entity: Parameters<typeof requiredColumn>[0],
  amountColumn: string,
  plans: readonly QueryFilterLoweringPlan[],
  parameterValues: Readonly<Record<string, ImmutableJsonValue>>,
): Promise<ReturnType<typeof inspectPlan>> {
  const alias = 'q1_aggregate_source';
  const predicate = buildQueryFilterPredicate(
    entity,
    plans,
    alias,
    parameterValues,
  );
  const root = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
        return explain(
          client,
          `SELECT COALESCE(SUM(${qualified(alias, amountColumn)}), 0)::numeric(38,6)::text
             FROM north_star_module.${quoted(entity.physicalTableName)} AS ${quoted(alias)}
            WHERE ${qualified(alias, entity.archive.archivedAtColumn)} IS NULL
              AND ${predicate.sql}`,
          predicate.values,
        );
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  return inspectPlan(root);
}

async function aggregateWithoutArchivePredicate(
  pool: Pool,
  context: Parameters<typeof withTrustedRequestTransaction>[1],
  entity: Parameters<typeof requiredColumn>[0],
  amountColumn: string,
  plans: readonly QueryFilterLoweringPlan[],
  parameterValues: Readonly<Record<string, ImmutableJsonValue>>,
): Promise<string> {
  const predicate = buildQueryFilterPredicate(
    entity,
    plans,
    undefined,
    parameterValues,
  );
  return withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    try {
      const result = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(${quoted(amountColumn)}), 0)::numeric(38,6)::text AS total
           FROM north_star_module.${quoted(entity.physicalTableName)}
          WHERE ${predicate.sql}`,
        [...predicate.values],
      );
      assert.equal(result.rowCount, 1);
      return canonicalExactDecimal(result.rows[0]!.total);
    } finally {
      await client.query('RESET ROLE');
    }
  });
}

function canonicalExactDecimal(value: string): string {
  const trimmed = value.includes('.')
    ? value.replace(/0+$/u, '').replace(/\.$/u, '')
    : value;
  return trimmed === '-0' ? '0' : trimmed;
}

interface PlanNode {
  readonly 'Index Name'?: unknown;
  readonly 'Node Type'?: unknown;
  readonly Plans?: unknown;
  readonly 'Rows Removed by Filter'?: unknown;
  readonly [key: string]: unknown;
}

async function explainPlans(
  runtimePool: Pool,
  adminPool: Pool,
  context: Parameters<typeof withTrustedRequestTransaction>[1],
  entity: Parameters<typeof requiredColumn>[0],
  plans: readonly PredicateLoweringPlan[],
  expectedIndexes: readonly string[],
  perturb = false,
): Promise<{
  indexDeltas: ReadonlyMap<string, bigint>;
  plan: ReturnType<typeof inspectPlan>;
}> {
  const predicate = buildQueryFilterPredicate(entity, plans, 'q1_source');
  await runtimePool.query('SELECT pg_stat_force_next_flush()');
  const before = await readIndexCounters(adminPool, expectedIndexes);
  const root = await withTrustedRequestTransaction(
    runtimePool,
    context,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
        if (perturb) {
          await client.query('SET LOCAL enable_indexscan = off');
          await client.query('SET LOCAL enable_bitmapscan = off');
        }
        const explained = await explain(
          client,
          `SELECT ${qualified('q1_source', entity.recordIdentity.column)}
             FROM north_star_module.${quoted(entity.physicalTableName)} AS ${quoted('q1_source')}
            WHERE ${qualified('q1_source', entity.archive.archivedAtColumn)} IS NULL
              AND ${predicate.sql}`,
          predicate.values,
        );
        await client.query('SELECT pg_stat_force_next_flush()');
        return explained;
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  const after = await readIndexCounters(adminPool, expectedIndexes);
  return {
    indexDeltas: new Map(
      expectedIndexes.map((name) => [
        name,
        (after.get(name) ?? 0n) - (before.get(name) ?? 0n),
      ]),
    ),
    plan: inspectPlan(root),
  };
}

async function rawNegatedLessThan(
  pool: Pool,
  context: Parameters<typeof withTrustedRequestTransaction>[1],
  entity: Parameters<typeof requiredColumn>[0],
  physicalColumn: string,
  value: string,
): Promise<string[]> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    try {
      const result = await client.query<{ record_id: string }>(
        `SELECT ${quoted(entity.recordIdentity.column)} AS record_id
           FROM north_star_module.${quoted(entity.physicalTableName)}
          WHERE ${quoted(entity.archive.archivedAtColumn)} IS NULL
            AND NOT (
              north_star_module.nsm_unicode_case_fold_v1(${quoted(physicalColumn)}::text) COLLATE "C"
              < north_star_module.nsm_unicode_case_fold_v1($1::text) COLLATE "C"
            )
          ORDER BY ${quoted(entity.recordIdentity.column)}`,
        [value],
      );
      return result.rows
        .map((row) => row.record_id)
        .filter((recordId) =>
          differentialRows.some((row) => row.id === recordId),
        );
    } finally {
      await client.query('RESET ROLE');
    }
  });
}

async function explain(
  client: PoolClient,
  statement: string,
  values: readonly unknown[],
): Promise<PlanNode> {
  const result = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    [...values],
  );
  const envelope = result.rows[0]?.['QUERY PLAN'];
  assert.ok(Array.isArray(envelope));
  assert.equal(envelope.length, 1);
  const root = envelope[0];
  assert.ok(isRecord(root));
  assert.ok(isRecord(root.Plan));
  return root.Plan;
}

function inspectPlan(root: PlanNode): {
  indexNames: Set<string>;
  rowsRemoved: number;
  sequentialScan: boolean;
} {
  const indexNames = new Set<string>();
  let rowsRemoved = 0;
  let sequentialScan = false;
  const recognized = new Set([
    'Aggregate',
    'BitmapAnd',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'BitmapOr',
    'Index Only Scan',
    'Index Scan',
    'Result',
    'Seq Scan',
  ]);
  const visit = (node: PlanNode): void => {
    assert.equal(typeof node['Node Type'], 'string');
    assert.ok(
      recognized.has(String(node['Node Type'])),
      `unrecognized executed plan node ${String(node['Node Type'])}`,
    );
    if (node['Node Type'] === 'Seq Scan') sequentialScan = true;
    if (node['Index Name'] !== undefined) {
      assert.equal(typeof node['Index Name'], 'string');
      indexNames.add(String(node['Index Name']));
    }
    if (node['Rows Removed by Filter'] !== undefined) {
      assert.equal(typeof node['Rows Removed by Filter'], 'number');
      rowsRemoved += Number(node['Rows Removed by Filter']);
    }
    if (node.Plans !== undefined) {
      assert.ok(Array.isArray(node.Plans));
      for (const child of node.Plans) {
        assert.ok(isRecord(child));
        visit(child);
      }
    }
  };
  visit(root);
  return { indexNames, rowsRemoved, sequentialScan };
}

async function readIndexCounters(
  pool: Pool,
  names: readonly string[],
): Promise<ReadonlyMap<string, bigint>> {
  const result = await pool.query<{ index_name: string; scan_count: string }>(
    `SELECT indexrelname AS index_name, idx_scan::text AS scan_count
       FROM pg_stat_user_indexes
      WHERE schemaname = 'north_star_module'
        AND indexrelname = ANY($1::text[])`,
    [names],
  );
  return new Map(
    result.rows.map((row) => [row.index_name, BigInt(row.scan_count)]),
  );
}

class AllowPolicy implements CurrentPolicyGateway {
  async authorize() {
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'q1-p1-policy/v1',
    };
  }

  async readCurrentVersion() {
    return { policyVersion: 'q1-p1-policy/v1' };
  }
}

function actorIssuer(): TrustedActorEnvelopeIssuer {
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

function requiredColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  fieldId: string,
) {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column;
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(alias: string, column: string): string {
  return `${quoted(alias)}.${quoted(column)}`;
}

function isRecord(
  value: unknown,
): value is Record<string, ImmutableJsonValue | unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
