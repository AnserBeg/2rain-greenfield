import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  unicodeCaseFold,
} from '../../packages/canonical-model/src/index.js';
import type { Pool, PoolClient } from 'pg';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import {
  buildFoldedMatchPredicate,
  foldedPrefixUpperBound,
  ModuleRuntimeInterpreterError,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import type { TrustedRequestContext } from '../../packages/runtime/src/request-context.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  PARTY_TEST_SCOPE,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';

const plannerMilestones = [10, 100, 500, 1_000, 5_000, 10_000] as const;
const targetRow = 7;
const demonstrateMissingIndex = process.env.PR6_DEMONSTRATE_MISSING_INDEX;
const demonstrateMissingFoldedIndex =
  process.env.PR6B_DEMONSTRATE_MISSING_INDEX;
const demonstrateMissingPrefixIndex =
  process.env.PR6D_DEMONSTRATE_MISSING_PREFIX_INDEX;
const demonstrateFoldConformance =
  process.env.PR6B_DEMONSTRATE_FOLD_CONFORMANCE;

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
if (
  demonstrateMissingPrefixIndex !== undefined &&
  demonstrateMissingPrefixIndex !== 'prefix'
) {
  throw new Error(
    `unsupported PR6D_DEMONSTRATE_MISSING_PREFIX_INDEX value: ${demonstrateMissingPrefixIndex}`,
  );
}
if (
  demonstrateFoldConformance !== undefined &&
  !['row-drift', 'subject-absent', 'zero-visible-rows'].includes(
    demonstrateFoldConformance,
  )
) {
  throw new Error(
    `unsupported PR6B_DEMONSTRATE_FOLD_CONFORMANCE value: ${demonstrateFoldConformance}`,
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
      assertFoldedIndexEvidence(
        {
          indexScanDeltas: new Map([['expected_folded_index', 1n]]),
          root: {
            'Node Type': 'Bitmap Heap Scan',
            Plans: [
              {
                'Index Name': 'expected_folded_index',
                'Node Type': 'Bitmap Index Scan',
              },
            ],
            'Rows Removed by Filter': 3,
          },
        },
        'resolve',
        [{ indexNames: ['expected_folded_index'] }],
      ),
    /resolve predicate removed 3 rows by post-filter across the plan tree while expecting index expected_folded_index/,
  );
  assert.throws(
    () =>
      assertFoldedIndexEvidence(
        {
          indexScanDeltas: new Map([['expected_folded_index', 0n]]),
          root: { 'Node Type': 'Index Scan' },
        },
        'resolve',
        [{ indexNames: ['expected_folded_index'] }],
      ),
    /resolve predicate did not increment expected index usage counter expected_folded_index; deltas expected_folded_index=0/,
  );
  assert.throws(
    () =>
      assertFoldedIndexEvidence(
        {
          indexScanDeltas: new Map([
            ['expected_number_index', 1n],
            ['expected_name_index', 0n],
          ]),
          root: { 'Node Type': 'Index Scan' },
        },
        'prefix',
        [
          { indexNames: ['expected_number_index'] },
          { indexNames: ['expected_name_index'] },
        ],
      ),
    /prefix predicate did not increment expected index usage counter expected_name_index/,
  );
  assert.throws(
    () =>
      inspectPlan({
        'Index Name': 'expected_folded_index',
        'Node Type': 'Index Scan',
        'Rows Removed by Filter': '3',
      }),
    /unrecognized EXPLAIN rows removed by filter: 3/,
  );
  const substringTargets = {
    nameFoldedIndex: { physicalName: 'unexpected_name_folded' },
    numberUniqueIndexNames: ['expected_semantic', 'expected_case_folded'],
    party: { primaryKey: { physicalName: 'expected_primary' } },
  } as unknown as RelationTargets;
  assert.throws(
    () =>
      assertSubstringBoundedEvidence(
        {
          indexScanDeltas: new Map([['unrelated_index', 1n]]),
          root: {
            'Index Name': 'unrelated_index',
            'Node Type': 'Index Scan',
            'Rows Removed by Filter': 3,
          },
        },
        substringTargets,
      ),
    /did not use exactly one tenant-bounding index/,
  );
  assert.throws(
    () =>
      assertSubstringBoundedEvidence(
        {
          indexScanDeltas: new Map([
            ['expected_primary', 0n],
            ['expected_semantic', 0n],
            ['expected_case_folded', 0n],
          ]),
          root: {
            'Index Name': 'expected_case_folded',
            'Node Type': 'Index Scan',
            'Rows Removed by Filter': 3,
          },
        },
        substringTargets,
      ),
    /expected_case_folded incremented 0 times; expected 1/,
  );
  assert.throws(
    () =>
      assertSubstringBoundedEvidence(
        {
          indexScanDeltas: new Map([
            ['expected_semantic', 1n],
            ['expected_case_folded', 1n],
            ['expected_primary', 0n],
          ]),
          root: {
            'Index Name': 'expected_semantic',
            'Node Type': 'Index Scan',
            'Rows Removed by Filter': 3,
          },
        },
        substringTargets,
      ),
    /expected_case_folded incremented 1 times; expected 0/,
  );
  assert.throws(
    () =>
      assertSubstringBoundedEvidence(
        {
          indexScanDeltas: new Map([
            ['expected_primary', 1n],
            ['expected_semantic', 0n],
            ['expected_case_folded', 0n],
          ]),
          root: {
            'Index Name': 'expected_primary',
            'Node Type': 'Index Scan',
            'Rows Removed by Filter': 0,
          },
        },
        substringTargets,
      ),
    /did not observe its expected bounded post-filter/,
  );
  assert.equal(foldedPrefixUpperBound('\u{10ffff}'), null);
  assert.equal(foldedPrefixUpperBound(`a\u{10ffff}`), 'b');
  assert.equal(foldedPrefixUpperBound('\ud7ff'), '\ue000');
});

