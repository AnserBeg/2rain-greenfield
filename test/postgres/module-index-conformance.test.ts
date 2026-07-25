import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool, PoolClient } from 'pg';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { buildFoldedMatchPredicate } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  PARTY_TEST_SCOPE,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';

const plannerMilestones = [10, 100, 500, 1_000, 5_000, 10_000] as const;
const targetRow = 7;
const demonstrateMissingIndex = process.env.PR6_DEMONSTRATE_MISSING_INDEX;
const demonstrateMissingFoldedIndex =
  process.env.PR6B_DEMONSTRATE_MISSING_INDEX;

if (
  demonstrateMissingIndex !== undefined &&
  demonstrateMissingIndex !== 'relation'
) {
  throw new Error(
    `unsupported PR6_DEMONSTRATE_MISSING_INDEX value: ${demonstrateMissingIndex}`,
  );
}
if (
  demonstrateMissingFoldedIndex !== undefined &&
  demonstrateMissingFoldedIndex !== 'resolve'
) {
  throw new Error(
    `unsupported PR6B_DEMONSTRATE_MISSING_INDEX value: ${demonstrateMissingFoldedIndex}`,
  );
}

test('EXPLAIN plan guard rejects sequential and wrong-index scans structurally', () => {
  assert.throws(
    () =>
      assertRelationIndexPlan(
        { 'Node Type': 'Seq Scan', 'Relation Name': 'child' },
        'expected_relation_index',
      ),
    /relation predicate used a sequential scan/,
  );
  assert.throws(
    () =>
      assertRelationIndexPlan(
        { 'Index Name': 'unrelated_primary_key', 'Node Type': 'Index Scan' },
        'expected_relation_index',
      ),
    /did not use expected relation index expected_relation_index; used unrelated_primary_key/,
  );
  assert.throws(
    () => inspectPlan({ 'Node Type': 'Future Scan' }),
    /unrecognized EXPLAIN node type: Future Scan/,
  );
  assert.throws(
    () =>
      assertFoldedIndexPlan(
        {
          'Index Cond': '(tenant_id = trusted_tenant_id())',
          'Index Name': 'expected_folded_index',
          'Node Type': 'Index Scan',
        },
        'resolve',
        [
          {
            foldedColumnName: 'expected_folded_column',
            indexNames: ['expected_folded_index'],
          },
        ],
      ),
    /resolve predicate index condition omitted folded column expected_folded_column/,
  );
  assert.throws(
    () =>
      assertFoldedIndexPlan(
        {
          'Index Cond': "(tenant_id = 'expected_folded_column')",
          'Index Name': 'expected_folded_index',
          'Node Type': 'Index Scan',
        },
        'resolve',
        [
          {
            foldedColumnName: 'expected_folded_column',
            indexNames: ['expected_folded_index'],
          },
        ],
      ),
    /resolve predicate index condition omitted folded column expected_folded_column/,
  );
  assert.throws(
    () =>
      assertFoldedIndexPlan(
        {
          'Index Cond': '(expected_folded_column = $1)',
          'Index Name': 'expected_folded_index',
          'Node Type': 'Index Scan',
          'Rows Removed by Filter': 3,
        },
        'resolve',
        [
          {
            foldedColumnName: 'expected_folded_column',
            indexNames: ['expected_folded_index'],
          },
        ],
      ),
    /resolve predicate removed 3 rows by post-filter on expected_folded_index/,
  );
  assert.throws(
    () =>
      inspectPlan({
        'Index Cond': 42,
        'Index Name': 'expected_folded_index',
        'Node Type': 'Index Scan',
      }),
    /unrecognized EXPLAIN index condition: 42/,
  );
  assert.throws(
    () =>
      inspectPlan({
        'Index Cond': '(expected_folded_column = $1)',
        'Index Name': 'expected_folded_index',
        'Node Type': 'Index Scan',
        'Rows Removed by Filter': '3',
      }),
    /unrecognized EXPLAIN rows removed by filter: 3/,
  );
});

