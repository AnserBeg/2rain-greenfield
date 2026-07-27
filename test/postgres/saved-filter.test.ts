import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import {
  PLATFORM_IDS,
  platformModuleDefinition,
} from '../../packages/domain/src/platform/index.js';
import {
  SAVED_FILTER_LIMITS,
  SavedFilterContractError,
} from '../../packages/platform-runtime/src/saved-filter-contracts.js';
import * as savedFilterProvider from '../../packages/postgres-provider/src/saved-filter-executor.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import { compilePlatformFixture } from '../fixtures/g2/saved-filter/compiler.js';
import {
  NUMERIC_SORT_FIELD_ID,
  numericPartyModuleDefinition,
} from '../fixtures/g2/saved-filter/numeric-party-definition.js';
import {
  SAVED_FILTER_TEST_SCOPE,
  invokeSavedFilterOperation,
  invokeSavedFilterQuery,
  withSavedFilterRuntime,
} from '../fixtures/g2/saved-filter/runtime-harness.js';

const numericRecords = [
  ['e1100000-0000-4000-8000-000000000001', '9'],
  ['e1100000-0000-4000-8000-000000000002', '10'],
  ['e1100000-0000-4000-8000-000000000003', '-3'],
  ['e1100000-0000-4000-8000-000000000004', '-10'],
] as const;

test('numeric List sorting uses physical numeric order rather than display text', async () => {
  await withRealPartyRuntime(
    'g2-p5b-numeric-sort',
    async (runtime) => {
      for (const [
        index,
        [recordId, numericValue],
      ] of numericRecords.entries()) {
        await invokePartyOperation(runtime, runtime.views.a, 'party_create', {
          recordId,
          values: {
            [NUMERIC_SORT_FIELD_ID]: numericValue,
            [PARTY_IDS.fieldIds.name]: `Numeric ${String(index + 1)}`,
            [PARTY_IDS.fieldIds.number]: `N-${String(index + 1)}`,
          },
        });
      }

      const entity = runtime.storage.entities.find(
        (candidate) => candidate.entityId === PARTY_IDS.entityIds.party,
      );
      const column = entity?.columns.find(
        (candidate) => candidate.canonicalFieldId === NUMERIC_SORT_FIELD_ID,
      );
      assert.ok(entity);
      assert.ok(column);
      const legacy = await runtime.adminPool.query<{ value: string }>(
        `SELECT "${column.physicalName}"::text AS value
           FROM north_star_module."${entity.physicalTableName}"
          WHERE tenant_id = $1 AND environment_id = $2
          ORDER BY "${column.physicalName}"::text ASC`,
        [runtime.contexts.a.tenantId, runtime.contexts.a.environmentId],
      );
      const expected = ['-10', '-3', '9', '10'];
      assert.deepEqual(
        legacy.rows.map((row) => row.value),
        ['-10', '-3', '10', '9'],
      );
      assert.throws(() =>
        assert.deepEqual(
          legacy.rows.map((row) => row.value),
          expected,
        ),
      );

      const result = await invokePartyQuery(
        runtime,
        runtime.views.a,
        'party_list',
        listArguments(NUMERIC_SORT_FIELD_ID),
      );
      assert.deepEqual(
        result.records.map((record) => record.values[NUMERIC_SORT_FIELD_ID]),
        expected,
      );
    },
    numericPartyModuleDefinition(),
  );
});

