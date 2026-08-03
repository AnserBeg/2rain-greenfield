import assert from 'node:assert/strict';
import test from 'node:test';

import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  invokePartyOperation,
  invokePartyQuery,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';
import {
  NUMERIC_SORT_FIELD_ID,
  numericPartyModuleDefinition,
} from '../fixtures/g2/saved-filter/numeric-party-definition.js';
import { observeSavedFilterAdmissionRefusal } from '../fixtures/g2/saved-filter/runtime-harness.js';

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

test('saved-filter package fails closed when real verification reaches unsupported declared queries', async () => {
  const observed = await observeSavedFilterAdmissionRefusal(
    'g2-p5b-saved-filter-verification-refusal',
  );

  assert.ok(observed.scenarioKinds.includes('resolverAuthority'));
  assert.ok(observed.scenarioKinds.includes('searchableExclusion'));
  assert.equal(
    observed.searchWitnessCount,
    1,
    'saved-filter search returns the record created through its real operation path by matching name',
  );
  assert.equal(
    observed.executionErrorCode,
    'VERIFICATION_RESOLVER_POSITIVE_FAILED',
    observed.executionErrorMessage,
  );
  assert.equal(observed.evidenceCount, 0);
  assert.equal(observed.admissionErrorCode, 'VERIFICATION_EVIDENCE_NOT_FOUND');
  assert.equal(observed.admissionCount, 0);
});

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