test('forced-RLS relation, resolve, and unique predicates use their declared indexes', async () => {
  await withRealPartyRuntime('module-index-conformance', async (runtime) => {
    const targets = requiredTargets(runtime.storage);
    let priorRowCount = 0;
    const plannerFlipRows: Record<
      'relation' | 'resolve' | 'unique',
      number | null
    > = {
      relation: null,
      resolve: null,
      unique: null,
    };

    for (const rowCount of plannerMilestones) {
      await seedRows(runtime.adminPool, targets, priorRowCount + 1, rowCount);
      priorRowCount = rowCount;
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.party.physicalTableName)}`,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.role.physicalTableName)}`,
      );
      const milestonePlans = {
        relation: planUsesIndex(
          await explainRelationPredicate(runtime, targets),
          [targets.relationIndex.physicalName],
        ),
        resolve: planUsesFoldedIndexes(
          await explainFoldedPredicate(runtime, targets, 'resolve'),
          foldedIndexRequirements(targets, 'resolve'),
        ),
        unique: planUsesFoldedIndexes(
          await explainFoldedPredicate(runtime, targets, 'unique'),
          foldedIndexRequirements(targets, 'unique'),
        ),
      };
      for (const predicate of Object.keys(
        milestonePlans,
      ) as (keyof typeof milestonePlans)[]) {
        if (milestonePlans[predicate]) {
          plannerFlipRows[predicate] ??= rowCount;
        } else if (plannerFlipRows[predicate] !== null) {
          assert.fail(
            `${predicate} predicate stopped using its declared index at ${rowCount} analyzed rows after first using it at ${String(plannerFlipRows[predicate])}`,
          );
        }
      }
    }

    for (const [predicate, rowCount] of Object.entries(plannerFlipRows)) {
      assert.notEqual(
        rowCount,
        null,
        `${predicate} predicate did not use its declared index by ${priorRowCount} analyzed rows`,
      );
      console.log(
        `PR-6b ${predicate} planner flip rows=${String(rowCount)}; analyzed rows=${priorRowCount}`,
      );
    }

    if (demonstrateMissingIndex === 'relation') {
      await runtime.adminPool.query(
        `DROP INDEX north_star_module.${quoted(targets.relationIndex.physicalName)}`,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.role.physicalTableName)}`,
      );
    }
    if (demonstrateMissingFoldedIndex === 'resolve') {
      await runtime.adminPool.query(
        `DROP INDEX north_star_module.${quoted(targets.nameFoldedIndex.physicalName)}`,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.party.physicalTableName)}`,
      );
    }

    assertRelationIndexPlan(
      await explainRelationPredicate(runtime, targets),
      targets.relationIndex.physicalName,
    );
    assertFoldedIndexPlan(
      await explainFoldedPredicate(runtime, targets, 'resolve'),
      'resolve',
      foldedIndexRequirements(targets, 'resolve'),
    );
    assertFoldedIndexPlan(
      await explainFoldedPredicate(runtime, targets, 'unique'),
      'unique',
      foldedIndexRequirements(targets, 'unique'),
    );
    await assertGeneratedFoldCatalog(runtime.adminPool, targets);
  });
});

interface PlanNode {
  readonly 'Index Cond'?: unknown;
  readonly 'Index Name'?: unknown;
  readonly 'Node Type'?: unknown;
  readonly Plans?: unknown;
  readonly 'Rows Removed by Filter'?: unknown;
  readonly [key: string]: unknown;
}

interface FoldedIndexRequirement {
  readonly foldedColumnName: string;
  readonly indexNames: readonly string[];
}

interface RelationTargets {
  readonly nameFoldedColumn: StorageTargetPayloadV1['entities'][number]['foldedColumns'][number];
  readonly nameFoldedIndex: StorageTargetPayloadV1['entities'][number]['indexes'][number];
  readonly nameColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly numberFoldedColumn: StorageTargetPayloadV1['entities'][number]['foldedColumns'][number];
  readonly numberColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly numberUniqueIndexNames: readonly string[];
  readonly party: StorageTargetPayloadV1['entities'][number];
  readonly relation: StorageTargetPayloadV1['relations'][number];
  readonly relationIndex: StorageTargetPayloadV1['entities'][number]['indexes'][number];
  readonly role: StorageTargetPayloadV1['entities'][number];
  readonly roleKindColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly roleStatusColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
}