test('saved filters round-trip canonical predicates through registered gateways and fail closed', async () => {
  const factory = compilePlatformFixture();
  assert.equal(factory.compiled.bundle.releaseManifest.projections.length, 9);
  assert.deepEqual(Object.keys(savedFilterProvider), [
    'PostgresSavedFilterExecutor',
  ]);
  assert.equal(
    Object.keys(platformModuleDefinition()).includes('savedFilterLanguage'),
    false,
    'criteria remain tenant data rather than a new canonical family',
  );

  await withSavedFilterRuntime('g2-p5b-saved-filter', async (runtime) => {
    const targetQueryId = PLATFORM_IDS.queryIds.list;
    const filterId = 'f1100000-0000-4000-8000-000000000001';
    const criteria = canonicalize(fieldPredicate(PLATFORM_IDS.fieldIds.name));

    await assert.rejects(
      runtime.runtimePool.query(
        `INSERT INTO platform.saved_master_filters (
           tenant_id, environment_id, owner_principal_id, filter_id, name,
           query_id, criteria_canonical_json, language_version,
           normalization_profile_version, position_profile_version,
           authored_release_id, authored_release_content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          SAVED_FILTER_TEST_SCOPE.a.tenantId,
          SAVED_FILTER_TEST_SCOPE.a.environmentId,
          SAVED_FILTER_TEST_SCOPE.a.principalId,
          'f1100000-0000-4000-8000-000000000009',
          'Direct write',
          targetQueryId,
          criteria,
          'v2',
          'northstar.normalization/v2',
          'northstar.predicate-position.saved-filter/v1',
          runtime.views.a.release.releaseId,
          runtime.views.a.release.contentHash,
        ],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, '42501');
        assert.match(String((error as Error).message), /row-level security/i);
        return true;
      },
    );

    const empty = await invokeSavedFilterQuery(
      runtime,
      runtime.views.a,
      'list',
      { queryId: targetQueryId },
    );
    assert.equal(empty.outcome, 'exact');
    assert.equal(empty.records.length, 0, 'saved-filter rows read: 0');

    const unsupportedSearch = await invokeSavedFilterQuery(
      runtime,
      runtime.views.a,
      'search',
      { matchMode: 'substring', text: 'mine' },
    );
    assert.equal(unsupportedSearch.outcome, 'unsupported');
    assert.equal(
      unsupportedSearch.unsupportedReason,
      'saved-filter-query-unsupported',
    );

    const created = await invokeSavedFilterOperation(
      runtime,
      runtime.views.a,
      'create',
      createInput(filterId, targetQueryId, criteria),
    );
    assert.equal(created.outcome, 'succeeded');
    assert.ok(created.trust);
    assert.equal(
      created.readBack?.values[PLATFORM_IDS.fieldIds.criteria],
      criteria,
    );

    const reread = await invokeSavedFilterQuery(
      runtime,
      runtime.views.a,
      'get',
      { filterId },
    );
    assert.equal(reread.records.length, 1);
    assert.equal(
      reread.records[0]?.values[PLATFORM_IDS.fieldIds.criteria],
      criteria,
      'criteria bytes round-trip unchanged',
    );
    const persisted = await runtime.adminPool.query<{
      authored_release_content_hash: string;
      authored_release_id: string;
      environment_id: string;
      language_version: string;
      normalization_profile_version: string;
      owner_principal_id: string;
      position_profile_version: string;
      tenant_id: string;
    }>(
      `SELECT tenant_id, environment_id, owner_principal_id,
              authored_release_id, authored_release_content_hash,
              language_version, normalization_profile_version,
              position_profile_version
         FROM platform.saved_master_filters
        WHERE filter_id = $1`,
      [filterId],
    );
    assert.deepEqual(persisted.rows[0], {
      authored_release_content_hash: runtime.views.a.release.contentHash,
      authored_release_id: runtime.views.a.release.releaseId,
      environment_id: SAVED_FILTER_TEST_SCOPE.a.environmentId,
      language_version: 'v2',
      normalization_profile_version: 'northstar.normalization/v2',
      owner_principal_id: SAVED_FILTER_TEST_SCOPE.a.principalId,
      position_profile_version: 'northstar.predicate-position.saved-filter/v1',
      tenant_id: SAVED_FILTER_TEST_SCOPE.a.tenantId,
    });
    const audit = await runtime.adminPool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM platform.trust_action_invocations
        WHERE action_id = $1 AND outcome = 'SUCCEEDED'`,
      [PLATFORM_IDS.operationIds.create],
    );
    assert.equal(audit.rows[0]?.count, '1');

    const updated = await invokeSavedFilterOperation(
      runtime,
      runtime.views.a,
      'update',
      {
        expectedRevision: 1,
        patch: { [PLATFORM_IDS.fieldIds.name]: 'Renamed saved filter' },
        recordId: filterId,
      },
    );
    assert.equal(
      updated.readBack?.values[PLATFORM_IDS.fieldIds.name],
      'Renamed saved filter',
    );
    assert.equal(updated.readBack?.revision, 2);
    const listed = await invokeSavedFilterQuery(
      runtime,
      runtime.views.a,
      'list',
      { queryId: targetQueryId },
    );
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0]?.recordId, filterId);
    assert.equal(
      listed.records[0]?.values[PLATFORM_IDS.fieldIds.criteria],
      criteria,
    );

    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, runtime.views.alternatePrincipal, 'get', {
        filterId,
      }),
      'SAVED_FILTER_NOT_VISIBLE',
      '$.arguments.filterId',
    );
    await assertSavedFilterError(
      invokeSavedFilterQuery(
        runtime,
        runtime.views.alternateEnvironment,
        'get',
        { filterId },
      ),
      'SAVED_FILTER_NOT_VISIBLE',
      '$.arguments.filterId',
    );
    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, runtime.views.b, 'get', { filterId }),
      'SAVED_FILTER_NOT_VISIBLE',
      '$.arguments.filterId',
    );

    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000002',
          targetQueryId,
          'x'.repeat(SAVED_FILTER_LIMITS.maximumBytes + 1),
        ),
      ),
      'SAVED_FILTER_CRITERIA_BYTES_EXCEEDED',
      '$.criteria',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000003',
          targetQueryId,
          canonicalize(deepPredicate(SAVED_FILTER_LIMITS.maximumDepth + 1)),
        ),
      ),
      'SAVED_FILTER_DEPTH_LIMIT_EXCEEDED',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000006',
          targetQueryId,
          canonicalize(manyNodePredicate(SAVED_FILTER_LIMITS.maximumNodes)),
        ),
      ),
      'SAVED_FILTER_NODE_LIMIT_EXCEEDED',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000007',
          targetQueryId,
          canonicalize(
            manyCollections(SAVED_FILTER_LIMITS.maximumCollections + 1),
          ),
        ),
      ),
      'SAVED_FILTER_COLLECTION_LIMIT_EXCEEDED',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000004',
          targetQueryId,
          canonicalize({
            kind: 'booleanPredicate',
            schemaVersion: 'v999',
            value: true,
          }),
        ),
      ),
      'SAVED_FILTER_NODE_VERSION_UNSUPPORTED',
      '$.criteria.schemaVersion',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000008',
          targetQueryId,
          canonicalize(
            fieldPredicateWithReferenceVersion(
              PLATFORM_IDS.fieldIds.name,
              'v999',
            ),
          ),
        ),
      ),
      'SAVED_FILTER_NODE_VERSION_UNSUPPORTED',
      '$.criteria.field.schemaVersion',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000010',
          targetQueryId,
          canonicalize(
            fieldPredicateWithValue(PLATFORM_IDS.fieldIds.name, {
              kind: 'booleanValue',
              schemaVersion: 'v2',
              value: true,
            }),
          ),
        ),
      ),
      'SAVED_FILTER_FIELD_INADMISSIBLE',
      '$.criteria.value',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000011',
          targetQueryId,
          canonicalize(nonCanonicalTermOrder()),
        ),
      ),
      'SAVED_FILTER_CRITERIA_NOT_CANONICAL',
      '$.criteria',
    );
    await assertSavedFilterError(
      invokeSavedFilterOperation(
        runtime,
        runtime.views.a,
        'create',
        createInput(
          'f1100000-0000-4000-8000-000000000005',
          PLATFORM_IDS.queryIds.get,
          criteria,
        ),
      ),
      'SAVED_FILTER_QUERY_INADMISSIBLE',
      '$.queryId',
    );

    const missingFieldCriteria = canonicalize(
      fieldPredicate('northstar.platform:field.removed_saved_filter_field'),
    );
    await runtime.adminPool.query(
      `UPDATE platform.saved_master_filters
          SET criteria_canonical_json = $2
        WHERE filter_id = $1`,
      [filterId, missingFieldCriteria],
    );
    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, runtime.views.a, 'get', { filterId }),
      'SAVED_FILTER_FIELD_STALE',
      '$.criteria.field.targetId',
    );

    const corruptCriteria = canonicalize({
      kind: 'unknownPredicate',
      schemaVersion: 'v2',
    });
    await runtime.adminPool.query(
      `UPDATE platform.saved_master_filters
          SET criteria_canonical_json = $2
        WHERE filter_id = $1`,
      [filterId, corruptCriteria],
    );
    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, runtime.views.a, 'get', { filterId }),
      'SAVED_FILTER_CRITERIA_CORRUPT',
    );
    await runtime.adminPool.query(
      `UPDATE platform.saved_master_filters
          SET criteria_canonical_json = $2
        WHERE filter_id = $1`,
      [filterId, criteria],
    );

    const archived = await invokeSavedFilterOperation(
      runtime,
      runtime.views.a,
      'archive',
      { expectedRevision: 2, recordId: filterId },
    );
    assert.equal(archived.readBack?.archived, true);
    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, runtime.views.a, 'get', { filterId }),
      'SAVED_FILTER_LIFECYCLE_REVOKED',
      '$.lifecycle',
    );
    await invokeSavedFilterOperation(runtime, runtime.views.a, 'restore', {
      expectedRevision: 3,
      recordId: filterId,
    });

    const supersedingView = await runtime.supersedeA();
    await assertSavedFilterError(
      invokeSavedFilterQuery(runtime, supersedingView, 'get', { filterId }),
      'SAVED_FILTER_RELEASE_MISMATCH',
      '$.authoredReleaseId',
    );

    const rows = await runtime.adminPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM platform.saved_master_filters',
    );
    assert.equal(rows.rows[0]?.count, '1');
  });
});