test('fold row conformance rejects absent subjects, zero-row evidence, and generated-value drift', () => {
  assert.throws(
    () => requireFoldSubjects([]),
    /fold row conformance observed zero folded columns/,
  );
  assert.throws(
    () =>
      assertFoldRowEvidence(
        { mismatches: '0', observedRows: '0' },
        'example.value_folded',
      ),
    /fold row conformance observed zero visible rows/,
  );
  assert.throws(
    () =>
      assertFoldRowEvidence(
        { mismatches: '1', observedRows: '1' },
        'example.value_folded',
      ),
    /fold row conformance observed generated-value drift/,
  );
});

test('literal search semantics preserve ordinary results across substring and prefix modes', async (context) => {
  await withRealPartyRuntime(
    'module-search-literal-semantics',
    async (runtime) => {
      const targets = requiredTargets(runtime.storage);
      const rows = [
        {
          id: '40000000-0000-4000-8000-000000000001',
          name: '50% literal',
          number: 'LITERAL-0001',
        },
        {
          id: '40000000-0000-4000-8000-000000000002',
          name: '500 wildcard',
          number: 'LITERAL-0002',
        },
        {
          id: '40000000-0000-4000-8000-000000000003',
          name: 'a_b literal',
          number: 'LITERAL-0003',
        },
        {
          id: '40000000-0000-4000-8000-000000000004',
          name: 'axb wildcard',
          number: 'LITERAL-0004',
        },
        {
          id: '40000000-0000-4000-8000-000000000005',
          name: 'bang!mark literal',
          number: 'LITERAL-0005',
        },
        {
          id: '40000000-0000-4000-8000-000000000006',
          name: 'bangmark wildcard',
          number: 'LITERAL-0006',
        },
        {
          id: '40000000-0000-4000-8000-000000000007',
          name: 'Ordinary Alpha',
          number: 'LITERAL-0007',
        },
        {
          id: '40000000-0000-4000-8000-000000000008',
          name: 'Ordinary Beta',
          number: 'LITERAL-0008',
        },
        {
          id: '40000000-0000-4000-8000-000000000009',
          name: 'Middle ordinary token',
          number: 'LITERAL-0009',
        },
        {
          id: '40000000-0000-4000-8000-000000000010',
          name: 'Straße Alpha',
          number: 'LITERAL-0010',
        },
        {
          id: '40000000-0000-4000-8000-000000000011',
          name: 'STRASSE Beta',
          number: 'LITERAL-0011',
        },
        {
          id: '40000000-0000-4000-8000-000000000012',
          name: '\ud7ff boundary',
          number: 'LITERAL-0012',
        },
        {
          id: '40000000-0000-4000-8000-000000000013',
          name: '\ue000 boundary',
          number: 'LITERAL-0013',
        },
        {
          id: '40000000-0000-4000-8000-000000000014',
          name: '\u{10ffff}',
          number: 'LITERAL-0014',
        },
        {
          id: '40000000-0000-4000-8000-000000000015',
          name: '\u{10ffff} tail',
          number: 'LITERAL-0015',
        },
        {
          id: '40000000-0000-4000-8000-000000000016',
          name: '\u{10fffe} neighbor',
          number: 'LITERAL-0016',
        },
        {
          id: '40000000-0000-4000-8000-000000000017',
          name: 'slash\\mark literal',
          number: 'LITERAL-0017',
        },
        {
          id: '40000000-0000-4000-8000-000000000018',
          name: 'slashmark wildcard',
          number: 'LITERAL-0018',
        },
      ] as const;
      await insertSearchRows(runtime.adminPool, targets, rows);
      const rowIds = new Set<string>(rows.map((row) => row.id));

      for (const [term, expectedId, legacyIds] of [
        ['50%', rows[0].id, [rows[0].id, rows[1].id]],
        ['a_b', rows[2].id, [rows[2].id, rows[3].id]],
        ['slash\\mark', rows[16].id, [rows[17].id]],
      ] as const) {
        await context.test(`${term} is not a wildcard`, async () => {
          assert.deepEqual(
            (await legacyUnescapedSubstring(runtime, targets, term))
              .map((record) => record.recordId)
              .filter((recordId) => rowIds.has(recordId)),
            legacyIds,
            `the pre-fix LIKE contract must demonstrate its wrong ${term} match`,
          );
          for (const matchMode of ['substring', 'prefix'] as const) {
            const result = await invokePartyQuery(
              runtime,
              runtime.views.a,
              'party_search',
              { matchMode, text: term },
            );
            assert.deepEqual(
              result.records
                .map((record) => record.recordId)
                .filter((recordId) => rowIds.has(recordId)),
              [expectedId],
              `${matchMode}:${term}`,
            );
          }
        });
      }

      await context.test('the escape character is literal', async () => {
        for (const matchMode of ['substring', 'prefix'] as const) {
          const result = await invokePartyQuery(
            runtime,
            runtime.views.a,
            'party_search',
            { matchMode, text: 'bang!mark' },
          );
          assert.deepEqual(
            result.records
              .map((record) => record.recordId)
              .filter((recordId) => rowIds.has(recordId)),
            [rows[4].id],
            matchMode,
          );
        }
      });

      await context.test(
        'C-collated bounds preserve pinned Unicode folding',
        async () => {
          for (const prefix of ['straße', '\ud7ff', '\u{10ffff}'] as const) {
            const expected = rows
              .filter((row) =>
                unicodeCaseFold(row.name).startsWith(unicodeCaseFold(prefix)),
              )
              .map((row) => row.id);
            const result = await invokePartyQuery(
              runtime,
              runtime.views.a,
              'party_search',
              { matchMode: 'prefix', text: prefix },
            );
            assert.deepEqual(
              result.records
                .map((record) => record.recordId)
                .filter((recordId) => rowIds.has(recordId)),
              expected,
              prefix,
            );
          }
        },
      );

      await context.test(
        'ordinary substring results are byte-identical',
        async () => {
          for (const term of ['ordinary', 'alpha', 'middle token'] as const) {
            const before = canonicalize(
              await legacyUnescapedSubstring(runtime, targets, term),
            );
            const after = canonicalize(
              (
                await invokePartyQuery(
                  runtime,
                  runtime.views.a,
                  'party_search',
                  { matchMode: 'substring', text: term },
                )
              ).records,
            );
            assert.equal(after, before, term);
          }
        },
      );

      await context.test(
        'a missing search term fails before lowering zero terms',
        async () => {
          await assert.rejects(
            invokePartyQuery(runtime, runtime.views.a, 'party_search', {}),
            (error: unknown) =>
              error instanceof ModuleRuntimeInterpreterError &&
              error.code === 'MODULE_INPUT_MALFORMED' &&
              error.message === 'text must be non-blank',
          );
          console.log('PR-6d search terms lowered: 0 (missing term rejected)');
        },
      );
    },
  );
});