function requiredTargets(storage: StorageTargetPayloadV1): RelationTargets {
  const party = requiredEntity(storage, PARTY_IDS.entityIds.party);
  const role = requiredEntity(storage, PARTY_IDS.entityIds.role);
  const relation = storage.relations.find(
    (candidate) => candidate.relationId === PARTY_IDS.relationIds.roleParty,
  );
  assert.ok(relation);
  const relationIndex = role.indexes.find(
    (candidate) =>
      candidate.indexKind === 'relation' &&
      candidate.columnNames.includes(relation.relationColumn.physicalName),
  );
  assert.ok(relationIndex);
  const nameFoldedColumn = requiredFoldedColumn(party, PARTY_IDS.fieldIds.name);
  const numberFoldedColumn = requiredFoldedColumn(
    party,
    PARTY_IDS.fieldIds.number,
  );
  const nameFoldedIndex = party.indexes.find(
    (candidate) =>
      candidate.indexKind === 'foldedAccess' &&
      candidate.columnNames.includes(nameFoldedColumn.physicalName),
  );
  assert.ok(nameFoldedIndex);
  const unique = party.uniqueKeys.find((candidate) =>
    candidate.columns.includes(numberFoldedColumn.sourceColumn),
  );
  assert.ok(unique);
  const numberUniqueIndexes = party.indexes.filter(
    (candidate) =>
      candidate.indexKind === 'caseInsensitiveUnique' &&
      candidate.columnNames.includes(numberFoldedColumn.sourceColumn),
  );
  assert.equal(numberUniqueIndexes.length, 1);
  return {
    nameFoldedColumn,
    nameFoldedIndex,
    nameColumn: requiredColumn(party, PARTY_IDS.fieldIds.name),
    numberFoldedColumn,
    numberColumn: requiredColumn(party, PARTY_IDS.fieldIds.number),
    numberUniqueIndexNames: [
      unique.physicalName,
      ...numberUniqueIndexes.map((index) => index.physicalName),
    ],
    party,
    relation,
    relationIndex,
    role,
    roleKindColumn: requiredColumn(role, PARTY_IDS.fieldIds.roleKind),
    roleStatusColumn: requiredColumn(role, PARTY_IDS.fieldIds.roleStatus),
  };
}

function foldedIndexRequirements(
  targets: RelationTargets,
  predicate: 'resolve' | 'unique',
): readonly FoldedIndexRequirement[] {
  const name = {
    foldedColumnName: targets.nameFoldedColumn.physicalName,
    indexNames: [targets.nameFoldedIndex.physicalName],
  };
  const number = {
    foldedColumnName: targets.numberFoldedColumn.physicalName,
    indexNames: targets.numberUniqueIndexNames,
  };
  return predicate === 'resolve' ? [name] : [number];
}

function requiredFoldedColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  fieldId: string,
): StorageTargetPayloadV1['entities'][number]['foldedColumns'][number] {
  const column = entity.foldedColumns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column;
}

function requiredEntity(
  storage: StorageTargetPayloadV1,
  entityId: string,
): StorageTargetPayloadV1['entities'][number] {
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  assert.ok(entity);
  return entity;
}

function requiredColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  fieldId: string,
): StorageTargetPayloadV1['entities'][number]['columns'][number] {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column;
}