test('saved-filter List enforces its compiled maximum result count', async () => {
  await withSavedFilterRuntime(
    'g2-p5b-saved-filter-list-bound',
    async (runtime) => {
      const targetQueryId = PLATFORM_IDS.queryIds.list;
      const maximumResultCount = compiledQueryBound(
        runtime.views.a.projections.query.payload,
        PLATFORM_IDS.queryIds.list,
      );
      const criteria = canonicalize({
        kind: 'booleanPredicate',
        schemaVersion: 'v2',
        value: true,
      });

      for (let index = 1; index <= maximumResultCount + 1; index += 1) {
        const created = await invokeSavedFilterOperation(
          runtime,
          runtime.views.a,
          'create',
          createInput(boundedFilterId(index), targetQueryId, criteria),
        );
        assert.equal(created.outcome, 'succeeded');
      }

      const formerUnboundedResult = await runtime.adminPool.query<{
        filter_id: string;
      }>(
        `SELECT filter_id
         FROM platform.saved_master_filters
        WHERE tenant_id = $1
          AND environment_id = $2
          AND owner_principal_id = $3
          AND query_id = $4
        ORDER BY filter_id`,
        [
          SAVED_FILTER_TEST_SCOPE.a.tenantId,
          SAVED_FILTER_TEST_SCOPE.a.environmentId,
          SAVED_FILTER_TEST_SCOPE.a.principalId,
          targetQueryId,
        ],
      );
      assert.equal(formerUnboundedResult.rows.length, maximumResultCount + 1);
      assert.throws(() =>
        assert.ok(formerUnboundedResult.rows.length <= maximumResultCount),
      );

      const bounded = await invokeSavedFilterQuery(
        runtime,
        runtime.views.a,
        'list',
        { queryId: targetQueryId },
      );
      assert.equal(bounded.records.length, maximumResultCount);
      assert.equal(
        bounded.records.at(-1)?.recordId,
        boundedFilterId(maximumResultCount),
      );
      assert.equal(
        bounded.records.some(
          (record) =>
            record.recordId === boundedFilterId(maximumResultCount + 1),
        ),
        false,
      );
    },
  );
});