test('forced-RLS relation, resolve, unique, and prefix predicates use their declared indexes', async () => {
  await withRealPartyRuntime('module-index-conformance', async (runtime) => {
    const targets = requiredTargets(runtime.storage);
    let priorRowCount = 0;
    const plannerFlipRows: Record<
      'prefix' | 'relation' | 'resolve' | 'unique',
      number | null
    > = {
      prefix: null,
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
      const resolveEvidence = await explainFoldedPredicate(
        runtime,
        targets,
        'resolve',
      );
      const uniqueEvidence = await explainFoldedPredicate(
        runtime,
        targets,
        'unique',
      );
      const prefixEvidence = await explainFoldedPredicate(
        runtime,
        targets,
        'prefix',
      );
      if (process.env.PR6B_DEBUG_EVIDENCE === '1') {
        console.log(
          `PR-6b/PR-6d evidence rows=${String(rowCount)} resolve=${formatFoldedEvidence(resolveEvidence)} unique=${formatFoldedEvidence(uniqueEvidence)} prefix=${formatFoldedEvidence(prefixEvidence)}`,
        );
      }
      const milestonePlans = {
        prefix: foldedEvidencePasses(
          prefixEvidence,
          foldedIndexRequirements(targets, 'prefix'),
        ),
        relation: planUsesIndex(
          await explainRelationPredicate(runtime, targets),
          [targets.relationIndex.physicalName],
        ),
        resolve: foldedEvidencePasses(
          resolveEvidence,
          foldedIndexRequirements(targets, 'resolve'),
        ),
        unique: foldedEvidencePasses(
          uniqueEvidence,
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
        `${predicate === 'prefix' ? 'PR-6d' : 'PR-6b'} ${predicate} planner flip rows=${String(rowCount)}; analyzed rows=${priorRowCount}`,
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
    assertFoldedIndexEvidence(
      await explainFoldedPredicate(runtime, targets, 'resolve'),
      'resolve',
      foldedIndexRequirements(targets, 'resolve'),
    );
    assertFoldedIndexEvidence(
      await explainFoldedPredicate(runtime, targets, 'unique'),
      'unique',
      foldedIndexRequirements(targets, 'unique'),
    );
    const legacyPrefix = await explainLegacyPrefixPredicate(runtime, targets);
    let prefixEvidence = await explainFoldedPredicate(
      runtime,
      targets,
      'prefix',
    );
    console.log(
      `PR-6d prefix measurement rows=${String(priorRowCount)} legacy_like_ms=${formatMilliseconds(actualTotalTime(legacyPrefix))} range_ms=${formatMilliseconds(actualTotalTime(prefixEvidence.root))}`,
    );
    const legacySubstring = await explainLegacyLikePredicate(
      runtime,
      targets,
      'substring',
    );
    const literalSubstring = await explainFoldedPredicate(
      runtime,
      targets,
      'substring',
    );
    assertSubstringBoundedEvidence(legacySubstring, targets);
    assertSubstringBoundedEvidence(literalSubstring, targets);
    assert.deepEqual(
      observedPlanShape(literalSubstring.root),
      observedPlanShape(legacySubstring.root),
      'literal escaping changed the tenant-bounded substring plan shape',
    );
    console.log(
      `PR-6d substring bounded rows=${String(priorRowCount)} removed_by_filter=${String(inspectPlan(literalSubstring.root).totalRowsRemovedByFilter)} tenant_index_deltas=${[targets.party.primaryKey.physicalName, ...targets.numberUniqueIndexNames].map((indexName) => `${indexName}:${String(literalSubstring.indexScanDeltas.get(indexName) ?? 'missing')}`).join(',')}`,
    );
    if (demonstrateMissingPrefixIndex === 'prefix') {
      await runtime.adminPool.query(
        `DROP INDEX north_star_module.${quoted(targets.nameFoldedIndex.physicalName)}`,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.party.physicalTableName)}`,
      );
      prefixEvidence = await explainFoldedPredicate(runtime, targets, 'prefix');
    }
    assertFoldedIndexEvidence(
      prefixEvidence,
      'prefix',
      foldedIndexRequirements(targets, 'prefix'),
    );
    await assertGeneratedFoldCatalog(runtime.adminPool, targets);
    if (demonstrateFoldConformance === 'row-drift') {
      await installIdentityFoldFunction(runtime.adminPool);
    }
    await assertGeneratedFoldRows(
      runtime.runtimePool,
      demonstrateFoldConformance === 'zero-visible-rows'
        ? runtime.contexts.b
        : runtime.contexts.a,
      targets,
      demonstrateFoldConformance === 'subject-absent' ? [] : undefined,
    );
  });
});

interface PlanNode {
  readonly 'Index Name'?: unknown;
  readonly 'Node Type'?: unknown;
  readonly Plans?: unknown;
  readonly 'Rows Removed by Filter'?: unknown;
  readonly [key: string]: unknown;
}

interface FoldedIndexRequirement {
  readonly indexNames: readonly string[];
}

interface FoldedIndexEvidence {
  readonly indexScanDeltas: ReadonlyMap<string, bigint | null>;
  readonly root: PlanNode;
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
  predicate: 'prefix' | 'resolve' | 'unique',
): readonly FoldedIndexRequirement[] {
  const name = {
    indexNames: [targets.nameFoldedIndex.physicalName],
  };
  const number = {
    indexNames: targets.numberUniqueIndexNames,
  };
  return predicate === 'prefix'
    ? [number, name]
    : predicate === 'resolve'
      ? [name]
      : [number];
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

async function insertSearchRows(
  pool: Pool,
  targets: RelationTargets,
  rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly number: string;
  }[],
): Promise<void> {
  await pool.query(
    `INSERT INTO north_star_module.${quoted(targets.party.physicalTableName)} (
       tenant_id, environment_id, record_id,
       ${quoted(targets.numberColumn.physicalName)},
       ${quoted(targets.nameColumn.physicalName)}
     )
     SELECT $1::uuid, $2::uuid, input.record_id::uuid, input.number, input.name
       FROM jsonb_to_recordset($3::jsonb)
         AS input(record_id text, number text, name text)`,
    [
      PARTY_TEST_SCOPE.a.tenantId,
      PARTY_TEST_SCOPE.a.environmentId,
      JSON.stringify(
        rows.map((row) => ({
          name: row.name,
          number: row.number,
          record_id: row.id,
        })),
      ),
    ],
  );
}

async function legacyUnescapedSubstring(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
  text: string,
): Promise<
  readonly {
    readonly archived: boolean;
    readonly entityId: string;
    readonly recordId: string;
    readonly revision: number;
    readonly values: Readonly<Record<string, unknown>>;
  }[]
> {
  const selectedColumns = [
    targets.party.recordIdentity.column,
    targets.party.optimisticRevision.column,
    targets.party.archive.archivedAtColumn,
    ...targets.party.columns.map((column) => column.physicalName),
  ];
  const foldedParameter =
    'north_star_module.nsm_unicode_case_fold_v1($1::text)';
  const legacyPredicate = [targets.numberFoldedColumn, targets.nameFoldedColumn]
    .map(
      (column) =>
        `${quoted(column.physicalName)} LIKE ('%' || ${foldedParameter} || '%')`,
    )
    .join(' OR ');
  return withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        const result = await client.query(
          `SELECT ${selectedColumns.map(quoted).join(', ')}
             FROM north_star_module.${quoted(targets.party.physicalTableName)}
            WHERE (${legacyPredicate})
              AND ${quoted(targets.party.archive.archivedAtColumn)} IS NULL
            ORDER BY ${quoted(targets.party.recordIdentity.column)}
            LIMIT 100`,
          [text],
        );
        return result.rows.map((row) => ({
          archived: row[targets.party.archive.archivedAtColumn] !== null,
          entityId: targets.party.entityId,
          recordId: String(row[targets.party.recordIdentity.column]),
          revision: Number(row[targets.party.optimisticRevision.column]),
          values: Object.fromEntries(
            targets.party.columns.map((column) => [
              column.canonicalFieldId,
              row[column.physicalName],
            ]),
          ),
        }));
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
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
  predicate: 'prefix' | 'resolve' | 'substring' | 'unique',
): Promise<FoldedIndexEvidence> {
  const columns =
    predicate === 'resolve'
      ? [targets.nameColumn]
      : predicate === 'unique'
        ? [targets.numberColumn]
        : [targets.numberColumn, targets.nameColumn];
  const match = buildFoldedMatchPredicate(
    targets.party,
    columns,
    predicate === 'unique'
      ? 'PARTY-00000007'
      : predicate === 'prefix'
        ? 'Ordinary party 7000'
        : predicate === 'substring'
          ? 'party 9999'
          : 'Ordinary party 7',
    predicate === 'prefix'
      ? 'prefix'
      : predicate === 'substring'
        ? 'substring'
        : 'exact',
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
  const expectedIndexNames =
    predicate === 'substring'
      ? [
          targets.party.primaryKey.physicalName,
          targets.nameFoldedIndex.physicalName,
          ...targets.numberUniqueIndexNames,
        ]
      : foldedIndexRequirements(targets, predicate).flatMap(
          (requirement) => requirement.indexNames,
        );
  const before = await readIndexScanCounters(
    runtime.adminPool,
    expectedIndexNames,
  );
  const root = await withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        const root = await explain(
          client,
          `SELECT ${selectedColumns.map(quoted).join(', ')}
             FROM north_star_module.${quoted(targets.party.physicalTableName)}
            WHERE ${match.sql}
              AND ${quoted(targets.party.archive.archivedAtColumn)} IS NULL
            ORDER BY ${quoted(targets.party.recordIdentity.column)}
            LIMIT $${String(values.length)}`,
          values,
        );
        await client.query('SELECT pg_stat_force_next_flush()');
        return root;
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  const after = await readIndexScanCounters(
    runtime.adminPool,
    expectedIndexNames,
  );
  return {
    indexScanDeltas: new Map(
      expectedIndexNames.map((indexName) => {
        const beforeCount = before.get(indexName);
        const afterCount = after.get(indexName);
        return [
          indexName,
          beforeCount === undefined || afterCount === undefined
            ? null
            : afterCount - beforeCount,
        ] as const;
      }),
    ),
    root,
  };
}

async function explainLegacyPrefixPredicate(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
): Promise<PlanNode> {
  return (await explainLegacyLikePredicate(runtime, targets, 'prefix')).root;
}

async function explainLegacyLikePredicate(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
  mode: 'prefix' | 'substring',
): Promise<FoldedIndexEvidence> {
  const selectedColumns = [
    targets.party.recordIdentity.column,
    targets.party.optimisticRevision.column,
    targets.party.archive.archivedAtColumn,
    ...targets.party.columns.map((column) => column.physicalName),
  ];
  const foldedParameter =
    'north_star_module.nsm_unicode_case_fold_v1($1::text)';
  const legacyPredicate = [targets.numberFoldedColumn, targets.nameFoldedColumn]
    .map((column) =>
      mode === 'prefix'
        ? `${quoted(column.physicalName)} LIKE (${foldedParameter} || '%')`
        : `${quoted(column.physicalName)} LIKE ('%' || ${foldedParameter} || '%')`,
    )
    .join(' OR ');
  const expectedIndexNames = [
    targets.party.primaryKey.physicalName,
    targets.nameFoldedIndex.physicalName,
    ...targets.numberUniqueIndexNames,
  ];
  const before = await readIndexScanCounters(
    runtime.adminPool,
    expectedIndexNames,
  );
  const root = await withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        const root = await explain(
          client,
          `SELECT ${selectedColumns.map(quoted).join(', ')}
             FROM north_star_module.${quoted(targets.party.physicalTableName)}
            WHERE (${legacyPredicate})
              AND ${quoted(targets.party.archive.archivedAtColumn)} IS NULL
            ORDER BY ${quoted(targets.party.recordIdentity.column)}
            LIMIT $2`,
          [mode === 'prefix' ? 'Ordinary party 7000' : 'party 9999', 100],
        );
        await client.query('SELECT pg_stat_force_next_flush()');
        return root;
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  const after = await readIndexScanCounters(
    runtime.adminPool,
    expectedIndexNames,
  );
  return {
    indexScanDeltas: new Map(
      expectedIndexNames.map((indexName) => {
        const beforeCount = before.get(indexName);
        const afterCount = after.get(indexName);
        return [
          indexName,
          beforeCount === undefined || afterCount === undefined
            ? null
            : afterCount - beforeCount,
        ] as const;
      }),
    ),
    root,
  };
}

async function readIndexScanCounters(
  pool: Pool,
  indexNames: readonly string[],
): Promise<ReadonlyMap<string, bigint>> {
  const result = await pool.query<{
    index_name: string;
    scan_count: string;
  }>(
    `SELECT indexrelname AS index_name, idx_scan::text AS scan_count
       FROM pg_stat_user_indexes
      WHERE schemaname = 'north_star_module'
        AND indexrelname = ANY($1::text[])`,
    [indexNames],
  );
  return new Map(
    result.rows.map((row) => [row.index_name, BigInt(row.scan_count)] as const),
  );
}

async function assertGeneratedFoldCatalog(
  pool: Pool,
  targets: RelationTargets,
): Promise<void> {
  for (const subject of requireFoldSubjects(foldedSubjects(targets))) {
    const catalog = await pool.query<{
      collation_name: string | null;
      expression: string | null;
      generated_kind: string;
    }>(
      `SELECT attribute.attgenerated AS generated_kind,
              collation_record.collname AS collation_name,
              pg_get_expr(definition.adbin, definition.adrelid, true) AS expression
         FROM pg_attribute AS attribute
         JOIN pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_attrdef AS definition
           ON definition.adrelid = attribute.attrelid
          AND definition.adnum = attribute.attnum
         LEFT JOIN pg_collation AS collation_record
           ON collation_record.oid = attribute.attcollation
        WHERE namespace.nspname = 'north_star_module'
          AND relation.relname = $1
          AND attribute.attname = $2
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped`,
      [subject.expectation.tableName, subject.expectation.columnName],
    );
    assert.equal(
      catalog.rows.length,
      1,
      `fold catalog conformance missing ${subject.expectation.tableName}.${subject.expectation.columnName}`,
    );
    const observed = catalog.rows[0]!;
    assert.equal(
      observed.generated_kind,
      's',
      `fold column is not GENERATED ALWAYS AS STORED: ${subject.expectation.tableName}.${subject.expectation.columnName}`,
    );
    assert.equal(
      observed.collation_name,
      'C',
      `fold column lost C collation: ${subject.expectation.tableName}.${subject.expectation.columnName}`,
    );
    assert.equal(
      normalizeCatalogExpression(observed.expression),
      normalizeCatalogExpression(subject.expectation.expression),
      `fold generation expression changed: ${subject.expectation.tableName}.${subject.expectation.columnName}`,
    );
  }
}

async function installIdentityFoldFunction(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE OR REPLACE FUNCTION north_star_module.nsm_unicode_case_fold_v1(value text)
       RETURNS text
       LANGUAGE sql
       IMMUTABLE STRICT PARALLEL SAFE
       SET search_path = pg_catalog
       AS $case_fold$ SELECT value $case_fold$`,
  );
}

interface FoldCatalogExpectation {
  readonly columnName: string;
  readonly expression: string;
  readonly tableName: string;
}

interface FoldSubject {
  readonly expectation: FoldCatalogExpectation;
  readonly foldedColumn: StorageTargetPayloadV1['entities'][number]['foldedColumns'][number];
}

interface FoldRowEvidence {
  readonly mismatches: string;
  readonly observedRows: string;
}

function foldedSubjects(targets: RelationTargets): readonly FoldSubject[] {
  return [targets.party, targets.role].flatMap((entity) =>
    entity.foldedColumns.map((foldedColumn) => {
      const source = entity.columns.find(
        (column) => column.physicalName === foldedColumn.sourceColumn,
      );
      assert.ok(
        source,
        `folded column ${foldedColumn.physicalName} lacks its declared source`,
      );
      return {
        expectation: {
          columnName: foldedColumn.physicalName,
          expression: `${foldedColumn.foldFunction}(${foldedColumn.sourceColumn}${source.postgresqlType === 'text' ? '' : '::text'})`,
          tableName: entity.physicalTableName,
        },
        foldedColumn,
      };
    }),
  );
}

function requireFoldSubjects(
  subjects: readonly FoldSubject[],
): readonly FoldSubject[] {
  assert.ok(
    subjects.length > 0,
    'fold row conformance observed zero folded columns',
  );
  return subjects;
}

async function assertGeneratedFoldRows(
  pool: Pool,
  context: TrustedRequestContext,
  targets: RelationTargets,
  subjectOverride?: readonly FoldSubject[],
): Promise<void> {
  const subjects = requireFoldSubjects(
    subjectOverride ?? foldedSubjects(targets),
  );
  const evidence = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        const results: Array<{
          evidence: FoldRowEvidence;
          subject: string;
        }> = [];
        for (const subject of subjects) {
          const result = await client.query<{
            mismatches: string;
            observed_rows: string;
          }>(
            `SELECT count(*)::text AS observed_rows,
                    count(*) FILTER (
                      WHERE ${quoted(subject.foldedColumn.physicalName)} IS DISTINCT FROM
                            north_star_module.nsm_unicode_case_fold_v1(${quoted(subject.foldedColumn.sourceColumn)}::text)
                    )::text AS mismatches
               FROM north_star_module.${quoted(subject.expectation.tableName)}`,
          );
          assert.equal(
            result.rows.length,
            1,
            `fold row conformance returned no aggregate for ${subject.expectation.tableName}.${subject.expectation.columnName}`,
          );
          results.push({
            evidence: {
              mismatches: result.rows[0]!.mismatches,
              observedRows: result.rows[0]!.observed_rows,
            },
            subject: `${subject.expectation.tableName}.${subject.expectation.columnName}`,
          });
        }
        return results;
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  for (const observed of evidence) {
    assertFoldRowEvidence(observed.evidence, observed.subject);
  }
}

function assertFoldRowEvidence(
  evidence: FoldRowEvidence,
  subject: string,
): void {
  assert.match(
    evidence.observedRows,
    /^(?:0|[1-9][0-9]*)$/,
    `fold row conformance returned an invalid row count for ${subject}`,
  );
  assert.match(
    evidence.mismatches,
    /^(?:0|[1-9][0-9]*)$/,
    `fold row conformance returned an invalid mismatch count for ${subject}`,
  );
  assert.notEqual(
    evidence.observedRows,
    '0',
    `fold row conformance observed zero visible rows for ${subject}`,
  );
  assert.equal(
    evidence.mismatches,
    '0',
    `fold row conformance observed generated-value drift for ${subject}`,
  );
}

function normalizeCatalogExpression(value: string | null): string | null {
  return value === null
    ? null
    : value.trim().replace(/\s+/g, ' ').replaceAll('"', '');
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

function inspectPlan(root: PlanNode): {
  indexNames: Set<string>;
  sequentialScan: boolean;
  totalRowsRemovedByFilter: number;
} {
  const indexNames = new Set<string>();
  let sequentialScan = false;
  let totalRowsRemovedByFilter = 0;
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
    totalRowsRemovedByFilter += rowsRemovedByFilter ?? 0;
    if (nodeType === 'Seq Scan') sequentialScan = true;
    if (node['Index Name'] !== undefined) {
      if (typeof node['Index Name'] !== 'string') {
        throw new Error(
          `unrecognized EXPLAIN index name: ${String(node['Index Name'])}`,
        );
      }
      indexNames.add(node['Index Name']);
    }
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans) || !node.Plans.every(isRecord)) {
        throw new Error('unrecognized EXPLAIN child plan collection');
      }
      for (const child of node.Plans) visit(child);
    }
  };
  visit(root);
  return { indexNames, sequentialScan, totalRowsRemovedByFilter };
}

function observedPlanShape(root: PlanNode): unknown {
  inspectPlan(root);
  const shape = (node: PlanNode): unknown => ({
    indexName:
      typeof node['Index Name'] === 'string' ? node['Index Name'] : null,
    nodeType: node['Node Type'],
    plans: Array.isArray(node.Plans)
      ? node.Plans.map((child) => shape(child as PlanNode))
      : [],
  });
  return shape(root);
}

function planUsesIndex(
  root: PlanNode,
  expectedIndexNames: readonly string[],
): boolean {
  const plan = inspectPlan(root);
  return expectedIndexNames.some((name) => plan.indexNames.has(name));
}

function foldedEvidencePasses(
  evidence: FoldedIndexEvidence,
  requirements: readonly FoldedIndexRequirement[],
): boolean {
  const plan = inspectPlan(evidence.root);
  return (
    plan.totalRowsRemovedByFilter === 0 &&
    requirements.every((requirement) =>
      requirement.indexNames.some(
        (indexName) => (evidence.indexScanDeltas.get(indexName) ?? 0n) >= 1n,
      ),
    )
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

function assertFoldedIndexEvidence(
  evidence: FoldedIndexEvidence,
  predicate: 'prefix' | 'resolve' | 'unique',
  requirements: readonly FoldedIndexRequirement[],
): void {
  const plan = inspectPlan(evidence.root);
  const expectedIndexNames = requirements.flatMap(
    (requirement) => requirement.indexNames,
  );
  assert.equal(
    plan.totalRowsRemovedByFilter,
    0,
    `${predicate} predicate removed ${String(plan.totalRowsRemovedByFilter)} rows by post-filter across the plan tree while expecting index ${expectedIndexNames.join(' or ')}`,
  );
  for (const requirement of requirements) {
    const usedExpected = requirement.indexNames.filter(
      (indexName) => (evidence.indexScanDeltas.get(indexName) ?? 0n) >= 1n,
    );
    assert.ok(
      usedExpected.length > 0,
      `${predicate} predicate did not increment expected index usage counter ${requirement.indexNames.join(' or ')}; deltas ${requirement.indexNames
        .map(
          (indexName) =>
            `${indexName}=${String(evidence.indexScanDeltas.get(indexName) ?? 'missing')}`,
        )
        .join(', ')}`,
    );
  }
}

function assertSubstringBoundedEvidence(
  evidence: FoldedIndexEvidence,
  targets: RelationTargets,
): void {
  const plan = inspectPlan(evidence.root);
  const tenantBoundingIndexes = [
    targets.party.primaryKey.physicalName,
    ...targets.numberUniqueIndexNames,
  ];
  assert.equal(
    plan.sequentialScan,
    false,
    'substring predicate escaped the tenant/environment index bound',
  );
  const selectedTenantIndexes = tenantBoundingIndexes.filter((indexName) =>
    plan.indexNames.has(indexName),
  );
  assert.equal(
    selectedTenantIndexes.length,
    1,
    `substring predicate did not use exactly one tenant-bounding index ${tenantBoundingIndexes.join(' or ')}; used ${[...plan.indexNames].join(', ') || 'none'}`,
  );
  assert.deepEqual(
    [...plan.indexNames].toSorted(),
    selectedTenantIndexes.toSorted(),
    'substring predicate used an index outside the approved tenant bounds',
  );
  for (const indexName of tenantBoundingIndexes) {
    const delta = evidence.indexScanDeltas.get(indexName);
    assert.equal(
      typeof delta,
      'bigint',
      `substring predicate omitted scan-counter evidence for tenant-bounding index ${indexName}`,
    );
    const expected = selectedTenantIndexes.includes(indexName) ? 1n : 0n;
    assert.equal(
      delta,
      expected,
      `${indexName} incremented ${String(delta)} times; expected ${String(expected)}`,
    );
  }
  assert.ok(
    plan.totalRowsRemovedByFilter > 0,
    'substring predicate did not observe its expected bounded post-filter',
  );
  assert.equal(
    evidence.indexScanDeltas.get(targets.nameFoldedIndex.physicalName) ?? 0n,
    0n,
    `unanchored substring unexpectedly used folded search index ${targets.nameFoldedIndex.physicalName}`,
  );
}

function actualTotalTime(root: PlanNode): number {
  const value = root['Actual Total Time'];
  if (typeof value !== 'number') {
    assert.fail('EXPLAIN omitted Actual Total Time');
  }
  assert.ok(Number.isFinite(value) && value >= 0, 'EXPLAIN time is invalid');
  return value;
}

function formatMilliseconds(value: number): string {
  return value.toFixed(3);
}

function formatFoldedEvidence(evidence: FoldedIndexEvidence): string {
  const plan = inspectPlan(evidence.root);
  return `filters=${String(plan.totalRowsRemovedByFilter)},deltas=${[
    ...evidence.indexScanDeltas,
  ]
    .map(([indexName, delta]) => `${indexName}:${String(delta)}`)
    .join('|')}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/);
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