async function seedRows(
  pool: Pool,
  targets: RelationTargets,
  from: number,
  through: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO north_star_module.${quoted(targets.party.physicalTableName)} (
         tenant_id, environment_id, record_id,
         ${quoted(targets.numberColumn.physicalName)},
         ${quoted(targets.nameColumn.physicalName)}
       )
       SELECT $1::uuid, $2::uuid,
              ('10000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
              'PARTY-' || lpad(row_number::text, 8, '0'),
              'Ordinary party ' || row_number::text
         FROM generate_series($3::integer, $4::integer) AS row_number`,
      [
        PARTY_TEST_SCOPE.a.tenantId,
        PARTY_TEST_SCOPE.a.environmentId,
        from,
        through,
      ],
    );
    await client.query(
      `INSERT INTO north_star_module.${quoted(targets.role.physicalTableName)} (
         tenant_id, environment_id, record_id,
         ${quoted(targets.roleKindColumn.physicalName)},
         ${quoted(targets.roleStatusColumn.physicalName)},
         ${quoted(targets.relation.relationColumn.physicalName)}
       )
       SELECT $1::uuid, $2::uuid,
              ('20000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
              $5::text, $6::text,
              ('10000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid
         FROM generate_series($3::integer, $4::integer) AS row_number`,
      [
        PARTY_TEST_SCOPE.a.tenantId,
        PARTY_TEST_SCOPE.a.environmentId,
        from,
        through,
        `${PARTY_IDS.namespace}:option.supplier`,
        `${PARTY_IDS.namespace}:option.active`,
      ],
    );
  } finally {
    client.release();
  }
}

async function explainRelationPredicate(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
): Promise<PlanNode> {
  return withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        return await explain(
          client,
          `SELECT 1
             FROM north_star_module.${quoted(targets.role.physicalTableName)}
            WHERE ${quoted(targets.relation.relationColumn.physicalName)} = $1
              AND ${quoted(targets.role.archive.archivedAtColumn)} IS NULL
            LIMIT 1`,
          [`10000000-0000-4000-8000-${String(targetRow).padStart(12, '0')}`],
        );
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
}

async function explainFoldedPredicate(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
  predicate: 'resolve' | 'unique',
): Promise<PlanNode> {
  const columns =
    predicate === 'unique' ? [targets.numberColumn] : [targets.nameColumn];
  const match = buildFoldedMatchPredicate(
    targets.party,
    columns,
    predicate === 'unique' ? 'PARTY-00000007' : 'Ordinary party 7',
    'exact',
  );
  // Mirror matchRecords/exactFoldedMatches: full selection, archive filter,
  // record-id ordering, runtime limit, and every selected searchable column.
  const values = [...match.values, 100];
  const selectedColumns = [
    targets.party.recordIdentity.column,
    targets.party.optimisticRevision.column,
    targets.party.archive.archivedAtColumn,
    ...targets.party.columns.map((column) => column.physicalName),
  ];
  return withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        return await explain(
          client,
          `SELECT ${selectedColumns.map(quoted).join(', ')}
             FROM north_star_module.${quoted(targets.party.physicalTableName)}
            WHERE ${match.sql}
              AND ${quoted(targets.party.archive.archivedAtColumn)} IS NULL
            ORDER BY ${quoted(targets.party.recordIdentity.column)}
            LIMIT $${String(values.length)}`,
          values,
        );
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
}

async function assertGeneratedFoldCatalog(
  pool: Pool,
  targets: RelationTargets,
): Promise<void> {
  for (const entity of [targets.party, targets.role]) {
    for (const foldedColumn of entity.foldedColumns) {
      const catalog = await pool.query<{
        collation_name: string;
        expression: string;
        generated_kind: string;
      }>(
        `SELECT attribute.attgenerated AS generated_kind,
                collation_record.collname AS collation_name,
                pg_get_expr(definition.adbin, definition.adrelid, true) AS expression
           FROM pg_attribute AS attribute
           JOIN pg_class AS relation ON relation.oid = attribute.attrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           JOIN pg_attrdef AS definition
             ON definition.adrelid = attribute.attrelid
            AND definition.adnum = attribute.attnum
           JOIN pg_collation AS collation_record
             ON collation_record.oid = attribute.attcollation
          WHERE namespace.nspname = 'north_star_module'
            AND relation.relname = $1
            AND attribute.attname = $2`,
        [entity.physicalTableName, foldedColumn.physicalName],
      );
      assert.equal(catalog.rows.length, 1);
      assert.equal(catalog.rows[0]?.generated_kind, 's');
      assert.equal(catalog.rows[0]?.collation_name, 'C');
      assert.match(
        catalog.rows[0]?.expression ?? '',
        new RegExp(`nsm_unicode_case_fold_v1\\(.*${foldedColumn.sourceColumn}`),
      );
      const drift = await pool.query<{ mismatches: string }>(
        `SELECT count(*)::text AS mismatches
           FROM north_star_module.${quoted(entity.physicalTableName)}
          WHERE ${quoted(foldedColumn.physicalName)} IS DISTINCT FROM
                north_star_module.nsm_unicode_case_fold_v1(${quoted(foldedColumn.sourceColumn)}::text)`,
      );
      assert.equal(drift.rows[0]?.mismatches, '0');
    }
  }
}

async function explain(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<PlanNode> {
  const result = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    [...values],
  );
  const envelope = result.rows[0]?.['QUERY PLAN'];
  if (!Array.isArray(envelope) || envelope.length !== 1) {
    throw new Error('unrecognized EXPLAIN JSON envelope');
  }
  const root = envelope[0];
  if (!isRecord(root) || !isRecord(root.Plan)) {
    throw new Error('unrecognized EXPLAIN JSON root');
  }
  return root.Plan;
}

const recognizedPlanNodeTypes = new Set([
  'BitmapAnd',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapOr',
  'Index Only Scan',
  'Index Scan',
  'Limit',
  'Seq Scan',
  'Sort',
]);

interface IndexObservation {
  readonly indexCondition: string | null;
  readonly indexName: string;
  readonly rowsRemovedByFilter: number;
}

function inspectPlan(root: PlanNode): {
  indexObservations: readonly IndexObservation[];
  indexNames: Set<string>;
  sequentialScan: boolean;
} {
  const indexObservations: IndexObservation[] = [];
  const indexNames = new Set<string>();
  let sequentialScan = false;
  const visit = (node: PlanNode): void => {
    const nodeType = node['Node Type'];
    if (
      typeof nodeType !== 'string' ||
      !recognizedPlanNodeTypes.has(nodeType)
    ) {
      throw new Error(`unrecognized EXPLAIN node type: ${String(nodeType)}`);
    }
    const rowsRemovedByFilter = node['Rows Removed by Filter'];
    if (
      rowsRemovedByFilter !== undefined &&
      (typeof rowsRemovedByFilter !== 'number' ||
        !Number.isFinite(rowsRemovedByFilter) ||
        rowsRemovedByFilter < 0)
    ) {
      throw new Error(
        `unrecognized EXPLAIN rows removed by filter: ${String(rowsRemovedByFilter)}`,
      );
    }
    if (nodeType === 'Seq Scan') sequentialScan = true;
    if (node['Index Name'] !== undefined) {
      if (typeof node['Index Name'] !== 'string') {
        throw new Error(
          `unrecognized EXPLAIN index name: ${String(node['Index Name'])}`,
        );
      }
      indexNames.add(node['Index Name']);
      let indexCondition: string | null = null;
      if (node['Index Cond'] !== undefined) {
        if (typeof node['Index Cond'] !== 'string') {
          throw new Error(
            `unrecognized EXPLAIN index condition: ${String(node['Index Cond'])}`,
          );
        }
        indexCondition = node['Index Cond'];
      }
      indexObservations.push({
        indexCondition,
        indexName: node['Index Name'],
        rowsRemovedByFilter: rowsRemovedByFilter ?? 0,
      });
    } else if (node['Index Cond'] !== undefined) {
      throw new Error('EXPLAIN index condition has no index name');
    }
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans) || !node.Plans.every(isRecord)) {
        throw new Error('unrecognized EXPLAIN child plan collection');
      }
      for (const child of node.Plans) visit(child);
    }
  };
  visit(root);
  return { indexNames, indexObservations, sequentialScan };
}

function planUsesIndex(
  root: PlanNode,
  expectedIndexNames: readonly string[],
): boolean {
  const plan = inspectPlan(root);
  return expectedIndexNames.some((name) => plan.indexNames.has(name));
}

function planUsesFoldedIndexes(
  root: PlanNode,
  requirements: readonly FoldedIndexRequirement[],
): boolean {
  const plan = inspectPlan(root);
  return requirements.every((requirement) =>
    plan.indexObservations.some(
      (observation) =>
        requirement.indexNames.includes(observation.indexName) &&
        observation.indexCondition !== null &&
        conditionUsesFoldedOperator(
          observation.indexCondition,
          requirement.foldedColumnName,
        ) &&
        observation.rowsRemovedByFilter === 0,
    ),
  );
}

function assertRelationIndexPlan(
  root: PlanNode,
  expectedIndexName: string,
): void {
  const plan = inspectPlan(root);
  assert.equal(
    plan.sequentialScan,
    false,
    'relation predicate used a sequential scan',
  );
  assert.ok(
    plan.indexNames.has(expectedIndexName),
    `relation predicate did not use expected relation index ${expectedIndexName}; used ${[...plan.indexNames].join(', ') || 'none'}`,
  );
}

function assertFoldedIndexPlan(
  root: PlanNode,
  predicate: 'resolve' | 'unique',
  requirements: readonly FoldedIndexRequirement[],
): void {
  const plan = inspectPlan(root);
  assert.equal(
    plan.sequentialScan,
    false,
    `${predicate} predicate used a sequential scan`,
  );
  for (const requirement of requirements) {
    const usedExpected = requirement.indexNames.filter((name) =>
      plan.indexNames.has(name),
    );
    assert.ok(
      usedExpected.length > 0,
      `${predicate} predicate did not use expected folded index ${requirement.indexNames.join(' or ')}; used ${[...plan.indexNames].join(', ') || 'none'}`,
    );
    const qualifying = plan.indexObservations.filter(
      (observation) =>
        usedExpected.includes(observation.indexName) &&
        observation.indexCondition !== null &&
        conditionUsesFoldedOperator(
          observation.indexCondition,
          requirement.foldedColumnName,
        ),
    );
    assert.ok(
      qualifying.length > 0,
      `${predicate} predicate index condition omitted folded column ${requirement.foldedColumnName}`,
    );
    for (const observation of qualifying) {
      assert.equal(
        observation.rowsRemovedByFilter,
        0,
        `${predicate} predicate removed ${String(observation.rowsRemovedByFilter)} rows by post-filter on ${observation.indexName}`,
      );
    }
  }
}

function conditionUsesFoldedOperator(
  condition: string,
  foldedColumnName: string,
): boolean {
  const escapedName = foldedColumnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^a-zA-Z0-9_'])"?${escapedName}"?\\s*(?:=|>=|<)`,
  ).test(condition);
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/);
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