function compiledQueryBound(payload: unknown, queryId: string): number {
  assert.ok(isRecord(payload));
  assert.ok(Array.isArray(payload.queries));
  const definition = payload.queries.find(
    (candidate) => isRecord(candidate) && candidate.queryId === queryId,
  );
  assert.ok(definition);
  assert.equal(typeof definition.maximumResultCount, 'number');
  assert.ok(
    Number.isSafeInteger(definition.maximumResultCount) &&
      definition.maximumResultCount > 0,
  );
  return definition.maximumResultCount;
}

function boundedFilterId(index: number): string {
  return `f2200000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createInput(
  filterId: string,
  queryId: string,
  criteriaCanonicalJson: string,
): Record<string, unknown> {
  return {
    recordId: filterId,
    relations: {},
    values: {
      [PLATFORM_IDS.fieldIds.criteria]: criteriaCanonicalJson,
      [PLATFORM_IDS.fieldIds.name]: 'My saved filter',
      [PLATFORM_IDS.fieldIds.queryId]: queryId,
    },
  };
}

function fieldPredicate(fieldId: string): Record<string, unknown> {
  return {
    field: { kind: 'fieldReference', schemaVersion: 'v2', targetId: fieldId },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v2',
    value: { kind: 'textValue', schemaVersion: 'v2', value: 'Mine' },
  };
}

function fieldPredicateWithReferenceVersion(
  fieldId: string,
  referenceVersion: string,
): Record<string, unknown> {
  const predicate = fieldPredicate(fieldId);
  predicate.field = {
    kind: 'fieldReference',
    schemaVersion: referenceVersion,
    targetId: fieldId,
  };
  return predicate;
}

function fieldPredicateWithValue(
  fieldId: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return { ...fieldPredicate(fieldId), value };
}

function nonCanonicalTermOrder(): Record<string, unknown> {
  return {
    kind: 'anyPredicate',
    schemaVersion: 'v2',
    terms: [
      { kind: 'booleanPredicate', schemaVersion: 'v2', value: true },
      { kind: 'booleanPredicate', schemaVersion: 'v2', value: false },
    ],
  };
}

function deepPredicate(depth: number): Record<string, unknown> {
  let predicate: Record<string, unknown> = {
    kind: 'booleanPredicate',
    schemaVersion: 'v2',
    value: true,
  };
  for (let index = 1; index < depth; index += 1) {
    predicate = {
      kind: 'notPredicate',
      schemaVersion: 'v2',
      term: predicate,
    };
  }
  return predicate;
}

function manyNodePredicate(termCount: number): Record<string, unknown> {
  return {
    kind: 'anyPredicate',
    schemaVersion: 'v2',
    terms: Array.from({ length: termCount }, () => ({
      kind: 'booleanPredicate',
      schemaVersion: 'v2',
      value: true,
    })),
  };
}

function manyCollections(collectionCount: number): Record<string, unknown> {
  return Object.fromEntries([
    ['kind', 'booleanPredicate'],
    ['schemaVersion', 'v2'],
    ['value', true],
    ...Array.from({ length: collectionCount }, (_, index) => [
      `collection${String(index)}`,
      [],
    ]),
  ]);
}

async function assertSavedFilterError(
  promise: Promise<unknown>,
  code: SavedFilterContractError['code'],
  path?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SavedFilterContractError);
    assert.equal(error.code, code);
    if (path !== undefined) assert.equal(error.path, path);
    return true;
  });
}

function listArguments(sortFieldId: string): Record<string, unknown> {
  return {
    includeArchived: false,
    list: {
      cursor: null,
      matchMode: 'substring',
      pageSize: 100,
      relationLabels: [],
      schemaVersion: 'northstar.shared-list-query/v1',
      search: '',
      sort: [{ direction: 'ascending', fieldId: sortFieldId }],
    },
  };
}
